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
      question_number: slot.question_number,
      learning_objective: slot.learning_objective || request.data.learning_objectives[0] || "Identify an example of social learning.",
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

function validationEvents(logs) {
  return logs.mock.calls.filter((call) => call.arguments[0] === "[Practice validation]")
    .map((call) => JSON.parse(call.arguments[1]));
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

test("repeat practice reinforces a sole missed concept once and rejects a reused question", async () => {
  const material = {
    ...lesson,
    title: "Data summaries",
    learningObjectives: "Choose and interpret a summary for a dataset.",
    lessonPages: [{ title: "Summaries", content:
      "The median is the middle ordered value. Extreme values affect the mean. The range is the maximum minus the minimum. The mode is the most frequent value." }],
  };
  const prior = { question: "What is the middle ordered value called?", topic: "Summaries", concept: "Median",
    correctAnswer: "Median", userAnswer: "Mean", isCorrect: false };
  const misses = [prior, { ...prior, question: "Which measure uses the middle ranked observation?", concept: "median" }];
  const previous = misses.map((miss) => miss.question);
  const applied = "Which measure would resist a change to the largest value in 2, 5, and 90?";
  const sizes = [];
  const questions = await generatePracticeQuestions(material, [misses[1]], previous, {
    isRepeatPractice: true,
    history: [{ answers: [prior] }],
    generateBatch: (batch) => generateQuizBatch(batch, async (request) => {
      const { data, schema } = request;
      if (schema.properties.verdicts) {
        assert.ok(data.questions.every((item) => !previous.includes(item.question)));
        return { verdicts: data.questions.map(({ question_index, question_number }) => ({ question_index, question_number, supported: true, reason: "" })) };
      }
      sizes.push(data.types.length);
      assert.equal(data.practice_focus.target_count, 1);
      assert.deepEqual(data.assigned_slots.filter((slot) => slot.concept).map((slot) => slot.concept.toLowerCase()), ["median"]);
      const draft = practiceDraft(request, sizes.length);
      Object.assign(draft.questions[0], {
        question: sizes.length === 1 ? prior.question : applied,
        topic: data.assigned_slots[0].topic, concept: data.assigned_slots[0].concept,
        options: ["Mean", "Median", "Range", "Maximum"], correct_answer: "Median",
        explanation: "The middle ordered observation remains the same.",
      });
      return draft;
    }),
  });
  assert.deepEqual(sizes, [10, 1]);
  assert.ok(questions.some((item) => item.question === applied));
  assert.equal(questions.length, 10);
  assert.ok(questions.every((item) => item.source_chunks.length && !previous.includes(item.question)));
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
        /Use an example only if it contributes information the student must apply/,
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

test("a shared dataset can test the same missed concept with a different inference", async () => {
  const setup = "Trip times, sorted from shortest to longest, are 10, 12, 13 and 65 minutes. The longest trip was recorded incorrectly and must be replaced with 95 minutes.";
  const old = setup + " What is the original median?";
  const paraphrase = setup + " Which value is the original median?";
  const application = setup + " Why is the original median unchanged?";
  const rule = "For an even number of observations the median is the mean of the two middle values. The mean divides the sum by the count. The range is the maximum minus the minimum.";
  const medianObjective = "Interpret how a correction affects the median.";
  const summaryObjective = "Calculate and interpret summaries of travel-time data.";
  const otherChecks = [
    ["How many trips were recorded?", "Four", "Four times appear in the list."],
    ["Which duration was entered in error?", "65 minutes", "The longest recorded time was 65 minutes."],
    ["How much does the mean increase after the correction?", "7.5 minutes", "The total increases by 30 across four trips."],
    ["What is the shortest recorded trip?", "10 minutes", "The ordered list starts at 10."],
    ["How many trips took less than 15 minutes?", "Three", "10, 12 and 13 are below 15."],
    ["Which two recorded times are one minute apart?", "12 and 13 minutes", "13 minus 12 is one."],
    ["What is the range after the correction?", "85 minutes", "95 minus 10 is 85."],
    ["What is the sum of the original times?", "100 minutes", "10 + 12 + 13 + 65 = 100."],
    ["How many minutes were added to the longest trip?", "30 minutes", "95 minus 65 is 30."],
  ];
  const material = {
    ...lesson, learningObjectives: [medianObjective, summaryObjective].join("\n"),
    lessonPages: [{ title: "Median", content: setup + " " + rule }],
  };
  const missed = { question: old, topic: "Measures of center", concept: "Median", isCorrect: false };
  const reviewed = [];
  const questions = await generatePracticeQuestions(material, [missed], [old], {
    format: "qna", isRepeatPractice: true,
    generateBatch: (batch) => generateQuizBatch(batch, async ({ schema, data }) => {
      if (schema.properties.questions) {
        const draft = practiceDraft({ data }, reviewed.length + 1);
        const repair = reviewed.length > 0;
        assert.equal(data.assigned_slots[0].concept, "Median");
        if (repair) {
          assert.deepEqual(data.assigned_slots.map((s) => s.question_number), [1]);
          assert.equal(data.repair_feedback[0].reason, "This still asks for the original median.");
        }
        Object.assign(draft.questions[0], {
          question: repair ? application : paraphrase,
          correct_answer: repair ? "The two middle values remain 12 and 13." : "12.5 minutes",
          explanation: "Changing the largest observation leaves the two middle values unchanged.",
          learning_objective: medianObjective,
        });
        for (const [i, item] of draft.questions.slice(1).entries()) {
          const [question, correct_answer, explanation] = otherChecks[i];
          Object.assign(item, { question, correct_answer, explanation,
            topic: "Travel times", concept: "Data summaries", learning_objective: summaryObjective });
        }
        return draft;
      }
      reviewed.push(data.questions[0].question);
      assert.ok(data.previous_questions.includes(old));
      return { verdicts: data.questions.map(({ question, question_index, question_number }) => ({
        question_index, question_number, supported: question !== paraphrase,
        reason_code: question === paraphrase ? "duplicate" : "supported",
        reason: question === paraphrase ? "This still asks for the original median." : "",
      })) };
    }),
  });
  assert.deepEqual(reviewed, [paraphrase, application]);
  assert.ok(questions.some((q) => q.question === application && q.concept === "Median" && q.grounding.model_review_passed));
  assert.ok(questions.every((q) => q.question !== old && q.question !== paraphrase));
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

test("a fully direct practice set can pass one draft and one independent review for all ten questions", async () => {
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
          assert.equal(request.data.objectives, lesson.learningObjectives);
          assert.doesNotMatch(request.instruction, /ANSI-SPARC/i);
          if (request.schema.properties.questions) {
            const wording = request.data.assigned_slots.map((slot) => slot.preferred_wording);
            assert.equal(wording.filter((style) => style === "direct").length, 7);
            assert.equal(wording.filter((style) => style === "scenario_if_useful").length, 3);
            assert.match(request.instruction, /Every slot may be direct/);
            calls.push(["draft", wording.length]);
            return practiceDraft(request, 1);
          }
          assert.match(request.instruction, /Accept a fully direct quiz/);
          calls.push(["review", request.data.questions.length]);
          return {
            verdicts: request.data.questions.map(({ question_index, question_number }) => ({
              question_index,
              question_number,
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

test("a wholly rejected first repair group does not skip its siblings", async () => {
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
            verdicts: request.data.questions.map(({ question_index, question_number }) => ({
              question_index,
              question_number,
              supported: count <= 5 && drafts > 2,
              reason: "Rewrite the ambiguous learning check.",
            })),
          };
        }
        return practiceDraft(request, ++drafts);
      });
    },
  });
  assert.deepEqual(batchSizes, [10, 5, 5, 5]);
  assert.deepEqual(reviewedSizes, [10, 5, 5, 5]);
  assert.equal(questions.filter((item) => item.question.startsWith("Practice 3-")).length, 5);
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

test("practice bounds consecutive stalled rounds and stops immediately on provider failures", async () => {
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
    assert.deepEqual(batchSizes, statusCode === 422 ? [10, 5, 5, 5, 5, 5, 5] : [10]);
  }
});

for (const format of ["mixed", "qna"]) {
  test(`${format} practice retains approved questions and repairs only rejected slots`, async () => {
    let drafts = 0;
    let reviews = 0;
    let signal;
    const batchSizes = [];
    const directQuestion =
      "What term describes a person whose behavior students observe as an example?";
    const paddedQuestion = `A student opens a notebook in class. ${directQuestion}`;
    let originalWording;
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
          assert.equal(request.maxAttempts, 3);
          if (request.schema.properties.questions) {
            const slots = request.data.assigned_slots;
            if (drafts === 1) {
              assert.equal(slots[0].preferred_wording, originalWording);
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
              assert.match(request.data.correction, /unnecessary setup/);
            } else {
              originalWording = slots[1].preferred_wording;
              assert.equal(originalWording, "scenario_if_useful");
            }
            const draft = practiceDraft(request, ++drafts);
            if (drafts === 1) draft.questions[1].question = paddedQuestion;
            else draft.questions[0].question = directQuestion;
            return draft;
          }
          reviews++;
          assert.match(
            request.instruction,
            /request a direct rewrite of that question/,
          );
          return {
            verdicts: request.data.questions.map((item) => ({
              question_index: item.question_index,
              question_number: item.question_number,
              supported: item.question !== paddedQuestion,
              reason: item.question === paddedQuestion
                ? "Remove the unnecessary setup."
                : "",
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
    assert.ok(stems.includes(directQuestion));
    assert.ok(!stems.includes(paddedQuestion));
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
            .map((q) => ({
              question_index: q.question_index,
              question_number: q.question_number,
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
        if (schema.properties.questions) {
          assert.ok(!data.previous_questions.includes(history.at(-1)));
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
        assert.ok(data.previous_questions.includes(history.at(-1)));
        assert.equal(data.objectives, lesson.learningObjectives);
        assert.match(instruction, /assesses a relevant lesson objective/);
        return {
          verdicts: data.questions.map(({ question, question_index, question_number }) => ({
            question_index,
            question_number,
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

test("late partial repairs keep approved slots, their exact targets, and the latest rejection for each gap", async (t) => {
  const logs = t.mock.method(console, "info", () => {});
  const objectives = [
    "Recognize examples of social learning.",
    "Explain how observing a role model can influence identity.",
  ];
  const material = { ...lesson, learningObjectives: objectives.join("\n") };
  const miss = { ...recap[0], topic: "Social learning", concept: "Role models", isCorrect: false };
  const reason = "The cited passage does not support this conclusion. Private review detail.";
  const requests = [];
  const reviews = [];
  const result = await generatePracticeQuestions(material, [miss], [], {
    generateBatch: (batch) => generateQuizBatch(batch, async ({ data, schema }) => {
      if (schema.properties.questions) {
        const numbers = data.assigned_slots.map((slot) => slot.question_number);
        const turn = requests.push(numbers);
        const feedback = new Map(data.repair_feedback?.map((entry) => [entry.question_number, entry]));
        const draft = practiceDraft({ data }, turn);
        if (turn === 1) {
          for (const item of draft.questions) {
            item.learning_objective = objectives[item.question_number % 2];
            if ([2, 5].includes(item.question_number)) item.cognitive_level = "Apply";
          }
          // Omit a middle slot and return the rest in a different order.
          draft.questions = draft.questions.filter((item) => item.question_number !== 8).reverse();
        } else {
          for (const slot of data.assigned_slots.filter((item) => [2, 5].includes(item.question_number))) {
            assert.equal(slot.type, "multiple_choice");
            assert.equal(slot.topic, miss.topic);
            assert.equal(slot.concept, miss.concept);
            assert.equal(slot.cognitive_level, "Apply");
            assert.equal(slot.learning_objective, objectives[slot.question_number % 2]);
          }
          assert.deepEqual([...feedback.keys()], numbers);
          assert.ok(data.previous_questions.includes("Practice 1-9?"));
          if (turn === 2) {
            assert.equal(feedback.get(2).reason, reason);
            assert.equal(feedback.get(2).draft.question, "Practice 1-1?");
            assert.equal(feedback.get(5).reason, "The explanation contradicts the passage.");
            assert.match(feedback.get(8).reason, /Question 8 is missing/);
            assert.equal(feedback.get(8).draft, undefined);
            draft.questions[0].learning_objective = objectives[1]; // Valid for the lesson, wrong for slot 2.
            draft.questions[1].cognitive_level = "Understand"; // Still LOTS, wrong for slot 5.
          }
          if (turn === 3) {
            assert.ok(feedback.get(2).reason.includes(objectives[0]));
            assert.match(feedback.get(5).reason, /cognitive_level must be Apply/);
            assert.equal(feedback.get(8).reason, reason);
            draft.questions[0].question = "Practice 1-9?"; // An already approved sibling.
          }
          if (turn === 4) {
            assert.match(feedback.get(2).reason, /Duplicate quiz question at position 2/);
            assert.ok(data.previous_questions.includes("Practice 3-1?"));
          }
          if (turn === 5) assert.ok(data.previous_questions.includes("Practice 4-0?"));
        }
        return draft;
      }

      reviews.push(data.questions.length);
      return { verdicts: data.questions.map((q, position) => {
        assert.equal(q.learning_objective, data.assigned_slots[position].learning_objective);
        assert.equal(q.cognitive_level, data.assigned_slots[position].cognitive_level);
        assert.ok(q.source_chunks.length);
        assert.equal(q.grounding.model_review_passed, false);
        const badExplanation = q.question === "Practice 1-4?";
        const rejected = badExplanation || ["Practice 1-1?", "Practice 2-2?", "Practice 3-2?", "Practice 4-1?"].includes(q.question);
        return {
          question_index: q.question_index,
          question_number: q.question_number,
          supported: !rejected,
          reason_code: badExplanation ? "incorrect_explanation" : rejected ? "unsupported_answer" : "supported",
          reason: badExplanation ? "The explanation contradicts the passage." : rejected ? reason : "",
        };
      }).reverse() };
    }),
  });
  assert.deepEqual(requests, [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 5, 8], [2, 5, 8], [2, 8], [8],
  ]);
  assert.deepEqual(reviews, [9, 1, 2, 2, 1]);
  const ordered = result.toSorted((a, b) => a.source_question_index - b.source_question_index);
  assert.deepEqual(ordered.map((q) => q.question), [
    "Practice 1-0?", "Practice 4-0?", "Practice 1-2?", "Practice 1-3?", "Practice 3-1?",
    "Practice 1-5?", "Practice 1-6?", "Practice 5-0?", "Practice 1-8?", "Practice 1-9?",
  ]);
  assert.ok(ordered.every((q) => q.grounding.model_review_passed && q.source_chunks[0].quote === lesson.lessonPages[0].content));
  const events = validationEvents(logs);
  assert.deepEqual(events.filter((event) => event.attempted).map((event) => event.passed), [7, 7, 8, 9, 10]);
  assert.deepEqual(events[0].rejected.incorrect_explanation, [5]);
  assert.equal(events.at(-1).stop, "all_slots_verified");
  assert.doesNotMatch(JSON.stringify(events), /Private review detail|Practice 1-|Role models/);
});

test("ambiguous slot numbers and incomplete verdicts cannot approve an unreviewed question", async () => {
  const requested = [];
  const result = await generatePracticeQuestions(lesson, [], [], {
    generateBatch: (batch) => generateQuizBatch(batch, async ({ schema, data }) => {
      if (schema.properties.questions) {
        requested.push(data.assigned_slots.map((slot) => slot.question_number));
        const draft = practiceDraft({ data }, requested.length);
        if (requested.length === 1) {
          draft.questions.push({ ...draft.questions[2], question: "Conflicting draft?" });
          draft.questions.push({ ...draft.questions[0], question_number: 100 });
        } else {
          assert.match(data.repair_feedback[0].reason, /exactly one draft.*3/);
          assert.ok(data.repair_feedback.slice(1).every((r) => /unambiguous verdict/.test(r.reason)));
        }
        return draft;
      }
      const verdicts = data.questions.map(({ question_index, question_number }) => ({ question_index, question_number, supported: true }));
      if (requested.length === 1) {
        verdicts.pop(); // No decision on slot 10.
        verdicts[2].question_number = 7; // The index refers to slot 4. Neither slot can use this verdict.
        verdicts.push({ ...verdicts[4], supported: false }); // Conflicting decisions on slot 6.
        verdicts.push({ question_index: 99, supported: true });
      }
      return { verdicts: verdicts.reverse() };
    }),
  });
  assert.deepEqual(requested[1], [3, 4, 6, 7, 10]);
  assert.equal(requested.length, 2);
  assert.equal(result.length, 10);
  assert.equal(result.filter((q) => q.question.startsWith("Practice 1-")).length, 5);
  assert.ok(result.every((q) => q.grounding.model_review_passed && q.question !== "Conflicting draft?"));
});

test("nine verified questions never become a quiz while the last explanation fails review", async (t) => {
  const logs = t.mock.method(console, "info", () => {});
  const sizes = [];
  await assert.rejects(generatePracticeQuestions(lesson, [], [], {
    generateBatch: (batch) => generateQuizBatch(batch, async ({ schema, data }) => {
      if (schema.properties.questions) {
        const turn = sizes.push(data.assigned_slots.length);
        const draft = practiceDraft({ data }, turn);
        draft.questions.at(-1).explanation = "Private unsupported claim.";
        if (turn > 1) {
          assert.equal(data.assigned_slots[0].question_number, 10);
          assert.equal(data.repair_feedback[0].reason, "Private reviewer correction.");
          assert.equal(data.repair_feedback[0].draft.explanation, "Private unsupported claim.");
          assert.equal(data.previous_questions.length, 9);
        }
        return draft;
      }
      return { verdicts: data.questions.map((q) => ({
        question_index: q.question_index,
        question_number: q.question_number,
        supported: q.explanation !== "Private unsupported claim.",
        reason: "Private reviewer correction.",
        reason_code: q.explanation === "Private unsupported claim." ? "private-unrecognized-code" : "supported",
      })) };
    }),
  }), { statusCode: 422, code: "QUIZ_REVIEW_REJECTED" });
  assert.deepEqual(sizes, [10, 1, 1, 1]);
  const events = validationEvents(logs);
  assert.equal(events.at(-1).passed, 9);
  assert.equal(events.at(-1).stop, "no_progress");
  assert.equal(events.at(-1).stalledRounds, 3);
  assert.doesNotMatch(JSON.stringify(events), /private/i);
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
  assert.deepEqual(timeouts, [240000, 240000]);
});

test("a late deadline or provider outage ends repair after nine approvals", async (t) => {
  const started = Date.now();
  let now = started;
  t.mock.method(Date, "now", () => now);
  const logs = t.mock.method(console, "info", () => {});
  for (const stop of ["deadline", "provider_unavailable"]) {
    now = started;
    const sizes = [];
    await assert.rejects(generatePracticeQuestions(lesson, [], [], {
      generateBatch: (batch) => generateQuizBatch(batch, async ({ schema, data, deadlineAt }) => {
        assert.equal(deadlineAt, started + 240_000);
        if (schema.properties.questions) {
          const turn = sizes.push(data.assigned_slots.length);
          if (turn === 2) {
            assert.equal(data.assigned_slots[0].question_number, 5);
            if (stop === "deadline") now = deadlineAt;
            throw Object.assign(new Error("Provider unavailable."), {
              statusCode: 503, code: "PRACTICE_PROVIDERS_UNAVAILABLE",
            });
          }
          return practiceDraft({ data }, turn);
        }
        return { verdicts: data.questions.map(({ question_index, question_number }) => ({
          question_index, question_number, supported: question_number !== 5,
          reason: "The explanation is unsupported.",
        })) };
      }),
    }), { statusCode: 503, code: stop === "deadline" ? "GENERATION_TIMEOUT" : "PRACTICE_PROVIDERS_UNAVAILABLE" });
    assert.deepEqual(sizes, [10, 1]);
    const event = validationEvents(logs).at(-1);
    assert.equal(event.stop, stop);
    assert.equal(event.passed, 9);
  }
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
    generationFailure.statusCode,
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
