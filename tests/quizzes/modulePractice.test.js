import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { getQuizAttempts } from "../../src/controllers/monitoringController.js";
import { DUPLICATE_QUIZ_QUESTION } from "../../src/services/quizzes/quizValidation.js";
import { generateQuizBatch } from "../../src/services/rag/quizRagService.js";
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

function practiceDraft(request, draft) {
  return {
    questions: request.data.assigned_slots.map((slot, index) => ({
      question: `Practice ${draft}-${index}?`,
      type: slot.type,
      options:
        slot.type === "multiple_choice"
          ? ["Role model", "Identity", "Algorithm", "Database"]
          : slot.type === "true_false"
            ? ["True", "False"]
            : [],
      correct_answer: slot.type === "true_false" ? "True" : "Role model",
      explanation: "Role models give students examples to observe.",
      topic: slot.topic || "Learning",
      concept: slot.concept || "Role models",
      thinking_skill: slot.thinking_skill,
      cognitive_level: slot.allowed_cognitive_levels[0],
      evidence_ids: [request.data.evidence[0].evidence_id],
    })),
  };
}

test("practice adapts to misses and creates 10 unique mixed questions from the saved lesson", async () => {
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
        assert.deepEqual(batch.distribution, {
          questionCount: 10,
          multipleChoiceCount: 6,
          trueFalseCount: 2,
          identificationCount: 2,
          hotsCount: 2,
          lotsCount: 8,
        });
        assert.equal(batch.chunks[0].source_filename, "Social Learning");
        assert.equal(batch.types.length, 10);
        assert.equal(batch.practiceFocus.target_count, 6);
        assert.deepEqual(
          batch.practiceFocus.target_topics,
          Array(6).fill("Identity"),
        );
        assert.equal(
          batch.practiceFocus.missed_concepts[0].question,
          missed.question,
        );
        assert.equal(
          batch.practiceFocus.missed_concepts[0].topic,
          missed.topic,
        );
        assert.equal(
          batch.skills.filter((skill) => skill === "HOTS").length,
          2,
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
  assert.equal(questions.length, 10);
  assert.equal(
    questions.filter((item) => item.type === "identification").length,
    2,
  );
  assert.equal(new Set(questions.map((item) => item.id)).size, 10);
});

test("scores from 60% through 100% keep the same practice difficulty and focus on actual misses", async () => {
  for (const [correct, total] of [
    [3, 5],
    [8, 10],
    [17, 20],
    [9, 10],
    [10, 10],
  ]) {
    const performance = Array.from({ length: total }, (_, index) => ({
      question: `Earlier concept ${index + 1}?`,
      topic: index < correct ? "Learning" : "Identity",
      isCorrect: index < correct,
    }));
    const misses = performance
      .filter((item) => !item.isCorrect)
      .map(({ question, topic }) => ({ question, topic }));
    let generatedCount = 0;
    const questions = await generatePracticeQuestions(lesson, performance, [], {
      generateBatch: async (batch) => {
        assert.equal(batch.difficulty, "medium", `${correct}/${total}`);
        assert.equal(batch.distribution.hotsCount, 4);
        assert.equal(batch.distribution.lotsCount, 6);
        if (misses.length) {
          assert.equal(batch.practiceFocus.target_count, 6);
          assert.deepEqual(
            batch.practiceFocus.target_topics,
            Array(6).fill("Identity"),
          );
          assert.deepEqual(
            batch.practiceFocus.missed_concepts.map(({ question, topic }) => ({
              question,
              topic,
            })),
            misses,
          );
        } else assert.equal(batch.practiceFocus, undefined);
        return batch.types.map((type, index) => ({
          ...question(++generatedCount, "Reinforcement"),
          type,
          options: type === "multiple_choice" ? ["A", "B", "C", "D"] : [],
          thinking_skill: batch.skills[index],
        }));
      },
    });
    assert.equal(questions.length, 10);
  }
});

test("missed-concept prompts ask for clearer questions without increasing difficulty", async () => {
  const practiceFocus = {
    target_count: 1,
    missed_concepts: [{ question: recap[0].question, topic: "Identity" }],
  };
  const result = await generateQuizBatch(
    {
      types: ["true_false"],
      skills: ["LOTS"],
      difficulty: "medium",
      chunks: [
        {
          chunk_id: 1,
          chunk_text: lesson.lessonPages[0].content,
          source_filename: "Social Learning",
        },
      ],
      practiceFocus,
    },
    async (request) => {
      if (!request.schema.properties.questions)
        return { verdicts: [{ question_index: 0, supported: true }] };
      assert.deepEqual(request.data.practice_focus, practiceFocus);
      assert.match(
        request.instruction,
        /short, direct sentences and familiar examples/,
      );
      assert.match(request.instruction, /clearer and easier to understand/);
      assert.match(
        request.instruction,
        /Do not increase difficulty or reasoning depth/,
      );
      assert.match(
        request.instruction,
        /Missed concepts are learning targets and never evidence/,
      );
      return {
        questions: [
          {
            ...question(1, "Role models give students examples to observe"),
            evidence_ids: ["c1-e0"],
          },
        ],
      };
    },
  );
  assert.equal(result.length, 1);
});

test("Q&A practice requests 10 standalone identification questions", async () => {
  let count = 0;
  const questions = await generatePracticeQuestions(lesson, [], [], {
    format: "qna",
    generateBatch: async (batch) => {
      assert.equal(batch.shortAnswer, true);
      assert.equal(batch.distribution.identificationCount, 10);
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
  assert.equal(questions.length, 10);
  assert.ok(
    questions.every(
      (item) => item.type === "identification" && !item.options.length,
    ),
  );
});

test("practice splits only the exhausted duplicate batch and keeps all 10 slots", async () => {
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
        if (batch.types.length < 10) {
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
        if (batch.types.length < 10)
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
      [5, 5],
      [5, 1],
    ],
  );
  assert.equal(questions.length, 10);
  assert.equal(new Set(questions.map(({ question }) => question)).size, 10);
  assert.equal(
    questions.filter(({ type }) => type === "multiple_choice").length,
    6,
  );
  assert.equal(
    questions.filter(({ type }) => type === "identification").length,
    2,
  );
  assert.equal(
    questions.filter(({ thinking_skill }) => thinking_skill === "HOTS").length,
    2,
  );
});

test("an accepted practice set uses one draft and one independent review for all ten questions", async () => {
  const calls = [];
  const questions = await generatePracticeQuestions(
    lesson,
    [],
    ["Earlier practice?"],
    {
      generateBatch: (batch) =>
        generateQuizBatch(batch, async (request) => {
          assert.deepEqual(request.data.previous_questions, [
            "Earlier practice?",
          ]);
          if (request.schema.properties.questions) {
            calls.push(["draft", request.data.assigned_slots.length]);
            return practiceDraft(request, 1);
          }
          calls.push(["review", request.data.questions.length]);
          return {
            verdicts: request.data.questions.map((_, question_index) => ({
              question_index,
              supported: true,
            })),
          };
        }),
    },
  );
  assert.deepEqual(calls, [
    ["draft", 10],
    ["review", 10],
  ]);
  assert.equal(questions.length, 10);
  assert.ok(
    questions.every(
      (item) => item.grounding.model_review_passed && item.source_chunks.length,
    ),
  );
});

test("practice repairs rejected batches once in smaller validated groups", async () => {
  let drafts = 0;
  const batchSizes = [];
  const reviewedSizes = [];
  const questions = await generatePracticeQuestions(lesson, [], [], {
    generateBatch: (batch) => {
      batchSizes.push(batch.types.length);
      return generateQuizBatch(batch, async (request) => {
        if (!request.schema.properties.questions) {
          const count = request.data.questions.length;
          reviewedSizes.push(count);
          return {
            verdicts: request.data.questions.map((_, index) => ({
              question_index: index,
              supported: count <= 5,
              reason: "Rewrite the ambiguous learning check.",
            })),
          };
        }
        return practiceDraft(request, ++drafts);
      });
    },
  });
  assert.deepEqual(batchSizes, [10, 5, 5]);
  assert.deepEqual(reviewedSizes, [10, 5, 5]);
  assert.equal(questions.length, 10);
  assert.equal(new Set(questions.map(({ question }) => question)).size, 10);
  assert.equal(
    questions.filter(({ type }) => type === "multiple_choice").length,
    6,
  );
  assert.equal(
    questions.filter(({ thinking_skill }) => thinking_skill === "HOTS").length,
    4,
  );
  assert.ok(
    questions.every(
      (item) =>
        item.grounding.exact_quotes_verified &&
        item.grounding.model_review_passed &&
        item.source_chunks.length,
    ),
  );
});

test("practice stops at rejected individual questions and provider failures", async () => {
  for (const statusCode of [422, 503]) {
    const failure = Object.assign(new Error("Generation rejected"), {
      statusCode,
    });
    const batchSizes = [];
    await assert.rejects(
      generatePracticeQuestions(lesson, [], [], {
        generateBatch: async (batch) => {
          batchSizes.push(batch.types.length);
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(batchSizes, statusCode === 422 ? [10, 5] : [10]);
  }
});

for (const format of ["mixed", "qna"]) {
  test(`${format} practice retains approved questions and repairs only rejected slots`, async () => {
    let drafts = 0;
    let reviews = 0;
    let signal;
    const batchSizes = [];
    const missed = {
      question: "Who gives students examples to observe?",
      topic: "Learning",
      concept: "Role models",
      userAnswer: "Algorithm",
      correctAnswer: "Role model",
      isCorrect: false,
    };
    const questions = await generatePracticeQuestions(lesson, [missed], [], {
      format,
      generateBatch: (batch) => {
        batchSizes.push(batch.types.length);
        assert.equal(batch.maxAttempts, 1);
        return generateQuizBatch(batch, async (request) => {
          signal ||= request.signal;
          assert.equal(request.signal, signal);
          assert.equal(request.timeoutMs, 45000);
          assert.equal(request.maxAttempts, 1);
          if (request.schema.properties.questions) {
            if (drafts === 1) {
              assert.deepEqual(request.data.types, [
                format === "qna" ? "identification" : "multiple_choice",
              ]);
              assert.ok(
                request.data.previous_questions.includes("Practice 1-0?"),
              );
              assert.equal(request.data.practice_focus.target_count, 1);
              assert.deepEqual(request.data.practice_focus.target_topics, [
                "Learning",
              ]);
              assert.deepEqual(request.data.practice_focus.target_concepts, [
                "Role models",
              ]);
              assert.match(request.data.correction, /ambiguous/);
            }
            return practiceDraft(request, ++drafts);
          }
          reviews++;
          return {
            verdicts: request.data.questions.map((_, index) => ({
              question_index: index,
              supported: reviews !== 1 || index !== 1,
              reason: "Rewrite this ambiguous question.",
            })),
          };
        });
      },
    });
    assert.deepEqual(batchSizes, [10, 1]);
    assert.equal(drafts, 2);
    assert.equal(reviews, 2);
    assert.equal(questions.length, 10);
    const stems = questions.map(({ question }) => question);
    assert.ok(stems.includes("Practice 1-0?"));
    assert.ok(stems.includes("Practice 1-4?"));
    assert.ok(stems.includes("Practice 2-0?"));
    assert.ok(!stems.includes("Practice 1-1?"));
    assert.ok(
      questions.every((question) => question.grounding.model_review_passed),
    );
  });
}

test("module practice reviews valid draft slots and repairs only the missing or rejected questions", async () => {
  const module = { ...lesson, id: "3354ba16-1848-4c84-a6b3-efd32843f47c" };
  const draftSizes = [];
  const reviewSizes = [];
  const performance = [{ ...recap[0], concept: "Self", isCorrect: false }];
  const questions = await generatePracticeQuestions(module, performance, [], {
    generateBatch: (batch) =>
      generateQuizBatch(batch, async ({ data, schema }) => {
        if (schema.properties.questions) {
          draftSizes.push(data.types.length);
          const draft = practiceDraft({ data }, draftSizes.length);
          const ids = data.evidence.map((passage) => passage.evidence_id);
          assert.deepEqual(
            schema.properties.questions.items.properties.evidence_ids.items
              .enum,
            ids,
          );
          if (draftSizes.length === 1) {
            draft.questions[0].topic = " identity ";
            draft.questions[1].question = draft.questions[0].question;
            draft.questions[4].evidence_ids = ["unknown-passage"];
          } else if (draftSizes.length === 2) {
            assert.match(data.correction, /Duplicate quiz question/);
            assert.match(data.correction, /Unknown quiz evidence ID/);
            assert.match(data.correction, /Unsupported inference/);
            assert.ok(data.previous_questions.includes("Practice 1-0?"));
          } else {
            assert.ok(data.previous_questions.includes("Practice 2-0?"));
          }
          return draft;
        }
        reviewSizes.push(data.questions.length);
        assert.deepEqual(
          data.questions.map((q) => q.type),
          data.assigned_slots.map((slot) => slot.type),
        );
        return {
          verdicts: data.questions
            .map((q, i) => ({
              question_index: i,
              supported: !["Practice 1-5?", "Practice 2-2?"].includes(
                q.question,
              ),
              reason: "Unsupported inference.",
            }))
            .reverse(),
        };
      }),
  });
  assert.deepEqual(draftSizes, [10, 3, 1]);
  assert.deepEqual(reviewSizes, [8, 3, 1]);
  assert.equal(questions.length, 10);
  assert.equal(new Set(questions.map((item) => item.question)).size, 10);
  assert.ok(
    questions.every((item) =>
      item.source_chunks[0].chunk_id.includes(module.id),
    ),
  );
  assert.ok(
    questions.some(
      (item) => item.question === "Practice 1-0?" && item.topic === "Identity",
    ),
  );
  assert.ok(questions.some((item) => item.question === "Practice 3-0?"));
  assert.ok(
    questions.every(
      (item) =>
        !["Practice 1-4?", "Practice 1-5?", "Practice 2-2?"].includes(
          item.question,
        ),
    ),
  );
});

test("eight approved questions survive a historical duplicate and a rejected answer", async () => {
  const history = Array.from(
    { length: 40 },
    (_, i) => `Earlier practice question ${i + 1}?`,
  );
  const draftSizes = [];
  const result = await generatePracticeQuestions(lesson, [], history, {
    generateBatch: (batch) =>
      generateQuizBatch(batch, async ({ data, schema, instruction }) => {
        assert.ok(!data.previous_questions.includes(history.at(-1)));
        if (schema.properties.questions) {
          draftSizes.push(data.types.length);
          const draft = practiceDraft({ data }, draftSizes.length);
          if (draftSizes.length === 1) {
            assert.deepEqual(data.previous_questions, history.slice(0, 25));
            draft.questions[2].question = history.at(-1);
          } else {
            assert.deepEqual(data.types, ["multiple_choice", "true_false"]);
            assert.equal(data.previous_questions.length, 25 + 8);
          }
          return draft;
        }
        assert.equal(data.objectives, lesson.learningObjectives);
        assert.match(instruction, /assesses a relevant lesson objective/);
        return {
          verdicts: data.questions.map(({ question, question_index }) => ({
            question_index,
            supported: question !== "Practice 1-8?",
            reason: "The cited evidence does not support this answer.",
          })),
        };
      }),
  });
  assert.deepEqual(draftSizes, [10, 2]);
  assert.equal(result.length, 10);
  assert.equal(
    result.filter((q) => q.question.startsWith("Practice 1-")).length,
    8,
  );
  assert.ok(
    result.every(
      (q) => !history.includes(q.question) && q.question !== "Practice 1-8?",
    ),
  );
});

test("the shared practice deadline stops later batches and repairs", async (context) => {
  let controller;
  const timeouts = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeouts.push(milliseconds);
    return controller.signal;
  });
  for (const rejected of [false, true]) {
    controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      generatePracticeQuestions(lesson, [], [], {
        generateBatch: async () => {
          calls++;
          controller.abort();
          if (rejected)
            throw Object.assign(new Error("Rejected"), { statusCode: 422 });
          return Array.from({ length: 5 }, (_, index) =>
            question(index, "Approved"),
          );
        },
      }),
      (error) =>
        error.statusCode === 503 && /took too long/.test(error.message),
    );
    assert.equal(calls, 1);
  }
  assert.deepEqual(timeouts, [120000, 120000]);
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
    if (/information_schema/i.test(sql))
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
          .filter(
            (item) =>
              item.user_id === values[0] &&
              item.result_json &&
              item.attempt_id !== values[3],
          )
          .sort((a, b) => b.completed_at - a.completed_at)
          .slice(0, 20),
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
      /^\s*SELECT\s+attempt_id\s+FROM\s+module_practice_attempts\b/i.test(sql)
    ) {
      const savedAttempt = rows.find(
        (item) =>
          item.user_id === values[0] &&
          item.course_id === values[1] &&
          item.module_id === values[2] &&
          item.question_format === values[3] &&
          item.previous_attempt_id === values[4],
      );

      return [
        savedAttempt
          ? [{ attempt_id: savedAttempt.attempt_id }]
          : [],
      ];
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
    return Array.from({ length: 10 }, (_, i) => ({
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
      code: "PRACTICE_VALIDATION_FAILED",
      message: "The generated questions did not pass validation for this lesson. Please try again.",
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
  assert.equal(first.total, 10);
  assert.equal(first.questions.length, 10);
  assert.equal(first.questions[0].correct_answer, undefined);
  assert.equal(first.questions[0].explanation, undefined);
  assert.equal(forPlayer.id, first.id);
  assert.equal(forPlayer.questions[0].correct_answer, "True");
  assert.deepEqual(
    inputs[0].performance.map(({ isCorrect }) => isCorrect),
    [false, true],
  );
  assert.deepEqual(await startModulePractice(student, scope, generate), first);

  // An unfinished 20-question attempt from before the limit changed resumes at 10.
  const legacyQuestions = [
    ...JSON.parse(rows[0].questions_json),
    ...Array.from({ length: 10 }, (_, i) => question(i + 11, "Older practice")),
  ];
  rows[0].questions_json = JSON.stringify(legacyQuestions);
  assert.deepEqual(await startModulePractice(student, scope, generate), first);

  const answers = first.questions.map(({ id }) => ({
    questionId: id,
    answer: id <= 2 ? "False" : "True",
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
      answers: answers.slice(0, 9),
    }),
    { statusCode: 400 },
  );
  const firstResult = await submitModulePractice(student, {
    attemptId: first.id,
    answers,
  });
  assert.equal(firstResult.score, 8);
  assert.equal(firstResult.total, 10);
  assert.equal(firstResult.percentage, 80);
  assert.equal(firstResult.answers.length, 10);
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
  assert.equal(result.score, 9);
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
      answer: id < 10 ? "good" : "hard",
    })),
  });
  assert.equal(flashcardResult.score, 9);

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
      answer: id < 10 ? "role model" : "good",
    })),
  });
  assert.equal(qnaResult.score, 9);
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
