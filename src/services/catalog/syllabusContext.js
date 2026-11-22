import {
  array,
  integer,
  object,
  reviewedItems,
  runAcademicWorkflow,
  string,
} from "../rag/academicWorkflow.js";

const referenceHeading =
  /^(references(?:\s*(?:and|&)\s*supplementary\s+(?:readings|materials))?|bibliography)\s*:?$/i;
const referenceCategory =
  /^(?:(?:[a-z]|\d+)[.)]\s+)?(required\s+textbooks?(?:\s*\/\s*workbooks?)?|laboratory\s+manuals?|reference\s+books?|electronic\s+references?|modules?(?:\s*(?:\/|or|and|&)\s*supplementary\s+materials?)?|supplementary\s+materials?)\b\s*[:-]?\s*(.*)$/i;
const sectionEnd =
  /^(?:course coverage|course requirements|grading system|revision history|course policies|prepared by|approved by|reviewed by|effectivity date)\b/i;
const compact = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

export function extractAcademicSections(pages) {
  const references = [],
    course_outcomes = [];
  let section, category;
  for (const { page, lines } of pages) {
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (referenceHeading.test(text)) {
        section = "references";
        continue;
      }
      const outcomeHeading = text.match(/^course\s+(?:learning\s+)?outcomes?\s*(?::\s*(.*)|$)/i);
      if (outcomeHeading) {
        section = "outcomes";
        if (outcomeHeading[1]) course_outcomes.push(outcomeHeading[1]);
        continue;
      }
      if (sectionEnd.test(text)) {
        section = null;
        category = null;
        continue;
      }
      if (
        /^(?:page \d+|CvSU (?:Mission|Vision)|Cavite State University)\s*$/i.test(
          text,
        )
      )
        continue;
      if (section === "outcomes") course_outcomes.push(text);
      if (section !== "references") continue;
      const match = text.match(referenceCategory) || text.match(/^([\p{L}][\p{L} &/()-]{1,65}):\s*$/u);
      if (match) {
        category = { category: match[1], entries: [] };
        references.push(category);
      }
      const entry = match ? match[2] : text;
      if (!entry) continue;
      if (!category) {
        category = { category: "References", entries: [] };
        references.push(category);
      }
      category.entries.push({ text: entry, source_page: page });
    }
  }
  return { course_outcomes, references };
}

const moduleSchema = object({
  items: array(
    object({
      id: integer,
      topics: array(string),
      objectives: array(string),
      description: string,
    }),
  ),
});

const fieldSchema = object({
  items: array(object({ id: integer, entries: array(string) })),
});

// Verbatim fields use the positioned PDF text as their immutable source. A
// reviewer checks the association and order before they enter the saved version.
async function verifySyllabusFields(session, course, academic, pages) {
  const fields = [];
  const add = (label, values, source_pages) => {
    if (values.length)
      fields.push({ id: fields.length + 1, label, values, source_pages });
  };
  for (const [key, label] of [
    ["code", "Course code"],
    ["title", "Course title"],
    ["description", "Course description"],
  ]) {
    if (course[key]) add(label, [course[key]], [pages[0].page]);
  }
  if (academic.course_outcomes.length) {
    const lines = new Set(academic.course_outcomes);
    add(
      "Course outcomes",
      academic.course_outcomes,
      pages
        .filter((p) => p.lines.some((line) => lines.has(line) || /^course\s+(?:learning\s+)?outcomes?\s*:/i.test(line)))
        .map((p) => p.page),
    );
  }
  for (const group of academic.references) {
    add(
      group.category,
      group.entries.map((e) => e.text),
      [...new Set(group.entries.map((e) => e.source_page))],
    );
  }
  function evidence(fields) {
    const required = new Set(fields.flatMap((f) => f.source_pages));
    return { fields, source_pages: pages.filter((p) => required.has(p.page)) };
  }
  for (let offset = 0; offset < fields.length; offset += 8) {
    await reviewedItems(session, fields.slice(offset, offset + 8), {
      draft: (fields) => ({
        schema: fieldSchema,
        instruction:
          "Extract the entries for each numbered syllabus field from its supplied PDF lines. Keep original wording, order, URLs and N/A. Source line breaks may divide bibliographic entries. Use the supplied list to preserve its line boundaries. Never complete missing publication data.",
        data: evidence(fields),
      }),
      validate(row, field) {
        if (
          !Array.isArray(row.entries) ||
          row.entries.length !== field.values.length ||
          row.entries.some(
            (value, i) =>
              typeof value !== "string" ||
              compact(value) !== compact(field.values[i]),
          )
        )
          throw new Error(
            "Copy the entries verbatim in source order, preserving N/A and every URL.",
          );
        return field.values;
      },
      review: (items) => ({
        instruction:
          "Verify each proposed field independently against the supplied PDF lines. Check field or reference category, order, missing bibliographic details, and literal URLs and N/A. Reject any invention, but allow whitespace and line boundaries introduced by PDF extraction.",
        data: evidence(items),
      }),
      failureMessage:
        "Some syllabus fields or reference entries could not be verified against the PDF. Check the selectable text and try again.",
    });
  }
}

export async function enrichSyllabusModules(
  headings,
  course,
  academic,
  pages,
  options,
) {
  if (
    !headings.length &&
    !academic.references.length &&
    !academic.course_outcomes.length
  )
    return [];
  return runAcademicWorkflow("syllabus", options, async (session) => {
    await verifySyllabusFields(session, course, academic, pages);
    const modules = [];
    for (let start = 0; start < headings.length; start += 6) {
      const slots = headings
        .slice(start, start + 6)
        .map((row, i) => ({ ...row, id: start + i + 1 }));
      const checked = await reviewedItems(session, slots, {
        draft: (items) => ({
          schema: moduleSchema,
          instruction:
            "Extract the listed topics, subtopics and learning objectives for each numbered syllabus module. Copy terminology verbatim and preserve sequence. Keep all supplied enumerated topics exactly as listed. Only associate an objective present in that module's objective column or explicitly identified within its text. Return [] for missing items. Write a short contextual description that explains the scope and links supported topics and objectives. When there are only headings, describe expected coverage. Do not write a lesson or add topics, sources, or bibliographic details.",
          data: {
            course: { code: course.code, title: course.title },
            course_outcomes: academic.course_outcomes,
            modules: items,
          },
        }),
        validate(row, slot) {
          const evidence = compact(slot.source_lines.join(" "));
          const objectiveEvidence = compact(
            slot.objective_lines.join(" ") + " " + evidence,
          );
          if (
            !Array.isArray(row.topics) ||
            row.topics.length > 100 ||
            row.topics.some(
              (t) => typeof t !== "string" || !t.trim() || t.length > 500,
            )
          )
            throw new Error("Use verbatim topic labels only.");
          if (
            slot.topics.length &&
            JSON.stringify(slot.topics) !== JSON.stringify(row.topics)
          )
            throw new Error(
              "Copy every enumerated topic exactly, in the supplied order.",
            );
          let cursor = 0;
          for (const topic of row.topics) {
            const found = evidence.indexOf(compact(topic), cursor);
            if (found < 0)
              throw new Error("A topic is absent or out of source order.");
            cursor = found + compact(topic).length;
          }
          if (
            !Array.isArray(row.objectives) ||
            row.objectives.some(
              (o) =>
                typeof o !== "string" ||
                !o.trim() ||
                !objectiveEvidence.includes(compact(o)),
            ) ||
            row.objectives.join("\n").length > 15000
          )
            throw new Error(
              "Quote only the objectives associated with this module.",
            );
          if (
            typeof row.description !== "string" ||
            !row.description.trim() ||
            row.description.length > 2500
          )
            throw new Error("Supply a concise topic-based contextual summary.");
          return {
            title: slot.title,
            source_page: slot.source_page,
            topics: row.topics,
            ...(slot.syllabus_description
              ? { syllabus_description: slot.syllabus_description }
              : {}),
            learning_objectives: row.objectives.join("\n"),
            description: row.description.trim(),
            context_kind: "topic_based_summary",
            syllabus_module_index: slot.id - 1,
          };
        },
        review: (items) => ({
          instruction:
            "Independently compare each proposed syllabus extraction with its original module text and objective column. Reject omitted topics, wrong ordering, misplaced or invented objectives, and summaries claiming unsupported details. Empty fields are correct when absent. Treat the description as a generated scope summary.",
          data: { items },
        }),
        failureMessage:
          "Some syllabus topics or objectives could not be verified against the PDF. Check the Course Coverage section and retry extraction.",
      });
      modules.push(...checked);
    }
    return modules;
  });
}
