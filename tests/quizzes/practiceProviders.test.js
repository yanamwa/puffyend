import assert from "node:assert/strict";
import { after, test } from "node:test";
import timers from "node:timers/promises";
import axios from "axios";
import { db } from "../../src/db.js";
import { createPracticeJsonGenerator } from "../../src/services/rag/aiProviderService.js";
import { generatePracticeQuestions } from "../../src/services/quizzes/modulePracticeService.js";

after(() => db.end());

const request = {
  instruction: "Build a lesson-grounded response.",
  data: { evidence: "private lesson text" },
  schema: {
    type: "OBJECT",
    properties: { questions: { type: "ARRAY", items: { type: "STRING", enum: ["Median"] } } },
    required: ["questions"],
  },
  maxAttempts: 3,
  timeoutMs: 45000,
};
const valid = { questions: ["Median"] };
const gemini = (value = valid) => ({
  data: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] },
});
const openai = (value = valid) => ({
  data: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] },
});
const http = (status, body = {}, headers = {}) =>
  Object.assign(new Error("upstream diagnostic with private lesson text"), {
    response: { status, data: { error: body }, headers },
  });

function mockProviders(t, respond) {
  const env = {
    GEMINI_API_KEY: "test-primary-secret",
    OPENAI_API_KEY: "test-backup-secret",
    GEMINI_MODEL: "test-" + t.name,
    OPENAI_MODEL: "test-structured-model",
  };
  for (const [name, value] of Object.entries(env)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
  const now = Date.now();
  let elapsed = 0;
  const waits = [], calls = [], logs = [];
  t.mock.method(Date, "now", () => now + elapsed);
  t.mock.method(timers, "setTimeout", async (ms, _, { signal }) => {
    signal?.throwIfAborted();
    waits.push(ms);
    elapsed += ms;
  });
  for (const method of ["info", "warn"])
    t.mock.method(console, method, (...args) => logs.push(args));
  t.mock.method(axios, "post", async (url, payload, options) => {
    const provider = new URL(url).host === "api.openai.com" ? "openai" : "gemini";
    calls.push({ provider, url, payload, options });
    return respond(provider, payload, options);
  });
  return { waits, calls, logs, providers: () => calls.map((call) => call.provider) };
}

test("a healthy Gemini response completes without a backup key or a second call", async (t) => {
  const mock = mockProviders(t, () => gemini());
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(await createPracticeJsonGenerator()(request), valid);
  assert.deepEqual(mock.providers(), ["gemini"]);
  assert.deepEqual(mock.waits, []);
});

test("503 retries at one and two seconds, then uses strict OpenAI JSON for the rest of this quiz", async (t) => {
  let primaryHealthy = false;
  const mock = mockProviders(t, (provider) => {
    if (provider === "openai") return openai();
    if (primaryHealthy) return gemini();
    throw http(503);
  });
  const generate = createPracticeJsonGenerator();
  const options = { ...request, signal: new AbortController().signal, deadlineAt: Date.now() + 240000 };
  assert.deepEqual(await generate(options), valid);
  assert.deepEqual(mock.waits, [1000, 2000]);
  assert.deepEqual(mock.providers(), ["gemini", "gemini", "gemini", "openai"]);
  const backup = mock.calls.at(-1);
  assert.equal(backup.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(backup.payload.model, process.env.OPENAI_MODEL);
  assert.equal(backup.payload.store, false);
  assert.equal(backup.options.signal, options.signal);
  assert.equal(backup.options.timeout, 45000);
  assert.equal(backup.options.headers.Authorization, "Bearer " + process.env.OPENAI_API_KEY);
  assert.deepEqual(backup.payload.response_format, {
    type: "json_schema",
    json_schema: {
      name: "practice_response", strict: true,
      schema: {
        type: "object", additionalProperties: false, required: ["questions"],
        properties: { questions: { type: "array", items: { type: "string", enum: ["Median"] } } },
      },
    },
  });
  assert.deepEqual(JSON.parse(backup.payload.messages[1].content), request.data);
  assert.match(backup.payload.messages[0].content, /untrusted evidence/);
  primaryHealthy = true;
  await generate(options);
  await createPracticeJsonGenerator()(options);
  assert.deepEqual(mock.providers().slice(-2), ["openai", "gemini"]);
  assert.deepEqual(mock.logs.filter(([label]) => label === "[Gemini JSON] Request failed").map(([, d]) => (
    [d.attempt, d.status, d.errorCode, d.aborted, typeof d.durationMs]
  )), [1, 2, 3].map((n) => [n, 503, "PROVIDER_UNAVAILABLE", false, "number"]));
  assert.doesNotMatch(JSON.stringify(mock.logs), /private lesson text|test-primary-secret|test-backup-secret/);
});

test("429 honors short Google retry guidance and shares a long Retry-After across jobs", async (t) => {
  let primaryCalls = 0;
  const mock = mockProviders(t, (provider) => {
    if (provider === "openai") return openai();
    primaryCalls++;
    if (primaryCalls === 1) throw http(429, { details: [{ retryDelay: "2.5s" }] });
    if (primaryCalls === 2) return gemini();
    throw http(429, {}, { "retry-after": "90" });
  });
  const generate = createPracticeJsonGenerator();
  await generate(request);
  assert.deepEqual(mock.providers(), ["gemini", "gemini"]);
  assert.deepEqual(mock.waits, [2500]);
  await generate(request);
  await createPracticeJsonGenerator()(request);
  assert.deepEqual(mock.providers(), ["gemini", "gemini", "gemini", "openai", "openai"]);
  assert.deepEqual(mock.waits, [2500]);
});

test("an unavailable backup leaves a bounded Gemini-only policy", async (t) => {
  const mock = mockProviders(t, () => { throw http(503); });
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(createPracticeJsonGenerator()(request), { statusCode: 503, code: "PROVIDER_UNAVAILABLE" });
  assert.deepEqual(mock.providers(), ["gemini", "gemini", "gemini"]);
});

test("billing, invalid credentials and a single request timeout go directly to the backup", async (t) => {
  let failure;
  const mock = mockProviders(t, (provider) => {
    if (provider === "openai") return openai();
    throw failure;
  });
  for (const [error, code] of [
    [http(400, { message: "API key not valid", details: [{ reason: "API_KEY_INVALID" }] }), "PROVIDER_KEY_REJECTED"],
    [http(403, { message: "Billing must be enabled" }), "PROVIDER_BILLING"],
    [http(429, { message: "Quota exceeded, limit: 0" }), "PROVIDER_QUOTA"],
    [Object.assign(new Error(), { code: "ECONNABORTED" }), "PROVIDER_REQUEST_TIMEOUT"],
  ]) {
    failure = error;
    assert.deepEqual(await createPracticeJsonGenerator()(request), valid);
    assert.deepEqual(mock.providers().slice(-2), ["gemini", "openai"]);
    assert.ok(mock.logs.some(([, detail]) => detail.errorCode === code));
  }
  assert.deepEqual(mock.waits, []);
});

test("a transient network error can recover on Gemini, and an upstream 422 is never treated as an outage", async (t) => {
  let calls = 0;
  const mock = mockProviders(t, () => {
    ++calls;
    if (calls === 1) throw Object.assign(new Error(), { code: "ECONNRESET" });
    if (calls === 2) return gemini();
    throw http(422);
  });
  const generate = createPracticeJsonGenerator();
  await generate(request);
  await assert.rejects(generate(request), { statusCode: 502, code: "PROVIDER_REQUEST_REJECTED" });
  assert.deepEqual(mock.providers(), ["gemini", "gemini", "gemini"]);
  assert.deepEqual(mock.waits, [1000]);
});

test("both unavailable providers produce a controlled error without a second OpenAI attempt", async (t) => {
  const mock = mockProviders(t, (provider) => { throw http(provider === "gemini" ? 401 : 503); });
  await assert.rejects(createPracticeJsonGenerator()(request), { statusCode: 503, code: "PRACTICE_PROVIDERS_UNAVAILABLE" });
  assert.deepEqual(mock.providers(), ["gemini", "openai"]);
});

test("malformed, incomplete, refused or missing OpenAI output cannot become a question set", async (t) => {
  let choice;
  const mock = mockProviders(t, () => ({ data: { choices: [choice] } }));
  delete process.env.GEMINI_API_KEY;
  for (const [content, reason, refusal, code] of [
    ["not JSON", "stop", null, "GENERATION_INVALID_OUTPUT"],
    ['{"other":[]}', "stop", null, "GENERATION_INVALID_OUTPUT"],
    ['{"questions":{}}', "stop", null, "GENERATION_INVALID_OUTPUT"],
    [JSON.stringify(valid), "length", null, "GENERATION_INCOMPLETE"],
    [null, "stop", "refused", "GENERATION_INCOMPLETE"],
  ]) {
    choice = { finish_reason: reason, message: { content, refusal } };
    await assert.rejects(createPracticeJsonGenerator()(request), { statusCode: 502, code });
  }
  assert.deepEqual(mock.providers(), Array(5).fill("openai"));
});

test("a cancelled deadline prevents fallback, including during retry backoff", async (t) => {
  let controller = new AbortController();
  const mock = mockProviders(t, () => { throw http(503); });
  controller.abort();
  const generate = createPracticeJsonGenerator();
  await assert.rejects(generate({ ...request, signal: controller.signal }), { code: "GENERATION_TIMEOUT" });
  assert.deepEqual(mock.providers(), []);
  controller = new AbortController();
  t.mock.method(timers, "setTimeout", async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  await assert.rejects(generate({ ...request, signal: controller.signal }), { code: "GENERATION_TIMEOUT" });
  assert.deepEqual(mock.providers(), ["gemini"]);
});

test("the remaining deadline reserves time for OpenAI and bounds its in-flight request", async (t) => {
  const controller = new AbortController();
  let started;
  const fallbackStarted = new Promise((resolve) => { started = resolve; });
  const mock = mockProviders(t, (provider, _, { signal }) => {
    if (provider === "gemini") throw http(503);
    started();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = createPracticeJsonGenerator()({ ...request, deadlineAt: Date.now() + 20000, signal: controller.signal });
  await fallbackStarted;
  assert.deepEqual(mock.calls.map(({ options }) => options.timeout), [10000, 20000]);
  assert.deepEqual(mock.waits, []);
  controller.abort();
  await assert.rejects(pending, { code: "GENERATION_TIMEOUT" });
  await assert.rejects(createPracticeJsonGenerator()({ ...request, deadlineAt: Date.now() + 4999 }), { code: "GENERATION_TIMEOUT" });
  assert.deepEqual(mock.providers(), ["gemini", "openai", "gemini"]);
});

test("OpenAI drafts and reviews use the same evidence, history, and slot repair as Gemini", async (t) => {
  const old = "What is the middle value in a sorted list called?";
  const paraphrase = "Which term names the central value after the numbers are ordered?";
  const unsupported = "Which measure predicts tomorrow's journey time?";
  const revisit = "Four trips took 10, 12, 13 and 65 minutes. Which measure resists the effect of the longest trip?";
  const lesson = {
    id: "statistics", title: "Describing commute times",
    learningObjectives: "Choose and interpret the median for a skewed set of travel times.",
    lessonPages: [{ title: "Typical trips", content:
      "The median is the middle of sorted observations. For an even count it is the mean of the two middle values. " +
      "An extreme value pulls the mean toward it; the median resists that effect. Four trips took 10, 12, 13 and 65 minutes." }],
  };
  const skills = [];
  const draftSizes = [], reviewSizes = [];
  const mock = mockProviders(t, (provider, payload) => {
    if (provider === "gemini") throw http(403);
    const { schema } = payload.response_format.json_schema;
    const data = JSON.parse(payload.messages[1].content);
    if (schema.properties.verdicts) {
      reviewSizes.push(data.questions.length);
      return openai({ verdicts: data.questions.map(({ question, question_index }) => ({
        question_index,
        supported: ![unsupported, paraphrase].includes(question),
        reason: question === paraphrase ? "Repeats the previous definition." : "Check the cited facts.",
      })) });
    }
    draftSizes.push(data.types.length);
    const first = draftSizes.length === 1;
    const questions = data.assigned_slots.map((slot, index) => {
      const stem = first ? [old, paraphrase, unsupported, revisit][index] : undefined;
      const type = slot.type;
      return {
        question: stem || `Statistics check ${first ? "original" : "replacement"} ${index}?`,
        type,
        options: type === "multiple_choice" ? ["Median", "Mean", "Range", "Mode"] :
          type === "true_false" ? ["True", "False"] : [],
        correct_answer: type === "true_false" ? "True" : "Median",
        explanation: "The median resists the effect of an extreme observation.",
        topic: slot.topic || "Measures of center", concept: slot.concept || "Median",
        thinking_skill: slot.thinking_skill, cognitive_level: slot.allowed_cognitive_levels[0],
        evidence_ids: [data.evidence[0].evidence_id],
      };
    });
    skills.push(schema.properties.questions.items);
    return openai({ questions });
  });
  const result = await generatePracticeQuestions(lesson, [{
    question: old, topic: "Measures of center", concept: "Median",
    userAnswer: "Mean", correctAnswer: "Median", isCorrect: false,
  }], [old]);
  assert.deepEqual(mock.providers(), ["gemini", "openai", "openai", "openai", "openai"]);
  assert.deepEqual(draftSizes, [10, 3]);
  assert.deepEqual(reviewSizes, [9, 3]);
  assert.equal(result.length, 10);
  assert.deepEqual(skills[0].required, Object.keys(skills[0].properties));
  assert.equal(skills[0].additionalProperties, false);
  assert.deepEqual(skills[0].properties.evidence_ids.items.enum, ["E1"]);
  assert.deepEqual(skills[0].properties.type.enum, ["multiple_choice", "true_false", "identification"]);
  assert.deepEqual(result.filter((q) => [old, unsupported, paraphrase].includes(q.question)), []);
  assert.equal(result.filter((q) => q.question.includes("replacement")).length, 3);
  const approved = result.find((q) => q.question === revisit);
  assert.equal(approved.concept, "Median");
  assert.equal(approved.correct_answer, "Median");
  assert.ok(approved.source_chunks[0].quote.includes("65 minutes"));
  assert.equal(approved.grounding.model_review_passed, true);
  const correction = JSON.parse(mock.calls[3].payload.messages[1].content);
  assert.match(correction.correction, /Duplicate quiz question/);
  assert.match(correction.correction, /Repeats the previous definition/);
  assert.ok(correction.previous_questions.includes(revisit));
});
