import { generateJson } from "./geminiJson.js";
import { generateOpenAIJson } from "./openaiJson.js";
import { remainingTime, withEarlierDeadline } from "./jsonProviderRequest.js";

const policies = {
  syllabus: { env: "SYLLABUS_AI_PRIMARY", budget: 110_000, rounds: 3 },
  organize: { env: "ORGANIZE_MODULE_AI_PRIMARY", budget: 480_000, rounds: 3 },
  main: { env: "MAIN_QUIZ_AI_PRIMARY", budget: 180_000, rounds: 4 },
};
const recoverable = new Set([
  "GENERATION_INVALID_OUTPUT",
  "GENERATION_INCOMPLETE",
  "GENERATION_TIMEOUT",
  "PROVIDER_BILLING",
  "PROVIDER_QUOTA",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_PERMISSION",
  "PROVIDER_MODEL",
  "PROVIDER_KEY_REJECTED",
  "PROVIDER_NETWORK",
  "PROVIDER_REQUEST_TIMEOUT",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
]);
const providers = { openai: generateOpenAIJson, gemini: generateJson };
export const string = { type: "STRING" };
export const integer = { type: "INTEGER" };
export const array = (items) => ({ type: "ARRAY", items });
export const object = (properties) => ({
  type: "OBJECT",
  properties,
  required: Object.keys(properties),
});

export function academicPrimary(workflow) {
  return process.env[policies[workflow].env]?.trim().toLowerCase() === "gemini"
    ? "gemini"
    : "openai";
}

export function createAcademicWorkflow(
  name,
  { count = 1, send = providers, deadlineAt } = {},
) {
  const primary = academicPrimary(name);
  const secondary = primary === "openai" ? "gemini" : "openai";
  const budget = policies[name].budget + (name === "main" ? 4_000 * count : 0);
  const deadline = deadlineAt ?? Date.now() + budget;
  const primaryCutoff =
    deadline - Math.min(90_000, Math.max(1, (deadline - Date.now()) * 0.25));
  const durations = { generation: 0, review: 0, repair: 0 };
  const categories = new Set();
  const responseProviders = new WeakMap();
  const modelFor = (provider) =>
    provider === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-2.5-flash"
      : process.env.OPENAI_MODEL || "gpt-4.1-mini";
  let current = primary,
    approved = 0,
    rejected = 0,
    lastProvider;
  const left = () => remainingTime({ deadlineAt: deadline });
  const session = {
    rounds: policies[name].rounds,
    primary,
    deadline,
    left,
    get model() {
      return modelFor(lastProvider || current);
    },
    reviewedBy(result) {
      return modelFor(responseProviders.get(result) || lastProvider || current);
    },
    async call(phase, request, { fallback = false } = {}) {
      const first =
        fallback || Date.now() >= primaryCutoff ? secondary : current;
      for (const provider of first === primary
        ? [primary, secondary]
        : [secondary]) {
        const remaining = left();
        // Leave room for the second provider and a separate review of its draft.
        const fraction =
          provider === primary ? 0.44 : phase === "review" ? 1 : 0.64;
        const timeout = Math.max(
          1,
          Math.floor(
            Math.min(
              60_000,
              remaining * fraction,
              provider === primary ? primaryCutoff - Date.now() : remaining,
            ),
          ),
        );
        const started = Date.now();
        try {
          const result = await send[provider](
            withEarlierDeadline(
              {
                ...request,
                schemaName: name + "_response",
                maxAttempts: 1,
                timeoutMs: timeout,
              },
              Math.min(deadline, started + timeout),
            ),
          );
          left();
          if (
            !result ||
            !request.schema.required.every((key) => {
              const value = result[key],
                type = request.schema.properties[key].type;
              return type === "ARRAY"
                ? Array.isArray(value)
                : type === "STRING"
                  ? typeof value === "string"
                  : value != null;
            })
          )
            throw Object.assign(new Error("Incomplete structured response."), {
              code: "GENERATION_INVALID_OUTPUT",
            });
          lastProvider = provider;
          responseProviders.set(result, provider);
          return result;
        } catch (error) {
          left();
          if (!recoverable.has(error.code) && !error.retryable) throw error;
          categories.add(
            recoverable.has(error.code) ? error.code : "provider_unavailable",
          );
          if (provider === secondary)
            throw Object.assign(
              new Error(
                "The academic content provider is unavailable. Please try again.",
              ),
              { statusCode: 503, code: "ACADEMIC_PROVIDERS_UNAVAILABLE" },
            );
          current = secondary;
        } finally {
          durations[phase] += Date.now() - started;
          console.info("[Academic AI] request", {
            workflow: name,
            provider,
            phase,
            durationMs: Date.now() - started,
            remainingMs: Math.max(0, deadline - Date.now()),
          });
        }
      }
    },
    record(passed, failed, category = "validation") {
      approved += passed;
      rejected += failed;
      if (failed) categories.add(category);
    },
    finish(stop) {
      console.info("[Academic AI] summary", {
        workflow: name,
        provider: lastProvider || current,
        durations,
        approved,
        rejected,
        categories: [...categories],
        remainingMs: Math.max(0, deadline - Date.now()),
        stop,
      });
    },
  };
  return session;
}

export async function runAcademicWorkflow(name, options, work) {
  const session = createAcademicWorkflow(name, options);
  try {
    const result = await work(session);
    session.left();
    session.finish("completed");
    return result;
  } catch (error) {
    session.finish(
      error.code === "GENERATION_TIMEOUT"
        ? "deadline"
        : error.statusCode === 422
          ? "validation"
          : "failed",
    );
    throw error;
  }
}

const verdictSchema = object({
  verdicts: array(
    object({
      id: integer,
      supported: { type: "BOOLEAN" },
      reason: string,
    }),
  ),
});

// Stable server IDs survive missing, duplicated and reordered provider rows.
// An approved item never appears in a subsequent generation or review request.
export async function reviewedItems(
  session,
  slots,
  { draft, validate, review, failureMessage },
) {
  const accepted = new Map(),
    corrections = new Map(),
    rejectedDrafts = new Map();
  const byId = (rows, id) => {
    const matches = rows.filter((row) => row?.id === id);
    return matches.length === 1 ? matches[0] : null;
  };
  for (
    let round = 0;
    round < session.rounds && accepted.size < slots.length;
    round++
  ) {
    const pending = slots.filter((slot) => !accepted.has(slot.id));
    const request = draft(
      pending.map((slot) => ({
        ...slot,
        rejection: corrections.get(slot.id) || "",
        previous_draft: rejectedDrafts.get(slot.id),
      })),
      [...accepted.values()],
    );
    const options = { fallback: round === session.rounds - 1 };
    const result = await session.call(
      round ? "repair" : "generation",
      request,
      options,
    );
    const candidates = [];
    for (const slot of pending) {
      const row = byId(result.items, slot.id);
      try {
        if (!row)
          throw new Error("Return exactly one item with this assigned ID.");
        const value = validate(row, slot, [
          ...accepted.values(),
          ...candidates.map((c) => c.value),
        ]);
        candidates.push({ slot, value, row });
      } catch (error) {
        corrections.set(slot.id, String(error.message).slice(0, 1000));
        if (row) rejectedDrafts.set(slot.id, row);
      }
    }
    let passed = 0;
    if (candidates.length) {
      const task = review(
        candidates.map(({ slot, value }) => ({ ...slot, candidate: value })),
        [...accepted.values()],
      );
      const { verdicts } = await session.call(
        "review",
        {
          ...task,
          schema: verdictSchema,
          instruction:
            task.instruction +
            " Return exactly one verdict per supplied id. Explain the exact defect for each rejection.",
        },
        options,
      );
      for (const { slot, value, row } of candidates) {
        const verdict = byId(verdicts, slot.id);
        if (verdict?.supported === true) {
          accepted.set(slot.id, value);
          passed++;
        } else {
          corrections.set(
            slot.id,
            String(
              verdict?.reason || "Missing or ambiguous independent verdict.",
            ).slice(0, 1000),
          );
          rejectedDrafts.set(slot.id, row);
        }
      }
    }
    session.record(passed, pending.length - candidates.length, "structure");
    session.record(0, candidates.length - passed, "independent_review");
  }
  if (accepted.size !== slots.length)
    throw Object.assign(new Error(failureMessage), {
      statusCode: 422,
      code: "ACADEMIC_VALIDATION_FAILED",
    });
  return slots.map((slot) => accepted.get(slot.id));
}
