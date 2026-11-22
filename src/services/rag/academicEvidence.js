// Rank approved text locally. This also works for old lessons without vectors,
// and keeps retrieval inside the document set authorized by the caller.
export function rankAcademicEvidence(chunks, query, limit = 6) {
  const tokenize = (text) =>
    String(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  const words = [...new Set(tokenize(query))];
  const sets = chunks.map(
    (c) => new Set(tokenize((c.source_filename || "") + " " + c.chunk_text)),
  );
  const weights = words.map((w) =>
    Math.log(
      1 + (chunks.length + 1) / (1 + sets.filter((set) => set.has(w)).length),
    ),
  );
  return chunks
    .map((chunk, index) => ({
      chunk,
      score: words.reduce(
        (sum, w, i) => sum + (sets[index].has(w) ? weights[i] : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.chunk);
}
