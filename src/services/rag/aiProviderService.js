import { generateJson } from "./geminiJson.js";
import { generationTimeout, remainingTime, withEarlierDeadline } from "./jsonProviderRequest.js";
import { generateOpenAIJson } from "./openaiJson.js";

const configurationFailures = new Set([
  "PROVIDER_BILLING", "PROVIDER_QUOTA", "PROVIDER_KEY_REJECTED",
  "PROVIDER_PERMISSION", "PROVIDER_MODEL", "PROVIDER_NOT_CONFIGURED",
]);
export const MIN_OPENAI_REQUEST_MS = 5_000;

// This preference lasts for one quiz, including its independent review and
// repairs. The next student's job starts with Gemini again.
export function createPracticeJsonGenerator() {
  let backupReason;
  const backupConfigured = () => Boolean(process.env.OPENAI_API_KEY?.trim());
  const canStartOpenAI = () => !backupReason && backupConfigured();
  function startOpenAI(reason, request) {
    if (!canStartOpenAI()) return false;
    if (remainingTime(request) < MIN_OPENAI_REQUEST_MS) throw generationTimeout();
    backupReason = reason;
    return true;
  }

  const generate = async (request, { validationReserveMs = 0, repairing = false } = {}) => {
    const timeoutMs = request.timeoutMs ?? 45000;
    if (!backupReason) {
      let primary = request;
      const hasBackup = backupConfigured();
      const reserveValidation = hasBackup && validationReserveMs > 0 && Number.isFinite(request.deadlineAt);
      // The primary cutoff includes retries and backoff. An availability
      // fallback still gets the original phase deadline and cancellation signal.
      if (reserveValidation) {
        const remaining = remainingTime(request);
        // A reclaimed job may start with less than a full recovery window.
        // Give its initial draft/review a chance to establish verified slots.
        const minimum = repairing ? 0 : Math.min(timeoutMs, Math.ceil(remaining / 2));
        const reserve = Math.min(validationReserveMs, remaining - minimum);
        primary = withEarlierDeadline(request, request.deadlineAt - reserve);
      }
      try {
        return await generateJson({
          ...primary, timeoutMs,
          maxAttempts: repairing && reserveValidation ? 1 : request.maxAttempts,
          reserveFallbackMs: hasBackup && !reserveValidation ? timeoutMs : 0,
          fallbackOnTimeout: hasBackup,
        });
      } catch (error) {
        remainingTime(request);
        const cutoffReached = reserveValidation && error.code === "GENERATION_TIMEOUT";
        if (cutoffReached && repairing) {
          // The validator owns the pending slots and their latest rejection.
          throw Object.assign(new Error("Time reserved for OpenAI validation repair."), {
            code: "PRACTICE_REPAIR_WINDOW_ENDED", statusCode: 503,
          });
        }
        if (!(cutoffReached || error.retryable || configurationFailures.has(error.code)) ||
            !startOpenAI(cutoffReached ? "time_budget" : "availability", request))
          throw error;
        console.info("[Practice AI] Switching to OpenAI", { reason: cutoffReached ? "time_budget" : error.code });
      }
    }
    if (remainingTime(request) < MIN_OPENAI_REQUEST_MS) throw generationTimeout();
    try {
      return await generateOpenAIJson(request);
    } catch (error) {
      remainingTime(request);
      if (backupReason !== "availability" || !(error.retryable || configurationFailures.has(error.code))) throw error;
      throw Object.assign(new Error("Both question providers are unavailable. Please try again."), {
        statusCode: 503, code: "PRACTICE_PROVIDERS_UNAVAILABLE",
      });
    }
  };
  // Validation rejections and provider availability use separate handoffs.
  generate.canStartOpenAIValidationRepair = canStartOpenAI;
  generate.startOpenAIValidationRepair = (request) => startOpenAI("validation", request);
  return generate;
}
