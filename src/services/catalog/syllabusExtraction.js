import { PDFParse } from "pdf-parse";
import { catalogDetails, parseSyllabus } from "./catalogRules.js";
import { extractAcademicSections, enrichSyllabusModules } from "./syllabusContext.js";

// Keep PDF text positions: flattening the page mixes ILOs, topics and assessments.
export function positionedLines(items) {
  const rows = [];
  for (const item of items
    .filter((i) => i.str?.trim())
    .sort(
      (a, b) =>
        b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
    )) {
    const y = item.transform[5];
    let row = rows.find((row) => Math.abs(row.y - y) < 2);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows.map((row) => {
    const sorted = row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = "",
      end;
    for (const item of sorted) {
      const x = item.transform[4];
      if (end !== undefined && x - end > 1.5) text += " ";
      text += item.str;
      end = x + item.width;
    }
    return {
      text: text.replace(/\s+/g, " ").trim(),
      y: row.y,
      x: sorted[0].transform[4],
      height: Math.max(...sorted.map((i) => Math.abs(i.transform[3]))),
    };
  });
}
export function isExcludedCoverageTitle(title) {
  return (
    /^(?:(?:course|general|student|gad)\s+)?orientation\b/i.test(title) ||
    /^(?:college|department|university|campus|institutional).*(?:goals|objectives)/i.test(
      title,
    ) ||
    /^(?:vision\s*(?:and|&)\s*mission|quality\s+policy|vmgo|course\s+(?:overview|policies|requirements))/i.test(
      title,
    )
  );
}
function findHeaderSpan(items, pattern) {
  for (const line of positionedLines(items)) {
    const row = items
      .filter(i => i.str?.trim() &&
        Math.abs(i.transform[5] - line.y) < 2)
      .sort((a, b) => a.transform[4] - b.transform[4]);

    for (let start = 0; start < row.length; start++) {
      let text = "";
      const first = row[start];
      let right = first.transform[4];

      for (let j = start; j < Math.min(row.length, start + 12); j++) {
        const item = row[j];
        const x = item.transform[4];

        if (j > start && x - right > 4) break;

        text += item.str;
        right = Math.max(right, x + item.width);

        if (pattern.test(text.replace(/\s+/g, ""))) {
          return {
            ...first,
            str: text,
            width: right - first.transform[4],
          };
        }
      }
    }
  }
  return undefined;
}

export function coverageHeadings(pages, detailed = false) {
  const result = [];
  let bounds = null,
    inCoverage = false,
    current = null, active = null, lastTopic = null, plain = false;
  for (const page of pages) {
    const header =
      findHeaderSpan(page.items, /^topics?$/i) ??
      page.items.find((i) =>
        /^topic(?:s)?$/i.test(i.str?.trim() || "")
      );
    const pageLines = positionedLines(page.items);
    const coverage = pageLines.find((l) =>
      /^COURSE COVERAGE\s*:?$/i.test(l.text),
    );
    const stop = pageLines.find((l) =>
      /^(?:COURSE REQUIREMENTS|GRADING SYSTEM|REFERENCES(?:\s*(?:&|and)\s*SUPPLEMENTARY (?:READINGS|MATERIALS))?|REVISION HISTORY)\s*:?$/i.test(
        l.text,
      ),
    );
    if (coverage) inCoverage = true;
    if (!inCoverage) continue;
    if (coverage && !header && !bounds) plain = true;
    if (header) {
      const teaching = page.items.find(
        (i) =>
          /^Teaching(?: and)?$/i.test(i.str?.trim() || "") &&
          Math.abs(i.transform[5] - header.transform[5]) < 40,
      );
      if (teaching) {
        const center = header.transform[4] + header.width / 2,
          right = teaching.transform[4] - Math.abs(teaching.transform[3]) * 1.5;
        bounds = {
          left: (center - (right - center) - 6) / page.width,
          right: right / page.width,
        };
      }
    }
    if (!bounds && !(plain && detailed)) continue;
    const items = page.items.filter(
      (i) =>
        (!bounds || (i.transform[4] >= bounds.left * page.width &&
        i.transform[4] < bounds.right * page.width)) &&
        (!coverage || i.transform[5] < coverage.y) &&
        (!header || i.transform[5] < header.transform[5] - 28) &&
        (!stop || i.transform[5] > stop.y),
    );
    const lines = positionedLines(items);
    for (const line of lines) {
      const match =
        line.text.match(/^([IVX]+)[.)]\s+(.+)$/) ||
        line.text.match(
          /^(?:MODULE|LESSON|UNIT|CHAPTER)\s*([\dIVXLCDM]+)(?:\s*[:.–-]\s*|\s+)?(.*)$/i,
        );
      if (match && !(lastTopic?.letter === "H" && /^I[.)]/.test(line.text))) {
        const title = match[2].trim();
        if (title.length > 255) continue;
        current = { title, ordinal: match[1], source_page: page.num, topics: [], source_lines: [], objective_lines: [] };
        active = current;
        lastTopic = null;
        result.push(current);
        current.lastY = line.y;
        current.page = page.num;
        current.height = line.height;
      } else if (active && /^(?:(?:module|unit)\s+)?description\s*:/i.test(line.text)) {
        active.syllabus_description = line.text.replace(/^[^:]+:\s*/, "");
        current = null;
        lastTopic = null;
      } else if (active && /^(?:[A-Za-z]|\d+(?:\.\d+)*)[.)]\s*\S/.test(line.text)) {
        const label = line.text.match(/^([A-Za-z]|\d+(?:\.\d+)*)[.)]\s*(.+)$/);
        current = null;
        if (label) {
          active.topics.push(label[2]);
          lastTopic = { letter: label[1].toUpperCase(), page: page.num, y: line.y };
        }
      } else if (current) {
        // Wrapped heading lines stay adjacent; stop at the first numbered subtopic or paragraph gap.
        if (
          /^\s*(?:\d+|[a-z])[.)]\s*/i.test(line.text) ||
          (current.page !== page.num &&
            !(current.lastY < 100 && line.y > (page.height || 595) - 100)) ||
          current.lastY - line.y > current.height * 1.65 ||
          current.title.length + line.text.length > 255
        ) {
          current = null;
        } else {
          current.title = (current.title + " " + line.text).trim();
          current.page = page.num;
          current.lastY = line.y;
        }
      } else if (lastTopic && lastTopic.page === page.num && lastTopic.y - line.y <= line.height * 1.65) {
        active.topics[active.topics.length - 1] += " " + line.text;
        lastTopic.y = line.y;
      }
      if (active) active.source_lines.push(line.text);
    }
    if (detailed && bounds) {
      // ILOs occupy the column between the week column and Topic. Assign by
      // the module heading's vertical range, including continuation pages.
      const ilo = page.items.find(i => /^(?:intended learning(?: outcomes?)?|learning outcomes?|ILOs?)$/i.test(i.str?.trim()));
      if (ilo && ilo.transform[4] < bounds.left * page.width) bounds.ilo = (ilo.transform[4] - 12) / page.width;
      if (bounds.ilo != null) {
        const headings = result.filter(row => row.source_page === page.num);
        const firstY = row => lines.find(line => line.text.includes(row.source_lines[0]))?.y ?? -Infinity;
        const left = positionedLines(page.items.filter(i => i.transform[4] >= bounds.ilo * page.width && i.transform[4] < bounds.left * page.width &&
          (!header || i.transform[5] < header.transform[5] - 28) && (!coverage || i.transform[5] < coverage.y) && (!stop || i.transform[5] > stop.y)));
        for (const line of left) {
          const owner = headings.filter(row => line.y <= firstY(row) + 6).at(-1) || result.filter(row => row.source_page < page.num).at(-1);
          if (owner) owner.objective_lines.push(line.text);
        }
      }
    }
    if (stop) break;
  }
  const unique = new Map();
  for (const { title, ordinal, source_page, topics, source_lines, objective_lines, syllabus_description } of result) {
    if (!title || isExcludedCoverageTitle(title)) continue;
    const key = (detailed ? ordinal + "|" : "") + title.toLowerCase();
    const existing = unique.get(key);
    if (!existing) unique.set(key, detailed
      ? { title, source_page, topics, source_lines, objective_lines, syllabus_description } : { title, source_page });
    else if (detailed) {
      existing.topics.push(...topics.filter(topic => !existing.topics.includes(topic)));
      existing.source_lines.push(...source_lines);
      existing.objective_lines.push(...objective_lines);
    }
  }
  return [...unique.values()].slice(0, 150);
}
async function readPositionedPage(document, num) {
  const page = await document.getPage(num);
  const { items } = await page.getTextContent();
  const { width, height } = page.getViewport({ scale: 1 });
  page.cleanup();
  return { num, width, height, items };
}

export const INVALID_SYLLABUS = "INVALID_SYLLABUS";

function invalidSyllabus(message) {
  return Object.assign(new Error(message), {
    statusCode: 422,
    code: INVALID_SYLLABUS,
  });
}

export async function extractSyllabus(data, { includeCoverage = true, workflowOptions } = {}) {
  const parser = new PDFParse({ data });
  try {
    const unreadable =
      "Could not read the first page. Upload a CvSU syllabus PDF with selectable text.";
    let document, firstPage, cover;
    try {
      const result = await parser.getText({ first: 1 });
      firstPage = result.pages[0]?.text.trim();
      document = await parser.load();
      cover = await readPositionedPage(document, 1);
    } catch {
      throw invalidSyllabus(unreadable);
    }
    if (!firstPage) throw invalidSyllabus(unreadable);

    // Some PDF exports draw the page header after the body in the text stream.
    const coverText = positionedLines(cover.items).map(({ text }) => text).join("\n");
    const header = coverText.split(/\b(?:course|subject)\s+code\b/i, 1)[0];
    if (
      !/\bcavite\s+state\s+university\b/i.test(header) ||
      !/\bsyllabus\b/i.test(header)
    ) {
      throw invalidSyllabus(
        "Only Cavite State University (CvSU) syllabi are accepted. The first page must show the university name and syllabus heading.",
      );
    }
    const details = parseSyllabus(firstPage);
    if (!details.code || !details.title) {
      throw invalidSyllabus(
        "Could not detect the course code and title. Upload a CvSU syllabus PDF with both fields on the first page.",
      );
    }
    catalogDetails(details);
    if (!includeCoverage) return details;

    const pages = [cover];
    for (let num = 2; num <= document.numPages; num++)
      pages.push(await readPositionedPage(document, num));
    const textPages = pages.map(page => ({
      page: page.num, lines: positionedLines(page.items).map(line => line.text),
    }));
    const academic = extractAcademicSections(textPages);
    const modules = await enrichSyllabusModules(coverageHeadings(pages, true), details, academic, textPages, workflowOptions);
    return { ...details, ...academic, coverage_modules: modules };
  } finally {
    await parser.destroy();
  }
}
