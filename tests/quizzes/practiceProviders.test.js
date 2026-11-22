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
  return {
    waits, calls, logs, providers: () => calls.map((call) => call.provider),
    advanceTime(ms) { elapsed += ms; },
  };
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
    throw http(422, { message: "Invalid billing field in the structured request." });
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

const statisticsLesson = {
  id: "statistics", title: "Describing commute times",
  learningObjectives: "Choose and interpret the median for a skewed set of travel times.",
  lessonPages: [{ title: "Typical trips", content:
    "The median is the middle of sorted observations. For an even count it is the mean of the two middle values. " +
    "An extreme value pulls the mean toward it; the median resists that effect. Four trips took 10, 12, 13 and 65 minutes." }],
};

function statisticsQuestion(slot, data, stem) {
  return {
    question_number: slot.question_number,
    learning_objective: slot.learning_objective || data.learning_objectives[slot.question_number % data.learning_objectives.length],
    question: stem, type: slot.type,
    options: slot.type === "multiple_choice" ? ["Median", "Mean", "Range", "Mode"] :
      slot.type === "true_false" ? ["True", "False"] : [],
    correct_answer: slot.type === "true_false" ? "True" : "Median",
    explanation: "The median resists the effect of an extreme observation.",
    topic: slot.topic || "Measures of center", concept: slot.concept || "Median",
    thinking_skill: slot.thinking_skill, cognitive_level: slot.allowed_cognitive_levels[0],
    evidence_ids: [data.evidence[0].evidence_id],
  };
}

test("OpenAI drafts and reviews use the same evidence, history, and slot repair as Gemini", async (t) => {
  const old = "What is the middle value in a sorted list called?";
  const paraphrase = "Which term names the central value after the numbers are ordered?";
  const unsupported = "Which measure predicts tomorrow's journey time?";
  const revisit = "Four trips took 10, 12, 13 and 65 minutes. Which measure resists the effect of the longest trip?";
  const skills = [];
  const draftSizes = [], reviewSizes = [];
  const mock = mockProviders(t, (provider, payload) => {
    if (provider === "gemini") throw http(403);
    const { schema } = payload.response_format.json_schema;
    const data = JSON.parse(payload.messages[1].content);
    if (schema.properties.verdicts) {
      reviewSizes.push(data.questions.length);
      return openai({ verdicts: data.questions.map(({ question, question_index, question_number }) => ({
        question_index,
        question_number,
        supported: ![unsupported, paraphrase].includes(question),
        reason: question === paraphrase ? "Repeats the previous definition." : "Check the cited facts.",
      })) });
    }
    draftSizes.push(data.types.length);
    const first = draftSizes.length === 1;
    const questions = data.assigned_slots.map((slot, index) => {
      const stem = first ? [old, paraphrase, unsupported, revisit][index] : undefined;
      return statisticsQuestion(slot, data, stem || `Statistics check ${first ? "original" : "replacement"} ${index}?`);
    });
    skills.push(schema.properties.questions.items);
    return openai({ questions });
  });
  const result = await generatePracticeQuestions(statisticsLesson, [{
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

// Both providers respond over the normal HTTP adapters. Gemini's first review
// approves eight slots. Its next repair still has an unsupported and a missing slot.
const unsupportedExplanation = "The mean is unaffected by an extreme observation.";
function mockStalledPractice(t, changeResponse) {
  const exchanges = [];
  const drafts = { gemini: 0, openai: 0 };
  const mock = mockProviders(t, (provider, payload, options) => {
    const data = JSON.parse(provider === "gemini" ? payload.contents[0].parts[0].text : payload.messages[1].content);
    const phase = data.questions ? "review" : "draft";
    if (phase === "draft") drafts[provider]++;
    const turn = drafts[provider];
    let response;
    if (phase === "draft") {
      const questions = data.assigned_slots.map((slot) => {
        const q = statisticsQuestion(slot, data, `${provider} example ${turn}.${slot.question_number}?`);
        if (provider === "gemini" && slot.question_number === 1) q.explanation = unsupportedExplanation;
        if (provider === "gemini" && slot.question_number === 8) q.correct_answer = "Range";
        return q;
      });
      response = { questions: provider === "gemini" && turn === 2
        ? questions.filter((q) => q.question_number !== 8) : questions };
    } else {
      response = { verdicts: data.questions.map((q) => {
        const reason = q.explanation === unsupportedExplanation ? "The explanation claims the mean is unaffected." :
          q.correct_answer === "Range" ? "The answer is unsupported." : "";
        return {
          question_index: q.question_index, question_number: q.question_number, supported: !reason,
          reason_code: q.explanation === unsupportedExplanation ? "incorrect_explanation" : reason ? "unsupported_answer" : "supported",
          reason: reason ? `Draft ${turn}: ${reason}` : "",
        };
      }) };
    }
    exchanges.push({ provider, phase, data, options });
    changeResponse?.({ provider, phase, turn, response, data });
    return provider === "gemini" ? gemini(response) : openai(response);
  });
  const lesson = { ...statisticsLesson, learningObjectives: [
    statisticsLesson.learningObjectives, "Identify the middle of an ordered set.",
  ] };
  const miss = { question: "Which statistic resists outliers?", topic: "Measures of center",
    concept: "Median", isCorrect: false, userAnswer: "Mean", correctAnswer: "Median" };
  const events = () => mock.logs.filter(([label]) => label === "[Practice validation]").map(([, line]) => JSON.parse(line));
  return { ...mock, exchanges, events,
    generate: (options) => generatePracticeQuestions(lesson, [miss], [miss.question], options) };
}

test("OpenAI repairs and independently reviews only two slots after Gemini exhausts validation with eight approved", async (t) => {
  const fixture = mockStalledPractice(t);
  const result = await fixture.generate();
  const { exchanges } = fixture;
  const numbers = (slots) => slots.map((s) => s.question_number);
  const all = Array.from({ length: 10 }, (_, i) => i + 1);
  const gaps = [1, 8];
  assert.deepEqual(fixture.providers(), [...Array(4).fill("gemini"), "openai", "openai"]);
  assert.deepEqual(exchanges.map(({ data }) => numbers(data.assigned_slots)),
    [all, all, gaps, [1], gaps, gaps]);
  const [draft, review] = exchanges.slice(-2).map((e) => e.data);
  assert.deepEqual(numbers(review.questions), gaps);
  assert.equal(exchanges.at(-1).phase, "review");
  assert.deepEqual(draft.repair_feedback.map(({ question_number, reason }) => [question_number, reason]), [
    [1, "Draft 2: The explanation claims the mean is unaffected."], [8, "Question 8 is missing from the draft."],
  ]);
  assert.deepEqual(draft.repair_feedback.map((f) => f.draft.question), ["gemini example 2.1?", "gemini example 1.8?"]);
  assert.deepEqual(draft.evidence, exchanges[0].data.evidence);
  const firstReview = exchanges[1].data;
  const assignments = firstReview.assigned_slots.filter((s) => gaps.includes(s.question_number));
  assert.deepEqual(draft.assigned_slots.map((s) => [s.type, s.thinking_skill, s.allowed_cognitive_levels,
    s.learning_objective, s.topic, s.concept]), assignments.map((s) => [s.type, s.thinking_skill,
    [s.cognitive_level], s.learning_objective, s.topic, s.concept]));
  assert.deepEqual(draft.thinking_skills, ["HOTS", "LOTS"]);
  const retained = firstReview.questions.filter((q) => !gaps.includes(q.question_number));
  assert.deepEqual(draft.previous_questions, [...exchanges[0].data.previous_questions, ...retained.map((q) => q.question)]);
  assert.deepEqual(review.previous_questions, draft.previous_questions);
  assert.equal(result.length, 10);
  for (const { question_number, question_index, ...q } of [...retained, ...review.questions]) {
    const { id, source_question_index, ...saved } = result.find((item) => item.source_question_index === question_number - 1);
    assert.equal(q.grounding.model_review_passed, false);
    assert.ok(q.source_chunks[0].quote);
    assert.deepEqual(saved, { ...q, grounding: { ...q.grounding, model_review_passed: true } });
  }
  assert.deepEqual(fixture.waits, []);
  assert.equal(fixture.events().find((e) => e.event === "openai_validation_repair").reason, "no_progress");
});

test("OpenAI validation repair keeps new approvals, rejects duplicates and stops on an unsupported final explanation", async (t) => {
  const fixture = mockStalledPractice(t, ({ provider, phase, turn, response, data }) => {
    if (provider !== "openai" || phase !== "draft") return;
    if (turn === 1) response.questions[0].question = data.previous_questions.at(-1);
    else response.questions[0].explanation = unsupportedExplanation;
  });
  await assert.rejects(fixture.generate(), { statusCode: 422, code: "QUIZ_REVIEW_REJECTED" });
  const backup = fixture.exchanges.filter((e) => e.provider === "openai");
  assert.deepEqual(backup.map(({ phase, data }) => [phase, data.assigned_slots.map((s) => s.question_number)]),
    [["draft", [1, 8]], ["review", [8]], ["draft", [1]], ["review", [1]]]);
  assert.match(backup[2].data.repair_feedback[0].reason, /Duplicate quiz question/);
  assert.ok(backup[2].data.previous_questions.includes(backup[1].data.questions[0].question));
  const events = fixture.logs.filter(([label]) => label === "[Practice validation]").map(([, line]) => JSON.parse(line));
  assert.equal(events.at(-1).passed, 9);
  assert.equal(events.at(-1).stop, "openai_repair_limit");
  assert.doesNotMatch(JSON.stringify(fixture.logs), /mean is unaffected|gemini example|test-backup-secret/);
});

test("OpenAI repairs must pass the evidence, answer-key, type and LOTS/HOTS checks before review", async (t) => {
  const fixture = mockStalledPractice(t, ({ provider, phase, turn, response }) => {
    if (provider !== "openai" || phase !== "draft") return;
    const [hots, lots] = response.questions;
    if (turn === 1) {
      hots.correct_answer = "A value outside the options";
      lots.evidence_ids = ["unknown"];
    } else {
      hots.thinking_skill = "LOTS";
      lots.type = "true_false";
    }
  });
  await assert.rejects(fixture.generate(), { statusCode: 422 });
  assert.deepEqual(fixture.exchanges.filter((e) => e.provider === "openai").map((e) => e.phase), ["draft", "draft"]);
  const events = fixture.logs.filter(([label]) => label === "[Practice validation]").map(([, line]) => JSON.parse(line));
  const [first, second, stop] = events.slice(-3);
  assert.deepEqual(first.rejected, { invalid_option_key: [1], unknown_evidence: [8] });
  assert.deepEqual(second.rejected, { wrong_thinking_skill: [1], wrong_type: [8] });
  assert.equal(stop.passed, 8);
});

test("eight approvals and two gaps finish at 234 seconds with a reserved OpenAI draft and review", async (t) => {
  const durations = [30_000, 28_000, 43_000, 44_000, 44_000, 45_000];
  const fixture = mockStalledPractice(t, () => fixture.advanceTime(durations.shift()));
  const jobId = "185a574a-101e-4a8f-9671-ff09b8988166";
  const result = await fixture.generate({ jobId });
  assert.deepEqual(durations, []);
  assert.deepEqual(fixture.providers(), ["gemini", "gemini", "gemini", "gemini", "openai", "openai"]);
  const handoff = fixture.events().find((e) => e.event === "openai_validation_repair");
  assert.equal(handoff.reason, "time_budget");
  assert.equal(handoff.remainingMs, 95_000);
  assert.equal(handoff.reservedMs, 90_000);
  assert.equal(handoff.passed, 8);
  const backup = fixture.exchanges.slice(-2);
  assert.deepEqual(backup.map(({ phase, data }) => [phase, data.assigned_slots.map((s) => s.question_number)]),
    [["draft", [1, 8]], ["review", [1, 8]]]);
  assert.ok(backup.every((e) => e.options.timeout === 45_000));
  assert.equal(result.filter((q) => q.question.startsWith("gemini example 1.")).length, 8);
  assert.equal(result.filter((q) => q.question.startsWith("openai example 1.")).length, 2);
  assert.ok(result.every((q) => q.grounding.model_review_passed && q.grounding.exact_quotes_verified));
  const summary = fixture.events().at(-1);
  assert.equal(summary.jobId, jobId);
  assert.equal(summary.initialGenerationMs, 30_000);
  assert.equal(summary.reviewMs, 117_000);
  assert.equal(summary.repairMs, 87_000);
  assert.equal(summary.approvedCount, 10);
  assert.equal(summary.rejectedCount, 0);
  assert.equal(summary.remainingMs, 6_000);
  assert.equal(summary.stop, "all_slots_verified");
  assert.doesNotMatch(JSON.stringify(fixture.logs), /example 1\.|mean is unaffected|test-primary-secret|test-backup-secret/);
});

for (const overrun of [false, true]) {
  test(`a reclaimed job shares its last 30 seconds between the two OpenAI slots and their review (overrun=${overrun})`, async (t) => {
    const durations = [6_000, 4_000, 12_000, overrun ? 18_001 : 17_000];
    const fixture = mockStalledPractice(t, () => fixture.advanceTime(durations.shift()));
    // The worker's original deadline is 40 seconds away when generation starts.
    const pending = fixture.generate({ deadlineAt: Date.now() + 40_000 });
    if (overrun) await assert.rejects(pending, { statusCode: 503, code: "GENERATION_TIMEOUT" });
    else assert.equal((await pending).length, 10);
    assert.deepEqual(fixture.providers(), ["gemini", "gemini", "openai", "openai"]);
    const [draft, review] = fixture.exchanges.slice(-2);
    assert.deepEqual(draft.data.assigned_slots.map((s) => s.question_number), [1, 8]);
    assert.deepEqual(review.data.questions.map((q) => q.question_number), [1, 8]);
    assert.deepEqual([draft.options.timeout, review.options.timeout], [15_000, 18_000]);
    const summary = fixture.events().at(-1);
    assert.equal(summary.stop, overrun ? "deadline" : "all_slots_verified");
    assert.equal(summary.remainingMs, overrun ? 0 : 1_000);
    assert.equal(summary.approvedCount, overrun ? 8 : 10);
    assert.equal(summary.rejectedCount, overrun ? 2 : 0);
  });
}

test("a late Gemini repair cannot consume the reservation or restart already verified slots", async (t) => {
  const fixture = mockStalledPractice(t, ({ provider, phase, turn }) => {
    if (provider !== "gemini") return;
    if (turn === 1) fixture.advanceTime(phase === "draft" ? 30_000 : 28_000);
    else fixture.advanceTime(47_001); // Beyond the Gemini draft cutoff, inside the job deadline.
  });
  const result = await fixture.generate();
  assert.deepEqual(fixture.providers(), ["gemini", "gemini", "gemini", "openai", "openai"]);
  const [draft, review] = fixture.exchanges.slice(-2);
  assert.deepEqual(draft.data.repair_feedback.map((f) => [f.question_number, f.reason]), [
    [1, "Draft 1: The explanation claims the mean is unaffected."], [8, "Draft 1: The answer is unsupported."],
  ]);
  assert.deepEqual(review.data.questions.map((q) => q.question_number), [1, 8]);
  assert.equal(result.filter((q) => q.question.startsWith("gemini example 1.")).length, 8);
  assert.ok(result.every((q) => q.grounding.model_review_passed));
  assert.equal(fixture.events().find((e) => e.event === "openai_validation_repair").reason, "time_budget");
});

test("time is rechecked between Gemini repair groups and OpenAI receives every outstanding slot in one batch", async (t) => {
  const durations = [20_000, 18_000, 23_000, 20_000];
  const fixture = mockStalledPractice(t, ({ provider, phase, turn, response }) => {
    if (provider !== "gemini") return;
    fixture.advanceTime(durations.shift());
    if (turn === 1 && phase === "review") {
      for (const verdict of response.verdicts) Object.assign(verdict, {
        supported: false, reason_code: "unsupported_answer", reason: "Explain the answer using the cited passage.",
      });
    }
  });
  const result = await fixture.generate();
  const groups = fixture.exchanges.map(({ data }) => data.assigned_slots.map((s) => s.question_number));
  assert.deepEqual(fixture.providers(), ["gemini", "gemini", "gemini", "gemini", "openai", "openai"]);
  assert.deepEqual(groups.slice(2), [
    [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 6, 7, 8, 9, 10], [1, 6, 7, 8, 9, 10],
  ]);
  assert.equal(result.filter((q) => q.question.startsWith("gemini example 2.")).length, 4);
  assert.ok(result.every((q) => q.grounding.model_review_passed));
});

test("too little time for both OpenAI calls preserves the validation failure without starting a draft", async (t) => {
  const fixture = mockStalledPractice(t, ({ phase }) => fixture.advanceTime(phase === "draft" ? 2_000 : 4_500));
  await assert.rejects(fixture.generate({ deadlineAt: Date.now() + 15_000 }), {
    statusCode: 422, code: "QUIZ_REVIEW_REJECTED",
  });
  assert.deepEqual(fixture.providers(), ["gemini", "gemini"]);
  const summary = fixture.events().at(-1);
  assert.equal(summary.stop, "insufficient_repair_time");
  assert.equal(summary.rejectedCount, 2);
  assert.equal(summary.remainingMs, 8_500);
});

test("cancellation during the OpenAI repair draft stops its request and suppresses the review", async (t) => {
  const job = new AbortController();
  const fixture = mockStalledPractice(t, ({ provider }) => {
    if (provider === "openai") job.abort();
  });
  await assert.rejects(fixture.generate({ signal: job.signal }), { statusCode: 503, code: "GENERATION_TIMEOUT" });
  assert.deepEqual(fixture.providers(), ["gemini", "gemini", "gemini", "gemini", "openai"]);
  assert.ok(fixture.exchanges.every(({ options }) => options.signal.aborted));
  assert.equal(fixture.events().at(-1).stop, "cancelled");
});

test("without an OpenAI key, exhausted Gemini validation remains a 422", async (t) => {
  const fixture = mockStalledPractice(t);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(fixture.generate(), { statusCode: 422 });
  assert.deepEqual(fixture.providers(), Array(8).fill("gemini"));
});

test("an OpenAI outage after Gemini validation exhaustion reports only the OpenAI failure", async (t) => {
  const fixture = mockStalledPractice(t, ({ provider }) => {
    if (provider === "openai") throw http(503);
  });
  await assert.rejects(fixture.generate(), { statusCode: 503, code: "PROVIDER_UNAVAILABLE" });
  assert.deepEqual(fixture.providers(), [...Array(4).fill("gemini"), "openai"]);
});

test("a practice already using OpenAI after a Gemini outage cannot restart OpenAI's repair budget", async (t) => {
  const fixture = mockStalledPractice(t, ({ provider, phase, response }) => {
    if (provider === "gemini") throw http(403);
    if (phase === "draft") response.questions[0].explanation = unsupportedExplanation;
  });
  await assert.rejects(fixture.generate(), { statusCode: 422, code: "QUIZ_REVIEW_REJECTED" });
  assert.deepEqual(fixture.providers(), ["gemini", ...Array(8).fill("openai")]);
});
