import { buildEvidence } from "./evidenceService.js";
export { buildEvidence } from "./evidenceService.js";
import { generateJson } from "../geminiService.js";
import { stringSchema, validateCitation } from "./groundingService.js";

const outlineSchema = {
  type: "OBJECT",
  properties: {
    module_title: stringSchema,
    subject: stringSchema,
    description: stringSchema,
    learning_objectives: stringSchema,
    topics: {
      type: "ARRAY",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "OBJECT",
        properties: {
          title: stringSchema,
          key_points: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: stringSchema,
                evidence_id: stringSchema,
              },
              required: ["text", "evidence_id"],
            },
          },
        },
        required: ["title", "key_points"],
      },
    },
  },
  required: [
    "module_title",
    "subject",
    "description",
    "learning_objectives",
    "topics",
  ],
};

export function validateOutline(part, chunks, prefix = "w0", topicLimit = 16) {
  if (!Array.isArray(part?.topics))
    throw new Error("Outline topics must be an array.");
  if (!part.topics.length || part.topics.length > topicLimit)
    throw new Error(
      `Outline must contain 1–${topicLimit} topics; received ${part.topics.length}. Group related points into fewer topics.`,
    );
  for (const key of [
    "module_title",
    "subject",
    "description",
    "learning_objectives",
  ]) {
    if (typeof part[key] !== "string" || !part[key].trim())
      throw new Error("Incomplete outline metadata.");
  }
  const evidence = new Map(
    buildEvidence(chunks).map((e) => [e.evidence_id, e]),
  );
  const represented = new Set();
  const topics = part.topics.map((topic, i) => {
    if (
      !topic.title?.trim() ||
      !Array.isArray(topic.key_points) ||
      !topic.key_points.length ||
      topic.key_points.length > 16
    )
      throw new Error("Each topic needs bounded key points.");
    const points = topic.key_points.map((point, j) => {
      const selected = evidence.get(point.evidence_id);
      if (!selected)
        throw new Error(
          "Unknown evidence ID at topic " +
            (i + 1) +
            ", point " +
            (j + 1) +
            ": " +
            String(point.evidence_id),
        );
      const source = validateCitation(
        { chunk_id: selected.chunk_id, quote: selected.quote },
        chunks,
      );
      if (!point.text?.trim()) throw new Error("Empty key point.");
      represented.add(source.chunk_id);
      return { id: `${prefix}-t${i}-p${j}`, text: point.text.trim(), source };
    });
    const ids = new Set(points.map((p) => p.source.chunk_id));
    return {
      title: topic.title.trim().slice(0, 100),
      key_points: points,
      anchors: chunks.filter((c) => ids.has(String(c.chunk_id))),
    };
  });
  const missing = chunks
    .filter((c) => !represented.has(String(c.chunk_id)))
    .map((c) => String(c.chunk_id));
  if (missing.length)
    throw new Error(
      "Outline omitted source chunks: " +
        missing.join(", ") +
        ". Select at least one evidence ID from each missing chunk.",
    );
  return { ...part, topics };
}

export async function createSemanticOutline(
  chunks,
  onProgress = async () => {},
  checkpoint = [],
) {
  const topics = [],
    metadata = [];
  const topicLimit = Math.min(
    16,
    Math.floor(80 / Math.ceil(chunks.length / 8)),
  );
  const schema = {
    ...outlineSchema,
    properties: {
      ...outlineSchema.properties,
      topics: { ...outlineSchema.properties.topics, maxItems: topicLimit },
    },
  };
  for (let start = 0; start < chunks.length; start += 8) {
    const window = chunks.slice(start, start + 8);
    let part,
      feedback = "";
    const cached = checkpoint[start / 8];
    if (cached) {
      try {
        part = validateOutline(cached, window, `w${start / 8}`, topicLimit);
      } catch {
        /* Rebuild stale checkpoints. */
      }
    }
    let acceptedRaw = cached;
    for (let attempt = 0; attempt < 3 && !part; attempt++) {
      const raw = await generateJson({
        schema,
        instruction: `Organize the evidence into meaningful teaching topics, respecting headings and conceptual boundaries. Extract the important definitions, mechanisms, steps, and distinctions as key points. For each point select one supplied evidence_id that directly supports the point. Do not write quotations or invent IDs. Every supplied chunk must contribute at least one key point. Return 1-${topicLimit} topics and 1-16 key points per topic. Prefer 2-6 points per topic. Group related points rather than creating a topic for every sentence. Do not invent facts. Metadata describes this source window.`,
        data: { evidence: buildEvidence(window), correction: feedback },
      });
      try {
        part = validateOutline(raw, window, `w${start / 8}`, topicLimit);
        acceptedRaw = raw;
        break;
      } catch (error) {
        feedback = error.message;
        console.warn(
          "RAG outline validation:",
          JSON.stringify({
            window: start / 8 + 1,
            attempt: attempt + 1,
            reason: feedback,
          }),
        );
      }
    }
    if (!part)
      throw Object.assign(
        new Error(
          `Your files were saved, but we could not verify outline window ${start / 8 + 1}: ${feedback} Use Retry generation.`,
        ),
        { statusCode: 422 },
      );
    checkpoint[start / 8] = acceptedRaw;
    topics.push(...part.topics);
    metadata.push(part);
    await onProgress({
      phase: "outline",
      outlineCheckpoint: checkpoint,
      progress:
        25 +
        Math.round((15 * Math.min(start + 8, chunks.length)) / chunks.length),
    });
  }
  if (topics.length > 80)
    throw Object.assign(
      new Error(
        "Outline exceeds 80 topics. Split this source into smaller documents.",
      ),
      { statusCode: 413 },
    );
  let header = metadata[0];
  if (metadata.length > 1) {
    header = await generateJson({
      schema: {
        ...outlineSchema,
        properties: Object.fromEntries(
          Object.entries(outlineSchema.properties).filter(
            ([k]) => k !== "topics",
          ),
        ),
        required: outlineSchema.required.filter((k) => k !== "topics"),
      },
      instruction:
        "Combine the source-window descriptions into concise module metadata covering the complete lesson. Do not add facts. Module title and subject max 100 characters.",
      data: metadata.map(({ topics: ignored, ...rest }) => rest),
    });
  }
  return {
    module_title: header.module_title,
    subject: header.subject,
    description: header.description,
    learning_objectives: header.learning_objectives,
    topics,
  };
}
