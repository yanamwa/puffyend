import { generateJson } from "./geminiJson.js";
import { generationTimeout, remainingTime } from "./jsonProviderRequest.js";
import { generateOpenAIJson } from "./openaiJson.js";

const configurationFailures = new Set([
  "PROVIDER_BILLING", "PROVIDER_QUOTA", "PROVIDER_KEY_REJECTED",
  "PROVIDER_PERMISSION", "PROVIDER_MODEL", "PROVIDER_NOT_CONFIGURED",
]);

// This preference lasts for one quiz, including its independent review and
// repairs. The next student's job starts with Gemini again.
export function createPracticeJsonGenerator() {
  let useBackup = false;
  return async (request) => {
    const timeoutMs = request.timeoutMs ?? 45000;
    const backupConfigured = !!process.env.OPENAI_API_KEY?.trim();
    if (!useBackup) {
      try {
        return await generateJson({
          ...request, timeoutMs, reserveFallbackMs: backupConfigured ? timeoutMs : 0,
        });
      } catch (error) {
        remainingTime(request);
        if (!backupConfigured || !(error.retryable || configurationFailures.has(error.code))) throw error;
        if (remainingTime(request) < 5000) throw generationTimeout();
        useBackup = true;
        console.info("[Practice AI] Switching to OpenAI", { reason: error.code });
      }
    }
    if (remainingTime(request) < 5000) throw generationTimeout();
    try {
      return await generateOpenAIJson(request);
    } catch (error) {
      remainingTime(request);
      if (!(error.retryable || configurationFailures.has(error.code))) throw error;
      throw Object.assign(new Error("Both question providers are unavailable. Please try again."), {
        statusCode: 503, code: "PRACTICE_PROVIDERS_UNAVAILABLE",
      });
    }
  };
}
