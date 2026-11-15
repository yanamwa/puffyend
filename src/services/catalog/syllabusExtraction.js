import { PDFParse } from "pdf-parse";
import { catalogDetails, parseSyllabus } from "./catalogRules.js";

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

export function coverageHeadings(pages) {
  const result = [];
  let bounds = null,
    inCoverage = false,
    current = null;
  for (const page of pages) {
    const header = findHeaderSpan(page.items, /^topics?$/i);
    const coverage = positionedLines(page.items).find((l) =>
      /^COURSE COVERAGE$/i.test(l.text),
    );
    const stop = positionedLines(page.items).find((l) =>
      /^(?:COURSE REQUIREMENTS|GRADING SYSTEM|REFERENCES(?: & SUPPLEMENTARY READINGS)?|REVISION HISTORY)$/i.test(
        l.text,
      ),
    );
    if (coverage) inCoverage = true;
    if (!inCoverage) continue;
    if (stop && !coverage) break;
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
    if (!bounds) continue; // Do not guess modules from unrelated columns when no Topic header is identifiable.
    const items = page.items.filter(
      (i) =>
        i.transform[4] >= bounds.left * page.width &&
        i.transform[4] < bounds.right * page.width &&
        (!header || i.transform[5] < header.transform[5] - 28) &&
        (!coverage || i.transform[5] < coverage.y - 2) &&
        (!stop || i.transform[5] > stop.y),
    );
    const lines = positionedLines(items);
    for (const line of lines) {
      const match =
        line.text.match(/^([IVX]+)[.)]\s+(.+)$/) ||
        line.text.match(
          /^(?:MODULE|LESSON|UNIT|CHAPTER)\s*([\dIVXLCDM]+)(?:\s*[:.–-]\s*|\s+)?(.*)$/i,
        );
      if (match) {
        const title = match[2].trim();
        if (title.length > 255) continue;
        current = { title, source_page: page.num };
        result.push(current);
        current.lastY = line.y;
        current.page = page.num;
        current.height = line.height;
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
          continue;
        }
        current.title = (current.title + " " + line.text).trim();
        current.page = page.num;
        current.lastY = line.y;
      }
    }
  }
  const seen = new Set();
  return result
    .map(({ title, source_page }) => ({ title, source_page }))
    .filter((row) => {
      if (!row.title || isExcludedCoverageTitle(row.title)) return false;
      const key = row.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 150);
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

export async function extractSyllabus(data, { includeCoverage = true } = {}) {
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
    return {
      ...details,
      coverage_modules: coverageHeadings(pages),
    };
  } finally {
    await parser.destroy();
  }
}
