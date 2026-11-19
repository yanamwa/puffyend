import timers from "node:timers/promises";
import axios from "axios";
import {
  generationTimeout,
  incompleteOutput,
  parseProviderJson,
  remainingTime,
  requestProviderJson,
  sourceInstructions,
} from "./jsonProviderRequest.js";

function readResponse(body) {
  const candidate = body?.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP")
    throw incompleteOutput();
  const text = candidate?.content?.parts
    ?.filter((part) => !part.thought)
    .map((part) => part.text || "")
    .join("");
  return parseProviderJson(text);
}

export async function generateJson({
  instruction, data, schema, signal, deadlineAt, timeoutMs = 90000,
  maxAttempts = 3, reserveFallbackMs = 0,
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const attempts = Math.max(1, Math.min(3, maxAttempts));
  const send = (options) => axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: instruction + sourceInstructions }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(data) }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    },
    { ...options, headers: { "x-goog-api-key": apiKey } },
  );

  for (let attempt = 1; ; attempt++) {
    try {
      const remaining = remainingTime({ signal, deadlineAt });
      const attemptTimeout = reserveFallbackMs ? Math.min(timeoutMs, Math.ceil(remaining / 2)) : timeoutMs;
      return await requestProviderJson(
        "Gemini", { apiKey, model, signal, deadlineAt, timeoutMs: attemptTimeout, attempt }, send, readResponse,
      );
    } catch (error) {
      const remaining = remainingTime({ signal, deadlineAt });
      if (!error.retryable || attempt >= attempts) throw error;
      // If an entire call has already timed out, give the backup its chance now.
      if (reserveFallbackMs && error.code === "PROVIDER_REQUEST_TIMEOUT") throw error;
      const delay = Math.max(1000 * 2 ** (attempt - 1), error.retryAfterMs || 0);
      if (delay > 10000 || remaining < delay + timeoutMs + reserveFallbackMs) throw error;
      try {
        await timers.setTimeout(delay, undefined, { signal });
      } catch (waitError) {
        if (signal?.aborted) throw generationTimeout();
        throw waitError;
      }
    }
  }
}
