export function buildEvidence(chunks) {
  return chunks.flatMap(chunk => {
    const text = chunk.chunk_text;
    const passages = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + 600, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > start + 300) end = boundary;
      }
      passages.push(text.slice(start, end)); start = end;
    }
    if (passages.length > 1 && passages.at(-1).trim().length < 12) passages[passages.length - 2] += passages.pop();
    return passages.map((quote, index) => ({ evidence_id: 'c' + chunk.chunk_id + '-e' + index,
      chunk_id: String(chunk.chunk_id), filename: chunk.source_filename, quote }));
  });
}

