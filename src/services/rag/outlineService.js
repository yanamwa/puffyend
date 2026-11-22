import { buildEvidence } from "./evidenceService.js";
export { buildEvidence } from "./evidenceService.js";
import { generateJson } from "../ai/geminiService.js";
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

export function validateOutline(part, chunks, prefix = "w0", topicLimit = 16, scope = null) {
  if (!Array.isArray(part?.topics))
    throw new Error("Outline topics must be an array.");
  const scoped = !!scope?.topics?.length;
  if ((!scoped && !part.topics.length) || part.topics.length > topicLimit)
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
  if (scoped && (!Array.isArray(part.excluded_chunk_ids) ||
      part.excluded_chunk_ids.some(id => !chunks.some(c => String(c.chunk_id) === id))))
    throw new Error("Identify out-of-scope chunks by their supplied chunk IDs.");
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
    if (scoped && !scope.topics.includes(topic.syllabus_topic))
      throw new Error("Select the matching syllabus topic verbatim.");
    if (scoped && scope.learning_objectives && (!topic.learning_objective ||
      !scope.learning_objectives.split(/[\n;]/).map(s => s.trim()).includes(topic.learning_objective)))
      throw new Error("Use the corresponding module objective verbatim.");
    return {
      title: topic.title.trim().slice(0, 100),
      ...(scoped ? { syllabus_topic: topic.syllabus_topic, learning_objective: topic.learning_objective || "" } : {}),
      key_points: points,
      anchors: chunks.filter((c) => ids.has(String(c.chunk_id))),
    };
  });
  const missing = chunks
    .filter((c) => !represented.has(String(c.chunk_id)) && !(scoped && part.excluded_chunk_ids.includes(String(c.chunk_id))))
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
  generationContext = null,
  session = null,
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
  const scoped = !!generationContext?.topics?.length;
  if (scoped) {
    schema.required = [...schema.required, "excluded_chunk_ids"];
    schema.properties.excluded_chunk_ids = { type: "ARRAY", items: stringSchema };
    const topic = structuredClone(schema.properties.topics.items);
    Object.assign(topic.properties, { syllabus_topic: stringSchema, learning_objective: stringSchema });
    topic.required.push("syllabus_topic", "learning_objective");
    schema.properties.topics = { ...schema.properties.topics, minItems: 0, items: topic };
  }
  const ask = (phase, request, last) => session ? session.call(phase, request, { fallback: last }) : generateJson(request);
  for (let start = 0; start < chunks.length; start += 8) {
    const window = chunks.slice(start, start + 8);
    let part,
      feedback = "";
    const cached = checkpoint[start / 8];
    if (cached) {
      try {
        part = validateOutline(cached, window, `w${start / 8}`, topicLimit, generationContext);
      } catch {
        /* Rebuild stale checkpoints. */
      }
    }
    let acceptedRaw = cached;
    for (let attempt = 0; attempt < 3 && !part; attempt++) {
      const raw = await ask(attempt ? "repair" : "generation", {
        schema,
        instruction: [
          `Organize the evidence into meaningful teaching topics, respecting headings and conceptual boundaries.`,
          `Extract the important definitions, mechanisms, steps, and distinctions as key points.`,
          `For each point select one supplied evidence_id that directly supports the point.`,
          `Do not write quotations or invent IDs.`,
          scoped ? "For each supported topic, copy syllabus_topic and a relevant learning_objective verbatim. Use an empty objective if none are specified. Exclude chunks unrelated to syllabus coverage in excluded_chunk_ids. Return an empty topics array if the entire window is unrelated." : "Every supplied chunk must contribute at least one key point.",
          `Return 1-${topicLimit} topics and 1-16 key points per topic.`,
          `Prefer 2-6 points per topic.`,
          `Group related points rather than creating a topic for every sentence.`,
          `Do not invent facts.`,
          `Metadata describes this source window.`,
          "Requested syllabus coverage describes scope only. The instructional evidence list is the only factual source. Never infer content from bibliographic listings.",
        ].join(" "),
        data: { evidence: buildEvidence(window), correction: feedback, requested_coverage: generationContext },
      }, attempt === 2);
      try {
        part = validateOutline(raw, window, `w${start / 8}`, topicLimit, generationContext);
        acceptedRaw = raw;
        break;
      } catch (error) {
        feedback = error.message;
        console.warn(
          "RAG outline validation:",
          JSON.stringify({
            window: start / 8 + 1,
            attempt: attempt + 1,
            category: "outline_structure",
          }),
        );
      }
    }
    if (!part)
      throw Object.assign(
        new Error(
          `Your files were saved, but outline section ${start / 8 + 1} could not be verified against the materials. Use Retry generation.`,
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
    header = await ask("generation", {
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
  if (!topics.length) throw Object.assign(new Error("The instructional materials do not support the selected syllabus topics. Add a source covering this module."), { statusCode: 422 });
  if (scoped) topics.sort((a,b) => generationContext.topics.indexOf(a.syllabus_topic) - generationContext.topics.indexOf(b.syllabus_topic));
  return {
    module_title: header.module_title,
    subject: header.subject,
    description: header.description,
    learning_objectives: header.learning_objectives,
    topics,
  };
}
