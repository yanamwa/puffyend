import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { db } from "../../src/db.js";
import { generateJson } from "../../src/services/rag/geminiJson.js";
import { generateLessonQuiz } from "../../src/controllers/lessonController.js";
import { getCourseById } from "../../src/controllers/courseController.js";
import {
  validateQuizSettings,
  validateQuizBatch,
  generateQuizBatch,
} from "../../src/services/rag/quizRagService.js";
const settings = {
  assessment_type: "practice",
  question_count: 20,
  multiple_choice_count: 10,
  identification_count: 5,
  true_false_count: 5,
  lots_count: 12,
  hots_count: 8,
};
assert.equal(validateQuizSettings(settings).hotsCount, 8);
for (const change of [
  { multiple_choice_count: 9 },
  { lots_count: 11 },
  { hots_count: -1 },
  { true_false_count: 4.5 },
])
  assert.throws(() => validateQuizSettings({ ...settings, ...change }));
assert.deepEqual(validateQuizSettings({}), {
  questionCount: 5,
  identificationCount: 0,
  difficulty: "medium",
});
const chunks = [
  {
    chunk_id: 1,
    chunk_text:
      "Plants use sunlight to produce their food through photosynthesis.",
    document_id: 1,
    source_filename: "lesson.txt",
  },
];
const question = {
  type: "true_false",
  question: "Plants use sunlight to produce food.",
  options: ["True", "False"],
  correct_answer: "True",
  explanation: "Photosynthesis uses sunlight.",
  topic: "Photosynthesis",
  cognitive_level: "Understand",
  thinking_skill: "LOTS",
  evidence_ids: ["c1-e0"],
};
assert.equal(
  validateQuizBatch({ questions: [question] }, ["true_false"], chunks, [
    "LOTS",
  ])[0].topic,
  "Photosynthesis",
);
for (const change of [
  { options: ["False", "True"] },
  { correct_answer: "yes" },
  { thinking_skill: "HOTS" },
  { cognitive_level: "Evaluate" },
  { topic: "" },
  { evidence_ids: ["unknown"] },
])
  assert.throws(() =>
    validateQuizBatch(
      { questions: [{ ...question, ...change }] },
      ["true_false"],
      chunks,
      ["LOTS"],
    ),
  );
let calls = 0;
const generated = await generateQuizBatch(
  {
    types: ["true_false"],
    skills: ["LOTS"],
    chunks,
    title: "Plants",
    objectives: "Understand photosynthesis",
  },
  async (request) => {
    calls++;
    if (request.schema.properties.questions) {
      assert.match(request.instruction, /educational practice quiz generator/);
      return { questions: [question] };
    }
    return {
      verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
    };
  },
);
assert.equal(calls, 2);
assert.equal(generated[0].thinking_skill, "LOTS");
const normalized = validateQuizBatch(
  {
    questions: [
      {
        ...question,
        thinking_skill: " lots ",
        cognitive_level: " understand ",
      },
    ],
  },
  ["true_false"],
  chunks,
  ["LOTS"],
);
assert.equal(normalized[0].thinking_skill, "LOTS");
assert.equal(normalized[0].cognitive_level, "Understand");
let drafts = 0;
const repaired = await generateQuizBatch(
  { types: ["true_false"], skills: ["LOTS"], chunks },
  async (request) => {
    if (!request.schema.properties.questions)
      return {
        verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
      };
    drafts++;
    assert.deepEqual(request.data.assigned_slots[0].allowed_cognitive_levels, [
      "Remember",
      "Understand",
      "Apply",
    ]);
    assert.deepEqual(
      request.schema.properties.questions.items.properties.thinking_skill.enum,
      ["LOTS"],
    );
    if (drafts === 1)
      return {
        questions: [
          { ...question, thinking_skill: "HOTS", cognitive_level: "Analyze" },
        ],
      };
    assert.match(
      request.data.correction,
      /Question 1: assigned thinking_skill is LOTS/,
    );
    return { questions: [question] };
  },
);
assert.equal(drafts, 2);
assert.equal(repaired[0].thinking_skill, "LOTS");
await assert.rejects(
  () =>
    generateQuizBatch(
      { types: ["true_false"], skills: ["LOTS"], chunks },
      async () => ({
        questions: [{ ...question, cognitive_level: "Analyze" }],
      }),
    ),
  /did not pass validation.*Question 1: cognitive_level must be Remember, Understand, Apply/,
);
console.log(
  "Practice settings, metadata, True/False, evidence, and generation/review checks passed.",
);

await test("duplicate stems and choices are rejected without rejecting shared answers or distinct symbols", () => {
  for (const text of [
    question.question,
    "  PLANTS use sunlight\n to produce food. ",
    "Question 2: Plants use sunlight to produce food?",
    "2. Plants use sunlight to produce food!",
  ]) {
    assert.throws(
      () =>
        validateQuizBatch(
          { questions: [question, { ...question, question: text }] },
          ["true_false", "true_false"],
          chunks,
          ["LOTS", "LOTS"],
        ),
      /Duplicate quiz question/,
    );
  }
  const multipleChoice = {
    ...question,
    type: "multiple_choice",
    options: ["Sunlight", "Water", "Soil", "Air"],
    correct_answer: "Sunlight",
  };
  for (const options of [
    ["Sunlight", "Sunlight", "Soil", "Air"],
    ["Sunlight", " SUNLIGHT ", "Soil", "Air"],
    ["A. Sunlight", " B) sunlight ", "Soil", "Air"],
    ["A.", "Water", "Soil", "Air"],
  ]) {
    assert.throws(
      () =>
        validateQuizBatch(
          {
            questions: [
              { ...multipleChoice, options, correct_answer: options[0] },
            ],
          },
          ["multiple_choice"],
          chunks,
          ["LOTS"],
        ),
      /four distinct nonempty options/,
    );
  }
  assert.equal(
    validateQuizBatch(
      {
        questions: [question, { ...question, question: "Roots absorb water." }],
      },
      ["true_false", "true_false"],
      chunks,
      ["LOTS", "LOTS"],
    ).length,
    2,
  );
  assert.deepEqual(
    validateQuizBatch(
      {
        questions: [
          {
            ...multipleChoice,
            options: ["C", "C++", "x²", "x2"],
            correct_answer: "C",
          },
        ],
      },
      ["multiple_choice"],
      chunks,
      ["LOTS"],
    )[0].options,
    ["C", "C++", "x²", "x2"],
  );
});

await test("short-answer generation repairs questions that require options", async () => {
  let draftCount = 0;
  const result = await generateQuizBatch(
    { types: ["identification"], skills: ["LOTS"], chunks, shortAnswer: true },
    async (request) => {
      if (!request.schema.properties.questions)
        return { verdicts: [{ question_index: 0, supported: true }] };
      draftCount++;
      assert.match(request.instruction, /standalone question/);
      if (draftCount === 2)
        assert.match(request.data.correction, /Remove references to choices/);
      return {
        questions: [
          {
            ...question,
            type: "identification",
            options: [],
            correct_answer: "Photosynthesis",
            question:
              draftCount === 1
                ? "Which of the following processes uses sunlight to produce food?"
                : "What process do plants use to produce food with sunlight?",
          },
        ],
      };
    },
  );
  assert.equal(draftCount, 2);
  assert.equal(
    result[0].question,
    "What process do plants use to produce food with sunlight?",
  );
});

await test("duplicate batches repair within the existing three-draft limit", async () => {
  let drafts = 0,
    reviews = 0;
  const result = await generateQuizBatch(
    { types: ["true_false", "true_false"], skills: ["LOTS", "LOTS"], chunks },
    async (request) => {
      if (request.schema.properties.questions) {
        drafts++;
        if (drafts === 1) return { questions: [question, question] };
        assert.match(request.data.correction, /Duplicate quiz question/);
        assert.equal(request.data.previous_draft.questions.length, 2);
        return {
          questions: [
            question,
            { ...question, question: "Roots absorb water." },
          ],
        };
      }
      reviews++;
      return {
        verdicts: request.data.questions.map((_, index) => ({
          question_index: index,
          supported: true,
          reason: "Supported",
        })),
      };
    },
  );
  assert.equal(result.length, 2);
  assert.equal(drafts, 2);
  assert.equal(reviews, 1);
  drafts = 0;
  await assert.rejects(
    generateQuizBatch(
      { types: ["true_false", "true_false"], skills: ["LOTS", "LOTS"], chunks },
      async () => {
        drafts++;
        return { questions: [question, question] };
      },
    ),
    (error) =>
      error.statusCode === 422 &&
      error.code === "DUPLICATE_QUIZ_QUESTION" &&
      /Duplicate quiz question/.test(error.message),
  );
  assert.equal(drafts, 3);
  let calls = 0;
  const serviceError = Object.assign(new Error("Unavailable"), {
    statusCode: 503,
    retryable: true,
  });
  await assert.rejects(
    generateQuizBatch(
      { types: ["true_false"], skills: ["LOTS"], chunks },
      async () => {
        calls++;
        throw serviceError;
      },
    ),
    (error) => error === serviceError,
  );
  assert.equal(calls, 1);
});

await test("duplicate answer choices are repaired before grounding review", async () => {
  const multipleChoice = {
    ...question,
    type: "multiple_choice",
    options: ["Sunlight", "Water", "Soil", "Air"],
    correct_answer: "Sunlight",
  };
  let drafts = 0,
    reviews = 0;
  const result = await generateQuizBatch(
    { types: ["multiple_choice"], skills: ["LOTS"], chunks },
    async (request) => {
      if (request.schema.properties.questions) {
        drafts++;
        if (drafts === 1)
          return {
            questions: [
              {
                ...multipleChoice,
                options: ["Sunlight", " sunlight ", "Soil", "Air"],
              },
            ],
          };
        assert.match(request.data.correction, /four distinct nonempty options/);
        return { questions: [multipleChoice] };
      }
      reviews++;
      return {
        verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
      };
    },
  );
  assert.equal(drafts, 2);
  assert.equal(reviews, 1);
  assert.deepEqual(result[0].options, multipleChoice.options);
  assert.equal(result[0].correct_answer, "Sunlight");
});

function mockQuizSources(context, generate, { sourceStatus = "ready" } = {}) {
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("FROM courses")) return [[{ course_id: 1 }]];
    if (sql.includes("FROM lesson_source_documents"))
      return [
        [
          {
            document_id: 1,
            filename: "lesson.txt",
            processing_status: sourceStatus,
          },
        ],
      ];
    if (sql.includes("FROM lesson_source_chunks"))
      return [
        [
          {
            ...chunks[0],
            embedding: [1],
            embedding_model: "test-model",
            embedding_dimensions: 1,
          },
        ],
      ];
    throw new Error(`Unexpected database operation: ${sql}`);
  });
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  context.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });
  context.mock.method(axios, "post", async (url, payload) => {
    if (url.endsWith(":batchEmbedContents"))
      return { data: { embeddings: [{ values: [1] }] } };
    assert.match(url, /:generateContent$/);
    const result = await generate({
      schema: payload.generationConfig.responseSchema,
      data: JSON.parse(payload.contents[0].parts[0].text),
    });
    return {
      data: {
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify(result) }] },
          },
        ],
      },
    };
  });
}

function quizResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

await test("Quick Recap uses lesson slides when its source index is unavailable", async (context) => {
  const lessonContent =
    "Leaves absorb sunlight. Roots take in water. Stems move water through plants. Chlorophyll makes leaves green. Photosynthesis releases oxygen.";
  const questions = [
    ["What do leaves absorb?", "Sunlight"],
    ["Which part takes in water?", "Roots"],
    ["Which structure moves water through the plant?", "Stems"],
    ["What gives leaves their green color?", "Chlorophyll"],
    ["Which gas does photosynthesis release?", "Oxygen"],
  ];
  mockQuizSources(
    context,
    ({ schema, data }) => {
      if (!schema.properties.questions) {
        return {
          verdicts: data.questions.map((_, question_index) => ({
            question_index,
            supported: true,
            reason: "Supported",
          })),
        };
      }
      assert.match(data.evidence[0].quote, /Leaves absorb sunlight/);
      return {
        questions: questions.map(([stem, answer]) => ({
          ...question,
          type: "multiple_choice",
          question: stem,
          options: [answer, "Glucose", "Nitrogen", "Carbon dioxide"],
          correct_answer: answer,
          evidence_ids: [data.evidence[0].evidence_id],
        })),
      };
    },
    { sourceStatus: "pending" },
  );
  const body = {
    assessment_type: "recap",
    course_id: 1,
    document_ids: [1],
    lesson_title: "Plants",
    lesson_content: lessonContent,
  };

  const response = quizResponse();
  await generateLessonQuiz(
    { user: { userId: 1, role: "admin" }, body },
    response,
  );
  assert.equal(response.statusCode, 200, response.body.message);
  assert.equal(response.body.assessment_type, "recap");
  assert.equal(response.body.quiz.questions.length, 5);
  assert.deepEqual(response.body.document_ids, []);

  const deniedResponse = quizResponse();
  await generateLessonQuiz(
    { user: { userId: 2, role: "student" }, body },
    deniedResponse,
  );
  assert.equal(deniedResponse.statusCode, 403);
});

for (const exhaust of [false, true]) {
  await test(`concurrent quiz API batches ${exhaust ? "reject exhausted collisions" : "repair collisions before returning the full quiz"}`, async (context) => {
    const firstBatch = [
      question.question,
      "Leaves absorb sunlight.",
      "Roots absorb water.",
      "Stems transport water.",
      "Photosynthesis releases oxygen.",
    ].map((text) => ({ ...question, question: text }));
    let firstDrafts = 0,
      secondDrafts = 0,
      reviews = 0;
    mockQuizSources(context, async (request) => {
      if (request.schema.properties.questions) {
        if (request.data.types.length === 5) {
          firstDrafts++;
          return { questions: firstBatch };
        }
        secondDrafts++;
        if (secondDrafts > 1) {
          assert.match(request.data.correction, /Duplicate quiz question/);
          assert.deepEqual(
            request.data.previous_questions,
            firstBatch.map((item) => item.question),
          );
          assert.equal(
            request.data.previous_draft.questions[0].question,
            question.question,
          );
        }
        return {
          questions: [
            exhaust || secondDrafts === 1
              ? question
              : {
                  ...question,
                  question: "Chlorophyll gives leaves their green color.",
                },
          ],
        };
      }
      reviews++;
      if (reviews === 2) await new Promise(setImmediate);
      return {
        verdicts: request.data.questions.map((_, index) => ({
          question_index: index,
          supported: true,
          reason: "Supported",
        })),
      };
    });
    context.mock.method(console, "error", () => {});
    const response = quizResponse();
    await generateLessonQuiz(
      {
        user: { userId: 1, role: "admin" },
        body: {
          assessment_type: "practice",
          course_id: 1,
          question_count: 6,
          multiple_choice_count: 0,
          true_false_count: 6,
          lots_count: 6,
          hots_count: 0,
        },
      },
      response,
    );
    assert.equal(firstDrafts, 1);
    assert.equal(secondDrafts, exhaust ? 3 : 2);
    if (exhaust) {
      assert.equal(response.statusCode, 422);
      assert.equal(response.body.success, false);
      assert.equal(response.body.quiz, undefined);
      assert.match(
        response.body.message,
        /after two repair attempts.*Duplicate quiz question/,
      );
    } else {
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.generated_count, 6);
      assert.equal(response.body.question_count, 6);
      assert.equal(response.body.true_false_count, 6);
      assert.equal(response.body.lots_count, 6);
      assert.equal(
        new Set(response.body.quiz.questions.map((item) => item.question)).size,
        6,
      );
      assert.deepEqual(
        response.body.quiz.questions.slice(0, 5).map((item) => item.question),
        firstBatch.map((item) => item.question),
      );
      for (const item of response.body.quiz.questions) {
        assert.equal(item.correct_answer, "True");
        assert.equal(item.thinking_skill, "LOTS");
        assert.ok(item.source_chunks.length);
      }
    }
  });
}

await test("saved quiz content is returned once in each course API representation", async (context) => {
  const saved = [question, { ...question, question: "Roots absorb water." }];
  const quizItems = saved.map((item) => ({
    ...item,
    moduleId: "plants",
    moduleIndex: 0,
  }));
  context.mock.method(db, "execute", async (sql) => {
    if (/information_schema\.columns/i.test(sql))
      return [[{ COLUMN_NAME: "course_id" }]];
    if (sql.includes("FROM users")) return [[{ userId: 1, role: "admin" }]];
    if (sql.includes("FROM courses"))
      return [
        [
          {
            course_id: 1,
            quiz_items: JSON.stringify(quizItems),
            lesson_pages: "[]",
            content_modules: JSON.stringify([
              {
                id: "plants",
                title: "Plants",
                quizItems: saved,
                quiz_items: saved,
              },
            ]),
          },
        ],
      ];
    if (sql.includes("FROM learning_modules")) return [[]];
    throw new Error(`Unexpected database operation: ${sql}`);
  });
  const response = quizResponse();
  await getCourseById(
    { params: { id: 1 }, query: {}, user: { userId: 1, role: "admin" } },
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  const course = response.body.course;
  assert.deepEqual(course.quizItems, quizItems);
  assert.deepEqual(JSON.parse(course.quiz_contents), quizItems);
  assert.equal(course.contentModules.length, 1);
  assert.deepEqual(course.contentModules[0].quizItems, quizItems);
  assert.deepEqual(course.contentModules[0].quiz_items, quizItems);
});

await test("partial quiz repair never retains answers from incomplete or invalid reviews", async () => {
  for (const verdicts of [
    [{ question_index: 0, supported: true }],
    [
      { question_index: 0, supported: true },
      { question_index: 0, supported: true },
    ],
    [
      { question_index: 0, supported: true },
      { question_index: 5, supported: true },
    ],
  ]) {
    await assert.rejects(
      generateQuizBatch(
        {
          types: ["true_false", "true_false"],
          skills: ["LOTS", "LOTS"],
          chunks,
          maxAttempts: 1,
          preserveValidated: true,
        },
        async (request) =>
          request.schema.properties.questions
            ? {
                questions: [
                  {
                    ...question,
                    evidence_ids: [request.data.evidence[0].evidence_id],
                  },
                  {
                    ...question,
                    evidence_ids: [request.data.evidence[0].evidence_id],
                    question: "Plants produce food using sunlight.",
                  },
                ],
              }
            : { verdicts },
      ),
      (error) =>
        error.statusCode === 422 &&
        error.code === "QUIZ_REVIEW_INCOMPLETE" &&
        !error.validatedQuestions?.length,
    );
  }
});

await test("unavailable generation and incomplete provider replies are reported before question validation", async (context) => {
  const previousKey = process.env.GEMINI_API_KEY;
  context.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });
  delete process.env.GEMINI_API_KEY;
  const prepare = () => generateQuizBatch({
    types: ["true_false"], skills: ["LOTS"], chunks, preserveValidated: true,
  });
  const candidate = { finishReason: "MAX_TOKENS" };
  const post = context.mock.method(axios, "post", async () => ({
    data: { candidates: [candidate] },
  }));
  await assert.rejects(prepare, { statusCode: 503 });
  assert.equal(post.mock.callCount(), 0);
  process.env.GEMINI_API_KEY = "test-key";
  await assert.rejects(prepare, { statusCode: 502, code: "GENERATION_INCOMPLETE" });
  candidate.finishReason = "STOP";
  candidate.content = { parts: [{ text: "invalid" }] };
  await assert.rejects(prepare, { statusCode: 502, code: "GENERATION_INVALID_OUTPUT" });
  assert.equal(post.mock.callCount(), 2);
});

await test("practice AI calls cap provider retries and cancel at the shared deadline", async (context) => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  context.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });
  let mode = "failure";
  let calls = 0;
  const controller = new AbortController();
  context.mock.method(axios, "post", async (_, payload, options) => {
    calls++;
    if (mode === "default") {
      assert.equal(options.timeout, 90000);
      return {
        data: {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: '{"ready":true}' }] },
            },
          ],
        },
      };
    }
    assert.equal(options.timeout, 30000);
    assert.equal(options.signal, controller.signal);
    if (mode === "failure")
      throw Object.assign(new Error("Provider unavailable"), {
        response: { status: 503 },
      });
    return new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("Cancelled")),
        { once: true },
      ),
    );
  });
  const request = { instruction: "Test", data: {}, schema: { type: "OBJECT" } };
  const practice = {
    ...request,
    signal: controller.signal,
    timeoutMs: 30000,
    maxAttempts: 1,
  };
  await assert.rejects(generateJson(practice), { statusCode: 503 });
  assert.equal(calls, 1);
  mode = "cancelled";
  const pending = generateJson(practice);
  controller.abort();
  await assert.rejects(pending, {
    code: "GENERATION_TIMEOUT",
    statusCode: 503,
  });
  assert.equal(calls, 2);
  mode = "default";
  assert.deepEqual(await generateJson(request), { ready: true });
  assert.equal(calls, 3);
});

await db.end();
