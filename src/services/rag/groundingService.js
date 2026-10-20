import { buildEvidence } from "./evidenceService.js";
import { generateJson } from "../geminiService.js";

export const stringSchema = { type: "STRING" };
export const citationSchema = {
  type: "OBJECT",
  properties: { chunk_id: stringSchema, quote: stringSchema },
  required: ["chunk_id", "quote"],
};
export const normalizeEvidence = (text) =>
  String(text).replace(/\s+/g, " ").trim();

export function validateCitation(citation, chunks) {
  const chunk = chunks.find(
    (c) => String(c.chunk_id) === String(citation.chunk_id),
  );
  const quote = normalizeEvidence(citation.quote);
  if (
    !chunk ||
    quote.length < 12 ||
    !normalizeEvidence(chunk.chunk_text).includes(quote)
  ) {
    throw new Error(
      "Citation must quote an existing supplied chunk exactly (ignoring whitespace).",
    );
  }
  return {
    chunk_id: String(chunk.chunk_id),
    quote,
    source_position: chunk.source_position,
    source_start: chunk.source_start,
    source_end: chunk.source_end,
    document_id: chunk.document_id,
    filename: chunk.source_filename,
  };
}

const pageSchema = {
  type: "OBJECT",
  properties: {
    title: stringSchema,
    statements: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: stringSchema,
          point_ids: { type: "ARRAY", items: stringSchema },
          evidence_ids: { type: "ARRAY", items: stringSchema },
        },
        required: ["text", "point_ids", "evidence_ids"],
      },
    },
  },
  required: ["title", "statements"],
};

// Models select passage IDs; only the server copies quotes from supplied chunks.
export function attachPageEvidence(draft, topic, context) {
  const evidence = new Map(
    buildEvidence(context).map((passage) => [passage.evidence_id, passage]),
  );
  if (!Array.isArray(draft?.statements))
    throw new Error("Invalid page structure.");
  return {
    ...draft,
    statements: draft.statements.map((statement, index) => {
      if (
        !Array.isArray(statement.evidence_ids) ||
        !statement.evidence_ids.length
      )
        throw new Error(`Statement ${index} needs evidence IDs.`);
      const citations = statement.evidence_ids.map((id) => {
        const passage = evidence.get(id);
        if (!passage)
          throw new Error(
            `Statement ${index} selected unknown evidence: ${id}`,
          );
        return validateCitation(passage, context);
      });
      return {
        text: statement.text,
        point_ids: statement.point_ids,
        citations,
      };
    }),
  };
}

export function validatePage(page, topic, context) {
  if (
    typeof page.title !== "string" ||
    !page.title.trim() ||
    page.title.length > 100 ||
    !Array.isArray(page.statements) ||
    !page.statements.length ||
    page.statements.length > 30
  )
    throw new Error("Invalid page structure.");
  const allowed = new Set(topic.key_points.map((p) => p.id));
  const seen = new Set();
  const statements = page.statements.map((statement) => {
    if (
      typeof statement.text !== "string" ||
      !statement.text.trim() ||
      !Array.isArray(statement.point_ids) ||
      !statement.point_ids.length ||
      !Array.isArray(statement.citations) ||
      !statement.citations.length
    )
      throw new Error(
        "Each statement needs point IDs and exact source citations.",
      );
    for (const id of statement.point_ids) {
      if (!allowed.has(id)) throw new Error("Unknown key point.");
      seen.add(id);
    }
    return {
      ...statement,
      citations: statement.citations.map((c) => validateCitation(c, context)),
    };
  });
  if (seen.size !== allowed.size)
    throw new Error("Page omitted required key points.");
  const content = statements.map((s) => s.text.trim()).join("\n\n");
  if (content.length > 6000)
    throw new Error("Page exceeds the editor content limit.");
  return { title: page.title.trim(), content, statements };
}

const reviewSchema = {
  type: "OBJECT",
  properties: {
    verdicts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          statement_index: { type: "INTEGER" },
          supported: { type: "BOOLEAN" },
          covered_point_ids: { type: "ARRAY", items: stringSchema },
          reason: stringSchema,
        },
        required: [
          "statement_index",
          "supported",
          "covered_point_ids",
          "reason",
        ],
      },
    },
  },
  required: ["verdicts"],
};

export function validateReview(review, page, topic) {
  if (
    !Array.isArray(review.verdicts) ||
    review.verdicts.length !== page.statements.length
  )
    throw new Error("Incomplete grounding review.");
  const indices = new Set(),
    covered = new Set();
  for (const verdict of review.verdicts) {
    const statement = page.statements[verdict.statement_index];
    if (
      !statement ||
      !Number.isInteger(verdict.statement_index) ||
      indices.has(verdict.statement_index)
    )
      throw new Error(
        "Grounding review found an unsupported statement: invalid or duplicate statement index.",
      );
    if (verdict.supported !== true)
      throw new Error(
        `Grounding review found an unsupported statement at index ${verdict.statement_index}: ${String(verdict.reason || "No reason supplied.").slice(0, 1000)}`,
      );
    indices.add(verdict.statement_index);
    if (!Array.isArray(verdict.covered_point_ids))
      throw new Error("Invalid key point review.");
    for (const id of verdict.covered_point_ids) {
      if (!statement.point_ids.includes(id))
        throw new Error("Reviewer referenced an unrelated point.");
      covered.add(id);
    }
  }
  if (topic.key_points.some((p) => !covered.has(p.id)))
    throw new Error(
      "Grounding review found omitted key points: " +
        topic.key_points
          .filter((p) => !covered.has(p.id))
          .map((p) => p.id)
          .join(", "),
    );
  return [...covered];
}

export async function generateGroundedPage(
  topic,
  context,
  generate = generateJson,
) {
  let feedback = "",
    previousDraft = null,
    previousReview = null;
  let approvedStatements = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const coveredIds = new Set(approvedStatements.flatMap(s => s.point_ids));
      const remainingPoints = topic.key_points.filter(p => !coveredIds.has(p.id));
      const repairTopic = { title: topic.title, key_points: remainingPoints };
      const generatedDraft = await generate({
        schema: pageSchema,
        instruction: [
          "Write one readable lesson page.",
          "Cover every required key point.",
          "Each statement must contain only claims directly supported by the supplied evidence quotes.",
          "Select evidence_ids from the supplied evidence list to cite; cite multiple adjacent passages when a sentence or explanation spans passages.",
          "Every detail in the statement must be present in those selected passages; do not write quotes.",
          "The key-point text is a coverage target, not evidence: if it overstates the quote, use only the supported meaning.",
          "Prefer one short factual statement per point; avoid extra explanations, implications, and absolute claims.",
          "During repair, write ONLY replacements for the remaining key points. Approved statements are retained by the server; do not repeat them. Correct rejected claims using reviewer reasons. Remove unsupported counts, examples, or absolute claims; state the supported definition instead.",
          "Use concise paragraphs.",
          "Title max 100 characters; total text max 6000 characters.",
          "Do not invent examples or facts.",
        ].join(" "),
        data: {
          topic: repairTopic,
          evidence: buildEvidence(context),
          correction: feedback,
          previous_draft: previousDraft,
          previous_review: previousReview,
        },
      });
      const draft = {
        ...generatedDraft,
        statements: [...approvedStatements, ...(generatedDraft.statements || [])],
      };
      previousDraft = draft;
      previousReview = null;
      const page = validatePage(
        attachPageEvidence(draft, topic, context),
        topic,
        context,
      );
      const review = await generate({
        schema: reviewSchema,
        instruction: [
          "Audit every statement independently.",
          "supported is true only when ALL factual claims follow from the exact cited quotes, without relying on prior knowledge.",
          "A point is covered only when its essential meaning is stated accurately.",
          "Return one verdict per zero-based statement index.",
          "Be conservative.",
        ].join(" "),
        data: { key_points: topic.key_points, statements: page.statements },
      });
      previousReview = review;
      // Lock only complete, unambiguously supported statements. Rejected or
      // partially covered statements are regenerated without changing good ones.
      if (Array.isArray(review?.verdicts) && review.verdicts.length === page.statements.length &&
          new Set(review.verdicts.map(v => v.statement_index)).size === page.statements.length) {
        approvedStatements = draft.statements.filter((statement, index) => {
          const verdict = review.verdicts.find(v => v.statement_index === index);
          return verdict?.supported === true && Array.isArray(verdict.covered_point_ids) &&
            statement.point_ids.every(id => verdict.covered_point_ids.includes(id));
        });
      }
      const covered = validateReview(review, page, topic);
      const sources = [
        ...new Map(
          page.statements
            .flatMap((s) => s.citations)
            .map((c) => [JSON.stringify([c.chunk_id, c.quote]), c]),
        ).values(),
      ];
      return {
        ...page,
        source_chunks: sources,
        covered_point_ids: covered,
        grounding: {
          exact_quotes_verified: true,
          model_review_passed: true,
          reviewer_model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          human_review_required: true,
        },
      };
    } catch (error) {
      if (error.retryable || error.statusCode) throw error;
      feedback = error.message;
    }
  }
  console.warn("Lesson grounding repair exhausted", { topic: topic.title, reason: feedback });
  throw Object.assign(
    new Error(`We couldn't verify all the source details for "${topic.title}". Your uploaded files are still available. Try generating again, or upload a clearer source that explains this topic.`),
    { statusCode: 422, code: "LESSON_GROUNDING_FAILED", cause: new Error(feedback) },
  );
}
