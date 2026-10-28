import axios from "axios";

export function embeddingConfig() {
  const model = (
    process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001"
  ).replace(/^models\//, "");
  const dimensions = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 768);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 3072)
    throw new Error("Invalid embedding dimensions.");
  return { model, dimensions };
}

export function validateVector(vector, dimensions) {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    !vector.every(Number.isFinite) ||
    !vector.some((v) => v !== 0)
  ) {
    throw new Error("Invalid embedding vector or dimension mismatch.");
  }
  return vector;
}

export async function embedTexts(
  texts,
  taskType = "RETRIEVAL_DOCUMENT",
  config = embeddingConfig(),
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing.");
  const vectors = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    if (batch.some((text) => typeof text !== "string" || !text.trim()))
      throw new Error("Embedding text cannot be empty.");
    let response;
    try {
      response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:batchEmbedContents`,
        {
          requests: batch.map((text) => ({
            model: `models/${config.model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: config.dimensions,
          })),
        },
        { headers: { "x-goog-api-key": key }, timeout: 90000 },
      );
    } catch (error) {
      const status = error.response?.status;
      throw Object.assign(
        new Error(
          "Gemini embedding request failed. Check the model, API key, and quota.",
        ),
        {
          statusCode: status === 429 ? 429 : 502,
          retryable: !status || status === 429 || status >= 500,
        },
      );
    }
    if (response.data.embeddings?.length !== batch.length)
      throw new Error("Gemini returned an incomplete embedding batch.");
    vectors.push(
      ...response.data.embeddings.map((item) =>
        validateVector(item.values, config.dimensions),
      ),
    );
  }
  return vectors;
}

export async function embedQuery(query, config = embeddingConfig()) {
  return (await embedTexts([query], "RETRIEVAL_QUERY", config))[0];
}
