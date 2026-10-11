export function chunkText(
  { text, positions = [] },
  { size = 2400, overlap = 300 } = {},
) {
  if (
    !Number.isInteger(size) ||
    !Number.isInteger(overlap) ||
    size < 100 ||
    overlap < 0 ||
    overlap >= size
  ) {
    throw new Error("Invalid chunk size or overlap.");
  }
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      // Prefer paragraph boundaries, then sentence/word boundaries.
      let boundary = text.lastIndexOf("\n\n", end);
      if (boundary <= start + size / 2) {
        const sentences = [...text.slice(start, end).matchAll(/[.!?]\s+/g)];
        boundary = sentences.length ? start + sentences.at(-1).index + 1 : -1;
      }
      if (boundary <= start + size / 2) boundary = text.lastIndexOf(" ", end);
      if (boundary > start + size / 2) end = boundary;
    }
    const value = text.slice(start, end);
    if (value.trim())
      chunks.push({
        order: chunks.length,
        start,
        end,
        text: value,
        position: positions.filter((p) => p.start < end && p.end > start),
      });
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}
