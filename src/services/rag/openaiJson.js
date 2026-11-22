import axios from "axios";
import {
  incompleteOutput,
  invalidOutput,
  parseProviderJson,
  requestProviderJson,
  sourceInstructions,
} from "./jsonProviderRequest.js";

// The practice draft and review schemas use Gemini's uppercase type names.
// OpenAI requires a closed object and every property in its required list.
function strictSchema(schema) {
  const type = schema.type.toLowerCase();
  if (type === "object") {
    const properties = {};
    for (const [name, field] of Object.entries(schema.properties)) {
      const value = strictSchema(field);
      properties[name] = schema.required?.includes(name)
        ? value
        : { anyOf: [value, { type: "null" }] };
    }
    return { type, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (type === "array") return { type, items: strictSchema(schema.items) };
  return schema.enum ? { type, enum: schema.enum } : { type };
}

export async function generateOpenAIJson({ instruction, data, schema, signal, deadlineAt, timeoutMs = 45000, schemaName = "practice_response" }) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
  return requestProviderJson(
    "OpenAI", { apiKey, model, signal, deadlineAt, timeoutMs, attempt: 1 },
    (options) => axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model,
        store: false,
        messages: [
          { role: "system", content: instruction + sourceInstructions },
          { role: "user", content: JSON.stringify(data) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema: strictSchema(schema) },
        },
      },
      { ...options, headers: { Authorization: `Bearer ${apiKey}` } },
    ),
    (body) => {
      const choice = body?.choices?.[0];
      if (choice?.finish_reason !== "stop" || choice.message?.refusal) throw incompleteOutput();
      const result = parseProviderJson(choice.message?.content);
      // Individual slots still go through the common validator so reviewed
      // siblings can survive a bad question or a missing slot.
      if (!schema.required.every((key) => schema.properties[key].type === "ARRAY"
        ? Array.isArray(result?.[key]) : result?.[key] != null)) throw invalidOutput();
      return result;
    },
  );
}
