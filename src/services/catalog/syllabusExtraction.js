import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { parseSyllabus } from "./catalogRules.js";

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
export function coverageHeadings(pages) {
  const result = [];
  let bounds = null,
    inCoverage = false,
    current = null;
  for (const page of pages) {
    const header = page.items.find((i) =>
      /^topic(?:s)?$/i.test(i.str?.trim() || ""),
    );
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
export async function extractSyllabus(filePath) {
  const parser = new PDFParse({ data: await fs.readFile(filePath) });
  try {
    const result = await parser.getText();
    if (!result.pages.some((page) => page.text.trim()))
      throw new Error("No searchable text.");
    // PDFParse uses the installed PDF.js document internally; preserve its text geometry.
    const document = await parser.load(),
      pages = [];
    for (let num = 1; num <= document.numPages; num++) {
      const page = await document.getPage(num),
        { items } = await page.getTextContent();
      pages.push({
        num,
        width: page.getViewport({ scale: 1 }).width,
        height: page.getViewport({ scale: 1 }).height,
        items,
      });
      page.cleanup();
    }
    return {
      ...parseSyllabus(result.pages.map((p) => p.text).join("\n")),
      coverage_modules: coverageHeadings(pages),
    };
  } finally {
    await parser.destroy();
  }
}
