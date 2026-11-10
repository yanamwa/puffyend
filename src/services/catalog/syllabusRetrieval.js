import { chunkText } from "../rag/chunkText.js";

const EXCERPT_LENGTH = 1000;
const MAX_EXCERPTS = 3;
const ignoredWords = new Set([
  "and",
  "are",
  "course",
  "for",
  "from",
  "introduction",
  "into",
  "lesson",
  "module",
  "of",
  "on",
  "or",
  "the",
  "to",
  "unit",
  "with",
]);

function normalizedPhrase(text) {
  return (
    String(text ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:[+#]+)?/gu)
      ?.join(" ") || ""
  );
}

function queryFor(text) {
  const phrase = normalizedPhrase(text);
  const words = [...new Set(phrase.split(" "))].filter(
    (word) => word.length >= 2 && !ignoredWords.has(word),
  );
  return { phrase, words };
}

export function buildSyllabusIndex(extracted) {
  const { text, positions } = extracted || {};
  if (typeof text !== "string" || !Array.isArray(positions)) return [];

  return positions.flatMap(({ page, start, end }) => {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > text.length
    )
      return [];
    return chunkText(
      { text: text.slice(start, end) },
      { size: EXCERPT_LENGTH, overlap: 150 },
    ).map((chunk) => {
      const excerpt = chunk.text.trim();
      const phrase = normalizedPhrase(excerpt);
      return {
        page,
        text: excerpt,
        phrase: ` ${phrase} `,
        words: new Set(phrase.split(" ")),
      };
    });
  });
}

function relevance(entry, query) {
  if (!query.words.length) return 0;
  if (entry.phrase.includes(` ${query.phrase} `)) return 10;
  const hits = query.words.filter((word) => entry.words.has(word)).length;
  if (hits < Math.min(2, query.words.length)) return 0;
  return (4 * hits) / query.words.length;
}

export function retrieveSyllabusExcerpts(index, module) {
  if (!index?.length) return [];

  const title = queryFor(module?.title);
  const topics = Array.isArray(module?.topics)
    ? module.topics.map(queryFor)
    : [];
  const sourcePage = module?.source_page ?? null;
  const splitHeading = new Set();
  if (sourcePage !== null && title.words.length > 1) {
    const boundary = index.findIndex(
      (entry, i) =>
        entry.page === sourcePage && index[i + 1]?.page === sourcePage + 1,
    );
    if (boundary !== -1) {
      const left = index[boundary].phrase;
      const right = index[boundary + 1].phrase;
      const heading = ` ${title.phrase} `;
      if (
        !left.includes(heading) &&
        !right.includes(heading) &&
        (left + right.trimStart()).includes(heading)
      ) {
        splitHeading.add(boundary);
        splitHeading.add(boundary + 1);
      }
    }
  }
  const ranked = index.flatMap((entry, i) => {
    const score =
      2 * (splitHeading.has(i) ? 10 : relevance(entry, title)) +
      Math.max(0, ...topics.map((topic) => relevance(entry, topic)));
    if (!score) return [];

    const distance =
      sourcePage === null ? Infinity : Math.abs(entry.page - sourcePage);
    const anchorBonus = distance === 0 ? 4 : distance === 1 ? 1 : 0;
    return [{ entry, score: score + anchorBonus }];
  });

  return ranked
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_EXCERPTS)
    .map(({ entry: { page, text } }) => ({ page, text }));
}
