import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { getQuizAttempts } from "../../src/controllers/monitoringController.js";
import { DUPLICATE_QUIZ_QUESTION } from "../../src/services/quizzes/quizValidation.js";
import {
  generatePracticeQuestions,
  startModulePractice,
  submitModulePractice,
} from "../../src/services/quizzes/modulePracticeService.js";

after(() => db.end());

const student = { userId: 6, role: "student" };
const scope = { courseId: 42, moduleId: "visible-module" };
const recap = [
  {
    question: "What describes identity?",
    options: ["A. A sense of self", "B. A set of instructions"],
    correct_answer: "A",
    topic: "Identity",
  },
  {
    question: "What is the name of the person who acts as an example?",
    type: "identification",
    correct_answer: "Role model",
    topic: "Learning",
  },
];
const lesson = {
  id: "visible-module",
  lesson_id: 5,
  title: "Identity",
  learningObjectives: "Describe the influence of role models on identity.",
  studentPublished: true,
  lessonPages: [
    {
      title: "Social Learning",
      content:
        "Role models give students examples to observe. Identity describes a person's sense of self.",
    },
  ],
  quizItems: recap,
};
const response = (question, userAnswer) => ({ question, userAnswer });
const recapAnswers = [
  response(recap[0].question, recap[0].options[1]),
  response(recap[1].question, " role MODEL "),
];

function question(id, title) {
  return {
    id,
    question: `${title} ${id}?`,
    type: "true_false",
    options: ["True", "False"],
    correct_answer: "True",
    explanation: "The lesson supports it.",
    topic: "Learning",
    cognitive_level: "Understand",
    thinking_skill: "LOTS",
  };
}

test("practice adapts to misses and creates 20 unique mixed questions from the saved lesson", async () => {
  let calls = 0;
  const missed = {
    question: recap[0].question,
    topic: "Identity",
    isCorrect: false,
  };
  const questions = await generatePracticeQuestions(
    lesson,
    [missed],
    recap.map(({ question }) => question),
    {
      generateBatch: async (batch) => {
        assert.equal(batch.difficulty, "easy");
        assert.equal(batch.chunks[0].source_filename, "Social Learning");
        assert.deepEqual(batch.practiceFocus, {
          target_count: 3,
          missed_concepts: [{ question: missed.question, topic: missed.topic }],
        });
        assert.equal(
          batch.skills.filter((skill) => skill === "HOTS").length,
          1,
        );
        const generated = batch.types.map((type, index) => ({
          ...question(++calls, "Practice"),
          type,
          options: type === "multiple_choice" ? ["A", "B", "C", "D"] : [],
          thinking_skill: batch.skills[index],
        }));
        batch.onValidated(generated);
        return generated;
      },
    },
  );
  assert.equal(questions.length, 20);
  assert.equal(
    questions.filter((item) => item.type === "identification").length,
    4,
  );
  assert.equal(new Set(questions.map((item) => item.id)).size, 20);
});

test("Q&A practice requests 20 standalone identification questions", async () => {
  let count = 0;
  const questions = await generatePracticeQuestions(lesson, [], [], {
    format: "qna",
    generateBatch: async (batch) => {
      assert.equal(batch.shortAnswer, true);
      assert.equal(batch.distribution.identificationCount, 20);
      assert.equal(batch.distribution.multipleChoiceCount, 0);
      assert.equal(batch.distribution.trueFalseCount, 0);
      assert.ok(batch.types.every((type) => type === "identification"));
      return batch.types.map((type) => ({
        ...question(++count, "What term describes concept"),
        type,
        options: [],
        correct_answer: "Role model",
      }));
    },
  });
  assert.equal(questions.length, 20);
  assert.ok(
    questions.every(
      (item) => item.type === "identification" && !item.options.length,
    ),
  );
});

test("practice splits only the exhausted duplicate batch and keeps all 20 slots", async () => {
  let stems = 0;
  let failedFirstBatch = false;
  const recovery = [];
  const missed = { ...recap[0], isCorrect: false };
  const questions = await generatePracticeQuestions(
    lesson,
    [missed],
    [missed.question],
    {
      generateBatch: async (batch) => {
        if (!failedFirstBatch) {
          failedFirstBatch = true;
          throw Object.assign(
            new Error("Duplicate quiz question at position 5."),
            {
              code: DUPLICATE_QUIZ_QUESTION,
              statusCode: 422,
            },
          );
        }
        if (batch.types.length < 5) {
          assert.ok(batch.previousQuestions.includes(missed.question));
          assert.equal(batch.chunks[0].source_filename, "Social Learning");
          if (recovery.length)
            assert.ok(
              batch.previousQuestions.includes(recovery[0].firstQuestion),
            );
        }
        const generated = batch.types.map((type, index) => ({
          ...question(++stems, "Practice"),
          type,
          options: type === "multiple_choice" ? ["A", "B", "C", "D"] : [],
          thinking_skill: batch.skills[index],
        }));
        if (batch.types.length < 5)
          recovery.push({
            count: batch.types.length,
            focus: batch.practiceFocus.target_count,
            firstQuestion: generated[0].question,
          });
        batch.onValidated(generated);
        return generated;
      },
    },
  );
  assert.deepEqual(
    recovery.map(({ count, focus }) => [count, focus]),
    [
      [3, 2],
      [2, 1],
    ],
  );
  assert.equal(questions.length, 20);
  assert.equal(new Set(questions.map(({ question }) => question)).size, 20);
  assert.equal(
    questions.filter(({ type }) => type === "multiple_choice").length,
    12,
  );
  assert.equal(
    questions.filter(({ type }) => type === "identification").length,
    4,
  );
  assert.equal(
    questions.filter(({ thinking_skill }) => thinking_skill === "HOTS").length,
    4,
  );
});

test("students resume their own attempt, submit once, then retry with the latest result", async (t) => {
  const course = {
    course_id: scope.courseId,
    content_modules: JSON.stringify([
      lesson,
      { ...lesson, id: "hidden-module", studentPublished: false },
    ]),
    lesson_pages: JSON.stringify(
      lesson.lessonPages.map((page) => ({ ...page, moduleId: lesson.id })),
    ),
    quiz_items: JSON.stringify(
      recap.map((item) => ({ ...item, moduleId: lesson.id })),
    ),
  };
  const rows = [];
  const detailRecords = [];
  let submissionOrder = 0;
  async function execute(sql, values) {
    if (sql.includes("INFORMATION_SCHEMA"))
      return [[{ COLUMN_NAME: "course_id" }]];
    if (sql.includes("JOIN course_enrollments"))
      return [values[1] === student.userId ? [course] : []];
    if (
      sql.includes("SELECT COUNT(*) AS attempts FROM module_practice_attempts")
    )
      return [
        [
          {
            attempts: rows.filter(
              (item) =>
                item.user_id === values[0] &&
                item.course_id === values[1] &&
                item.module_id === values[2] &&
                item.result_json,
            ).length,
          },
        ],
      ];
    if (sql.includes("ORDER BY attempt_id DESC"))
      return [
        rows
          .filter(
            (item) =>
              item.user_id === values[0] && item.question_format === values[3],
          )
          .slice(-1),
      ];
    if (sql.includes("ORDER BY completed_at DESC"))
      return [
        rows
          .filter((item) => item.user_id === values[0] && item.result_json)
          .sort((a, b) => b.completed_at - a.completed_at)
          .slice(0, 1),
      ];
    if (sql.startsWith("INSERT INTO module_practice_attempts")) {
      const [
        user_id,
        course_id,
        module_id,
        question_format,
        previous_attempt_id,
        questions_json,
      ] = values;
      const attempt_id = rows.length + 1;
      rows.push({
        attempt_id,
        user_id,
        course_id,
        module_id,
        question_format,
        previous_attempt_id,
        questions_json,
      });
      return [{ insertId: attempt_id }];
    }
    if (
      sql.includes("FROM module_practice_attempts WHERE attempt_id") ||
      sql.includes("WHERE attempt_id=? AND user_id=? FOR UPDATE")
    ) {
      return [
        rows.filter(
          (item) =>
            item.attempt_id === values[0] &&
            (values.length === 1 || item.user_id === values[1]),
        ),
      ];
    }
    if (sql.startsWith("INSERT INTO quiz_attempts")) return [{ insertId: 99 }];
    if (sql.startsWith("INSERT INTO quiz_attempt_details")) {
      detailRecords.push(values);
      return [{}];
    }
    if (sql.startsWith("UPDATE module_practice_attempts")) {
      const row = rows[values[1] - 1];
      row.result_json = values[0];
      row.completed_at = ++submissionOrder;
      return [{}];
    }
    assert.fail(`Unexpected statement: ${sql}`);
  }
  t.mock.method(db, "execute", execute);
  t.mock.method(db, "getConnection", async () => ({
    execute,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }));
  const inputs = [];
  async function generate(module, performance, previous, { format }) {
    assert.equal(module.id, scope.moduleId);
    inputs.push({ performance, previous, format });
    return Array.from({ length: 20 }, (_, i) => ({
      ...question(i + 1, `Set ${inputs.length}, item`),
      ...(format === "qna"
        ? { type: "identification", options: [], correct_answer: "Role model" }
        : {}),
    }));
  }

  await assert.rejects(startModulePractice(student, scope, generate), {
    code: "QUICK_RECAP_REQUIRED",
  });
  await assert.rejects(
    startModulePractice(
      student,
      { ...scope, recapAnswers: recapAnswers.slice(0, 1) },
      generate,
    ),
    { code: "QUICK_RECAP_REQUIRED" },
  );
  await assert.rejects(
    startModulePractice(
      student,
      { ...scope, moduleId: "hidden-module" },
      generate,
    ),
    { statusCode: 403 },
  );
  await assert.rejects(
    startModulePractice({ ...student, userId: 99 }, scope, generate),
    { statusCode: 403 },
  );

  const startBody = { ...scope, moduleId: 5, recapAnswers };
  const logGenerationError = t.mock.method(console, "error", () => {});
  const generationFailure = Object.assign(
    new Error("Private validation details"),
    {
      statusCode: 422,
    },
  );
  await assert.rejects(
    startModulePractice(student, startBody, async () => {
      throw generationFailure;
    }),
    {
      statusCode: 422,
      message: "We couldn't prepare 20 practice questions. Please try again.",
    },
  );
  assert.equal(rows.length, 0);
  assert.deepEqual(logGenerationError.mock.calls[0].arguments, [
    "Module Practice generation failed:",
    generationFailure.message,
  ]);
  const [first, simultaneous, forPlayer] = await Promise.all([
    startModulePractice(student, startBody, generate),
    startModulePractice(student, startBody, generate),
    startModulePractice(student, { ...startBody, mode: "multiple" }, generate),
  ]);
  assert.deepEqual(simultaneous, first);
  assert.equal(inputs.length, 1);
  assert.equal(first.total, 20);
  assert.equal(first.questions[0].correct_answer, undefined);
  assert.equal(first.questions[0].explanation, undefined);
  assert.equal(forPlayer.id, first.id);
  assert.equal(forPlayer.questions[0].correct_answer, "True");
  assert.deepEqual(
    inputs[0].performance.map(({ isCorrect }) => isCorrect),
    [false, true],
  );
  assert.deepEqual(await startModulePractice(student, scope, generate), first);

  const answers = first.questions.map(({ id }) => ({
    questionId: id,
    answer: id <= 3 ? "False" : "True",
  }));
  await assert.rejects(
    submitModulePractice(
      { ...student, userId: 99 },
      { attemptId: first.id, answers },
    ),
    { statusCode: 404 },
  );
  await assert.rejects(
    submitModulePractice(student, {
      attemptId: first.id,
      answers: answers.slice(0, 19),
    }),
    { statusCode: 400 },
  );
  const firstResult = await submitModulePractice(student, {
    attemptId: first.id,
    answers,
  });
  assert.equal(firstResult.score, 17);
  assert.equal(firstResult.mastered, false);
  assert.deepEqual(
    await submitModulePractice(student, { attemptId: first.id }),
    firstResult,
  );
  assert.equal(detailRecords.length, 1);
  assert.equal(detailRecords[0][1], "practice");
  assert.equal(detailRecords[0][3], 0);
  assert.equal(
    JSON.parse(detailRecords[0][2])[0].cognitive_level,
    "Understand",
  );

  const retry = await startModulePractice(student, scope, generate);
  assert.notEqual(retry.id, first.id);
  assert.deepEqual(inputs[1].performance, firstResult.answers);
  assert.ok(inputs[1].previous.includes(first.questions[0].question));
  assert.equal(rows[1].previous_attempt_id, first.id);
  const result = await submitModulePractice(student, {
    attemptId: retry.id,
    mode: "timed",
    answers: answers.map((answer, index) =>
      index === 0
        ? { ...answer, answer: "True" }
        : index === 1
          ? { ...answer, answer: "" }
          : answer,
    ),
  });
  assert.equal(result.score, 18);
  assert.equal(result.percentage, 90);
  assert.equal(result.mastered, true);
  assert.equal(result.answers[1].userAnswer, "");

  const flashcards = await startModulePractice(
    student,
    { ...scope, mode: "flashcard" },
    generate,
  );
  const flashcardResult = await submitModulePractice(student, {
    attemptId: flashcards.id,
    mode: "flashcard",
    answers: flashcards.questions.map(({ id }) => ({
      questionId: id,
      answer: id < 19 ? "good" : "hard",
    })),
  });
  assert.equal(flashcardResult.score, 18);

  const mixed = await startModulePractice(student, scope, generate);
  const qnaScope = { ...scope, mode: "qna" };
  const [qna, sameQna] = await Promise.all([
    startModulePractice(student, qnaScope, generate),
    startModulePractice(student, qnaScope, generate),
  ]);
  assert.deepEqual(qna, sameQna);
  assert.notEqual(qna.id, mixed.id);
  assert.equal(qna.questions[0].type, "identification");
  assert.deepEqual(await startModulePractice(student, scope, generate), mixed);
  const qnaResult = await submitModulePractice(student, {
    attemptId: qna.id,
    mode: "flashcard",
    answers: qna.questions.map(({ id }) => ({
      questionId: id,
      answer: id < 19 ? "role model" : "good",
    })),
  });
  assert.equal(qnaResult.score, 18);
  const mixedResult = await submitModulePractice(student, {
    attemptId: mixed.id,
    answers,
  });
  const qnaRetry = await startModulePractice(student, qnaScope, generate);
  assert.equal(inputs.at(-1).format, "qna");
  assert.deepEqual(inputs.at(-1).performance, mixedResult.answers);
  assert.ok(inputs.at(-1).previous.includes(qna.questions[0].question));
  assert.equal(rows[qnaRetry.id - 1].previous_attempt_id, qna.id);

  const req = {
    user: student,
    query: { ...scope, source: "module", quizMode: "adaptive_practice" },
  };
  await getQuizAttempts(req, {
    json(payload) {
      assert.deepEqual(payload, { success: true, attempts: 5 });
    },
  });
  await getQuizAttempts(
    { ...req, query: { ...req.query, moduleId: "different-module" } },
    {
      json(payload) {
        assert.deepEqual(payload, { success: true, attempts: 0 });
      },
    },
  );
});
