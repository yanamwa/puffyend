import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createMainQuizPrompt } from "../../src/services/quizzes/mainQuizPrompt.js";
import {
  gradeMainQuiz,
  mainQuizBlueprint,
  shuffleMainQuizQuestions,
  validateAdaptiveQuestions,
} from "../../src/services/quizzes/mainQuizAdaptive.js";

const questions = [
  {
    question: "Which energy source powers photosynthesis?",
    type: "multiple_choice",
    options: ["Sunlight", "Sound", "Gravity", "Wind"],
    correct_answer: "Sunlight",
    explanation: "Photosynthesis uses light energy.",
    topic: "Plants",
    cognitive_level: "Remember",
    thinking_skill: "LOTS",
  },
  {
    question: "Name the food-making process in plants.",
    type: "identification",
    options: [],
    correct_answer: "Photosynthesis",
    explanation: "Plants produce food through photosynthesis.",
    topic: "Plants",
    cognitive_level: "Understand",
    thinking_skill: "LOTS",
  },
  {
    question: "Roots are the primary organs that capture sunlight.",
    type: "true_false",
    options: ["True", "False"],
    correct_answer: "False",
    explanation: "Leaves are the primary light-capturing organs.",
    topic: "Plants",
    cognitive_level: "Analyze",
    thinking_skill: "HOTS",
  },
];
const originalQuestionOrder = questions.map((question) => question.question);
const source = readFileSync(
  new URL("../../src/services/quizzes/mainQuizService.js", import.meta.url),
  "utf8",
);
const slice = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last).replace(/export /g, "");
};
const serviceCode = [
  slice("async function studentAccess", "export async function saveMainConfig"),
  slice("const publicQuiz =", "export async function generateMainQuizPreview"),
  slice(
    "export function baselineQuestionBlueprint",
    "export async function saveMainQuizPreview",
  ),
  slice(
    "export async function submitMainQuiz",
    "export async function mainQuizAnalysis",
  ),
  slice(
    "export function validateManualQuestions",
    "export function savedLessonChunks",
  ),
].join("\n");
const plain = (value) => JSON.parse(JSON.stringify(value));
const assignmentKey = (courseId, moduleId, userId, revision) =>
  [courseId, moduleId, userId, revision].join(":");

function fixture(mode) {
  const config = {
    questionCount: questions.length,
    multipleChoiceCount: 1,
    identificationCount: 1,
    trueFalseCount: 1,
    passingPercentage: 70,
    moduleIndex: 0,
    documentIds: ["1"],
    lessonTitle: "Plants",
    topics: ["Plants"],
    ...(mode === "baseline" ? { baselineQuestions: plain(questions) } : {}),
  };
  const stored = { revision: 1, config_json: JSON.stringify(config) };
  const records = new Map();
  const writes = [];
  let shuffleCalls = 0;
  let generatedBatches = 0;
  let nextId = 10;
  async function execute(sql, parameters = []) {
    if (sql.includes("FROM course_enrollments"))
      return [[{ user_id: parameters[1] }]];
    if (sql.includes("FROM courses"))
      return [
        [
          {
            lesson_contents: JSON.stringify([
              {
                moduleId: "module-1",
                moduleIndex: 0,
                moduleTitle: "Plants",
                mainQuizSettings: {
                  enabled: true,
                  ...(mode === "manual" ? { manualQuestions: questions } : {}),
                },
              },
            ]),
            quiz_contents: "[]",
          },
        ],
      ];
    if (sql.includes("FROM main_quiz_configs")) return [[stored]];
    if (sql.includes("FROM personalized_main_quizzes")) {
      const row = sql.includes("WHERE quiz_id=?")
        ? [...records.values()].find(
            (item) =>
              item.quiz_id === parameters[0] && item.user_id === parameters[1],
          )
        : records.get(assignmentKey(...parameters));
      return [row ? [row] : []];
    }
    if (sql.includes("FROM lesson_source_documents"))
      return [
        [
          {
            document_id: 1,
            filename: "plants.txt",
            processing_status: "ready",
          },
        ],
      ];
    if (sql.includes("FROM quiz_attempts"))
      return [
        mode === "adaptive"
          ? [
              {
                attempts_id: 42,
                total: 1,
                answers_json: JSON.stringify([
                  {
                    question: "Earlier practice question.",
                    topic: "Plants",
                    cognitive_level: "Remember",
                    isCorrect: false,
                  },
                ]),
              },
            ]
          : [],
      ];
    if (sql.startsWith("INSERT IGNORE INTO main_quiz_configs"))
      return [{ affectedRows: 0 }];
    if (sql.startsWith("INSERT IGNORE INTO personalized_main_quizzes")) {
      const [
        courseId,
        moduleId,
        userId,
        revision,
        practiceId,
        json,
        blueprint,
        snapshot,
      ] = parameters;
      const key = assignmentKey(courseId, moduleId, userId, revision);
      if (!records.has(key))
        records.set(key, {
          quiz_id: nextId++,
          course_id: courseId,
          module_id: moduleId,
          user_id: userId,
          revision,
          practice_attempt_id: practiceId,
          questions_json: json,
          blueprint_json: blueprint,
          config_json: snapshot,
          submissions: 0,
        });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE personalized_main_quizzes")) {
      const row = [...records.values()].find(
        (item) => item.quiz_id === parameters[0],
      );
      row.submissions++;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO")) {
      writes.push({ sql, parameters });
      return [{ insertId: nextId++ }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const chunks = [
    { chunk_id: 1, document_id: 1, chunk_text: "Plants use sunlight." },
  ];
  const context = vm.createContext({
    parse: (value) => (typeof value === "string" ? JSON.parse(value) : value),
    requestError: (message, statusCode) =>
      Object.assign(new Error(message), { statusCode }),
    db: {
      execute,
      getConnection: async () => ({
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      }),
    },
    gradeMainQuiz,
    mainQuizBlueprint,
    createMainQuizPrompt,
    validateAdaptiveQuestions,
    shuffleMainQuizQuestions: (items) => {
      const rotate = shuffleCalls++ % 2 === 0;
      return shuffleMainQuizQuestions(items, (maximum) =>
        rotate ? 0 : maximum - 1,
      );
    },
    loadChunks: async () => chunks,
    retrieveContexts: async () => chunks,
    generateQuizBatch: async ({ assignedSlots }) => {
      generatedBatches++;
      return assignedSlots.map((slot) => ({
        ...questions.find((question) => question.type === slot.type),
        ...slot,
      }));
    },
  });
  vm.runInContext(
    serviceCode +
      "\nthis.api = { startMainQuiz, submitMainQuiz, generatePersonalized };",
    context,
  );
  return {
    api: context.api,
    config,
    stored,
    records,
    writes,
    get shuffleCalls() {
      return shuffleCalls;
    },
    get generatedBatches() {
      return generatedBatches;
    },
  };
}

test("shuffle preserves complete questions and source positions without mutating the original", () => {
  const original = plain(questions);
  const bounds = [];
  const shuffled = shuffleMainQuizQuestions(questions, (maximum) => {
    bounds.push(maximum);
    return 0;
  });
  assert.deepEqual(bounds, [3, 2]);
  assert.deepEqual(
    shuffled.map((question) => question.source_question_index),
    [1, 2, 0],
  );
  for (const question of shuffled)
    assert.deepEqual(question, {
      ...original[question.source_question_index],
      source_question_index: question.source_question_index,
    });
  assert.deepEqual(questions, original);
  assert.deepEqual(shuffleMainQuizQuestions([]), []);
  assert.equal(
    shuffleMainQuizQuestions([questions[0]])[0].source_question_index,
    0,
  );
});

for (const mode of ["manual", "baseline", "generated", "adaptive"]) {
  test(`${mode} assignments shuffle per student, resume unchanged, and grade against the saved order`, async () => {
    const state = fixture(mode);
    const body = { course_id: 1, module_id: "module-1" };
    const firstUser = { userId: 8, role: "student" };
    const secondUser = { userId: 9, role: "student" };
    const first = await state.api.startMainQuiz(firstUser, body);
    const resumed = await state.api.startMainQuiz(firstUser, body);
    const second = await state.api.startMainQuiz(secondUser, body);
    assert.deepEqual(plain(resumed), plain(first));
    assert.notDeepEqual(
      first.questions.map((question) => question.question),
      second.questions.map((question) => question.question),
    );
    assert.equal(state.shuffleCalls, 2);
    assert.equal(
      state.generatedBatches,
      ["generated", "adaptive"].includes(mode) ? 2 : 0,
    );
    assert.equal(state.records.size, 2);
    const firstRow = state.records.get(assignmentKey(1, "module-1", 8, 1));
    const savedQuestions = JSON.parse(firstRow.questions_json);
    assert.deepEqual(
      savedQuestions.map((question) => question.question),
      Array.from(first.questions, (question) => question.question),
    );
    assert.equal(firstRow.practice_attempt_id, mode === "adaptive" ? 42 : 0);
    for (const question of first.questions) {
      assert.equal("correct_answer" in question, false);
      assert.equal("explanation" in question, false);
      assert.equal("source_question_index" in question, false);
    }
    const correctAnswers = savedQuestions.map(
      (question) => question.correct_answer,
    );
    const result = await state.api.submitMainQuiz(firstUser, {
      quiz_id: first.quizId,
      answers: correctAnswers,
    });
    assert.equal(result.score, 3);
    assert.equal(result.total, 3);
    assert.equal(result.passed, true);
    assert.deepEqual(
      result.answers.map((answer) => answer.question),
      savedQuestions.map((question) => question.question),
    );
    assert.deepEqual(
      result.answers.map((answer) => answer.source_question_index),
      savedQuestions.map((question) => question.source_question_index),
    );
    const wrongOrder = await state.api.submitMainQuiz(secondUser, {
      quiz_id: second.quizId,
      answers: correctAnswers,
    });
    assert.equal(wrongOrder.score, 0);
    const recorded = state.writes.find((write) =>
      write.sql.startsWith("INSERT INTO quiz_attempt_details"),
    );
    assert.deepEqual(JSON.parse(recorded.parameters[2]), result.answers);
    assert.deepEqual(
      questions.map((question) => question.question),
      originalQuestionOrder,
    );
    if (mode === "baseline")
      assert.deepEqual(state.config.baselineQuestions, questions);
  });
}
test("concurrent starts retain the winning persisted order for the same student", async () => {
  const state = fixture("manual");
  const user = { userId: 8, role: "student" };
  const body = { course_id: 1, module_id: "module-1" };
  const [first, second] = await Promise.all([
    state.api.startMainQuiz(user, body),
    state.api.startMainQuiz(user, body),
  ]);
  assert.deepEqual(plain(first), plain(second));
  assert.equal(state.records.size, 1);
});

test("professor previews retain author order and do not create shuffled student assignments", async () => {
  const state = fixture("generated");
  const preview = await state.api.generatePersonalized(
    { userId: 1, role: "admin" },
    1,
    "module-1",
    state.stored,
    state.config,
    true,
  );
  assert.deepEqual(
    Array.from(preview, (question) => question.question),
    originalQuestionOrder,
  );
  assert.equal(state.shuffleCalls, 0);
  assert.equal(state.records.size, 0);
});

test("already-started legacy quizzes keep their saved question order", async () => {
  const state = fixture("baseline");
  state.records.set(assignmentKey(1, "module-1", 8, 1), {
    quiz_id: 90,
    course_id: 1,
    module_id: "module-1",
    user_id: 8,
    revision: 1,
    questions_json: JSON.stringify(questions),
    config_json: JSON.stringify(state.config),
    submissions: 0,
  });
  const quiz = await state.api.startMainQuiz(
    { userId: 8, role: "student" },
    { course_id: 1, module_id: "module-1" },
  );
  assert.deepEqual(
    Array.from(quiz.questions, (question) => question.question),
    originalQuestionOrder,
  );
  assert.equal(state.shuffleCalls, 0);
});
