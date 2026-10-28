import { embedQuery, validateVector } from "./embeddingService.js";
import { loadChunks } from "./vectorRepository.js";

export function cosineSimilarity(a, b) {
  validateVector(a, b.length);
  validateVector(b, a.length);
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / Math.sqrt(aa * bb);
}

export async function retrieveContext(
  documentId,
  query,
  { topK = 5, chunks } = {},
) {
  return retrieveContexts([documentId], query, { topK, chunks });
}

export async function retrieveContexts(
  documentIds,
  query,
  { topK = 5, chunks } = {},
) {
  if (!Number.isInteger(topK) || topK < 1 || topK > 20)
    throw new Error("topK must be between 1 and 20.");
  const allowed = new Set(documentIds.map(String));
  const source =
    chunks || (await Promise.all(documentIds.map(loadChunks))).flat();
  if (!source.length || source.some((c) => !allowed.has(String(c.document_id))))
    throw new Error("No indexed chunks for these documents.");
  const config = {
    model: source[0].embedding_model,
    dimensions: source[0].embedding_dimensions,
  };
  if (
    source.some(
      (c) =>
        c.embedding_model !== config.model ||
        c.embedding_dimensions !== config.dimensions,
    )
  )
    throw new Error("Mixed embedding models. Reindex the document.");
  const vector = await embedQuery(query, config);
  return source
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(vector, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
