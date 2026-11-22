import axios from "axios";
import { invalidOutput, remainingTime, requestProviderJson } from "./jsonProviderRequest.js";

export function organizerEmbeddingConfig(provider) {
  return provider === "gemini" ? embeddingConfig() : { model: "openai:text-embedding-3-small", dimensions: 768 };
}

export async function embedOrganizerDocuments(texts, session) {
  const order = [session.primary, session.primary === "openai" ? "gemini" : "openai"];
  for (const provider of order) {
    const config = organizerEmbeddingConfig(provider);
    const deadlineAt = Date.now() + Math.max(1, Math.floor(session.left() * (provider === order[0] ? 0.35 : 0.5)));
    try {
      return { config, vectors: await embedTexts(texts, "RETRIEVAL_DOCUMENT", config, { deadlineAt }) };
    } catch (error) {
      session.left();
      if (provider === order[1]) throw Object.assign(new Error("The learning materials could not be indexed by either provider. Retry organization when indexing is available."), { statusCode: 503 });
    }
  }
}

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
  request = {},
) {
  const key = process.env.GEMINI_API_KEY;
  const openai = config.model.startsWith("openai:");
  if (!openai && !key) throw new Error("GEMINI_API_KEY is missing.");
  const vectors = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    if (batch.some((text) => typeof text !== "string" || !text.trim()))
      throw new Error("Embedding text cannot be empty.");
    const timeout = Math.min(90000, remainingTime(request));
    if (openai) {
      const model = config.model.slice("openai:".length);
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      const values = await requestProviderJson("OpenAI embeddings", { model, apiKey, ...request, timeoutMs: timeout, attempt: 1 },
        options => axios.post("https://api.openai.com/v1/embeddings", { model, dimensions: config.dimensions, input: batch },
          { ...options, headers: { Authorization: "Bearer " + apiKey } }),
        body => {
          if (!Array.isArray(body?.data) || body.data.length !== batch.length) throw invalidOutput();
          return [...body.data].sort((a,b) => a.index-b.index).map((row,i) => {
            if (row.index !== i) throw invalidOutput();
            return validateVector(row.embedding, config.dimensions);
          });
        });
      vectors.push(...values);
      continue;
    }
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
        { headers: { "x-goog-api-key": key }, timeout, signal: request.signal },
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
