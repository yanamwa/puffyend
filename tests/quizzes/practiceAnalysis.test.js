import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePractice,
  buildPracticeFeedback,
  loadPracticeHistory,
} from "../../src/services/quizzes/practiceAnalysis.js";
import { generatePracticeQuestions } from "../../src/services/quizzes/modulePracticeService.js";
import { generateQuizBatch } from "../../src/services/rag/quizRagService.js";
import {
  validateKnownAnswerKey,
  validateQuizUniqueness,
} from "../../src/services/quizzes/quizValidation.js";

const answer = (isCorrect, extra = {}) => ({
  question: "Which transaction property makes an operation all-or-nothing?",
  topic: "Transaction Management",
  concept: "Atomicity",
  type: "identification",
  userAnswer: isCorrect ? "Atomicity" : "Durability",
  correctAnswer: "Atomicity",
  explanation: "Atomicity completes the entire transaction or rolls it back.",
  isCorrect,
  ...extra,
});

test("feedback explains the actual misconception and separates latest accuracy from history", () => {
  const feedback = buildPracticeFeedback(
    [answer(false), answer(true, { concept: "Durability" })],
    [{ answers: [answer(false)] }, { answers: [answer(true)] }],
  )[0];
  assert.equal(feedback.latestAccuracy, 50);
  assert.equal(feedback.historicalAccuracy, 50);
  assert.equal(feedback.latestTotal, 2);
  assert.equal(feedback.historicalTotal, 4);
  assert.equal(feedback.analyzedAttempts, 3);
  assert.equal(feedback.missedAttempts, 2);
  assert.equal(feedback.recurring, true);
  assert.match(feedback.recommendation, /missed 1 of the 2/);
  assert.match(feedback.suggestedReviewTopics[0].explanation, /rolls it back/);
  assert.doesNotMatch(feedback.nextGoal, /6\/10/);
  assert.match(feedback.nextGoal, /new question/);
});

test("a perfect latest score does not erase persistent weaknesses or invent full mastery", () => {
  const latest = [answer(true)];
  const previous = [{ answers: [answer(false)] }, { answers: [answer(false)] }];
  const feedback = buildPracticeFeedback(latest, previous)[0];
  assert.equal(feedback.latestAccuracy, 100);
  assert.equal(feedback.historicalAccuracy, 33);
  assert.equal(feedback.recurring, true);
  assert.match(feedback.adaptiveRecommendation, /Atomicity/);
  assert.doesNotMatch(feedback.adaptiveRecommendation, /advanced/);
  assert.equal(analyzePractice(latest, previous)[0].needsReview, true);
});

test("strengths merge case variants and exclude a concept with a contradictory current miss", () => {
  const feedback = buildPracticeFeedback([
    answer(true),
    answer(true, { concept: " atomicity " }),
    answer(true, { concept: "Durability" }),
    answer(false, { concept: "durability" }),
  ])[0];
  assert.deepEqual(feedback.strengths, [
    "Correctly answered on this attempt: Atomicity.",
  ]);
  assert.deepEqual(feedback.areasForImprovement, ["durability"]);
});

test("flashcard ratings are never treated as verified strengths or historical mastery", () => {
  const feedback = buildPracticeFeedback(
    [answer(true, { userAnswer: "good", isSelfAssessed: true })],
    [
      { answers: [answer(false)] },
      {
        assessmentBasis: "self_assessment",
        answers: [answer(true, { userAnswer: "easy" })],
      },
    ],
  )[0];
  assert.equal(feedback.latestAccuracy, null);
  assert.equal(feedback.historicalTotal, 1);
  assert.equal(feedback.selfAssessed, true);
  assert.deepEqual(feedback.strengths, []);
  assert.match(feedback.nextGoal, /graded practice quiz/);
  const legacyFlashcard = buildPracticeFeedback(
    [answer(true, { userAnswer: "good" })],
    [],
    { quizMode: "flashcard" },
  )[0];
  assert.equal(legacyFlashcard.selfAssessed, true);
  assert.deepEqual(legacyFlashcard.strengths, []);
});

test("feedback sections teach concepts, suggest study actions, and keep the plan separate from corrections", () => {
  const feedback = buildPracticeFeedback([
    answer(true, { concept: "Data redundancy" }),
    answer(true, { concept: "Database Administrator" }),
    answer(false, {
      concept: "Data Definition Language (DDL)",
      userAnswer: "DML",
      correctAnswer: "DDL",
      explanation:
        "DDL defines database structures; CREATE TABLE is DDL, while INSERT INTO is DML.",
    }),
    answer(false, {
      concept: "External Level",
      userAnswer: "Internal Level",
      correctAnswer: "External Level",
      explanation:
        "The external level represents user views; the internal level describes physical storage.",
    }),
  ])[0];
  assert.equal(feedback.feedbackVersion, 4);
  assert.equal(feedback.difficulty, "Foundation Practice");
  assert.match(
    feedback.recommendation,
    /missed 2 of the 4/,
  );
  assert.doesNotMatch(feedback.recommendation, /CREATE TABLE|physical storage/);
  assert.match(
    feedback.adaptiveRecommendation,
    /Start with Data Definition Language.*Then revisit External Level/,
  );
  const [ddl, architecture] = feedback.suggestedReviewTopics;
  assert.doesNotMatch(ddl.explanation, /confusion between/);
  assert.match(ddl.explanation, /CREATE TABLE.*INSERT INTO/);
  assert.match(ddl.studyTip, /Compare DML with DDL/);
  assert.match(
    architecture.explanation,
    /represents user views.*physical storage/,
  );
  assert.notEqual(ddl.explanation, ddl.studyTip);
  assert.doesNotMatch(
    JSON.stringify([
      feedback.recommendation,
      feedback.adaptiveRecommendation,
      ddl,
      architecture,
    ]),
    /You answered|saved correct answer|You confused/,
  );
});

test("unanswered and true-false feedback does not invent the learner's reasoning or new subject facts", () => {
  const [blank, boolean] = buildPracticeFeedback([
    answer(false, {
      topic: "Unanswered",
      concept: "Unfamiliar concept",
      userAnswer: "",
      explanation: "",
    }),
    answer(false, {
      topic: "Statements",
      type: "true_false",
      userAnswer: "False",
      correctAnswer: "True",
      explanation:
        "Atomicity completes the entire transaction or rolls it back.",
    }),
  ]).flatMap((item) => item.suggestedReviewTopics);
  assert.match(blank.explanation, /left unanswered/);
  assert.doesNotMatch(blank.explanation, /confusion between|DDL|DBMS/);
  assert.match(blank.studyTip, /example from the lesson/);
  assert.doesNotMatch(boolean.explanation, /confusion between False and True/);
  assert.match(boolean.studyTip, /detail that makes the statement true or false/);
});

test("concept review merges duplicate misses and retains the most useful saved explanation", () => {
  const feedback = buildPracticeFeedback([
    answer(false, { explanation: "" }),
    answer(false),
  ])[0];
  assert.equal(feedback.suggestedReviewTopics.length, 1);
  assert.match(feedback.suggestedReviewTopics[0].explanation, /rolls it back/);
});

test("history queries are bounded and scoped to account, course and module", async () => {
  const history = await loadPracticeHistory(
    [4, 8, "module-a"],
    {
      execute: async (sql, params) => {
        assert.match(sql, /user_id=\? AND course_id=\? AND module_id=\?/);
        assert.match(sql, /LIMIT 20/);
        assert.match(sql, /\(completed_at, attempt_id\) </);
        assert.deepEqual(params, [4, 8, "module-a", 7]);
        return [
          [
            {
              attempt_id: 6,
              questions_json: "[]",
              result_json: JSON.stringify({ answers: [answer(false)] }),
            },
          ],
        ];
      },
    },
    7,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].attemptId, 6);
});

test("recurring historical weaknesses reserve real slots in the next ten questions, even after 100%", async () => {
  const module = {
    id: "transactions",
    title: "Databases",
    learningObjectives: "Manage transactions",
    lessonPages: [
      {
        title: "Transaction Management",
        content:
          "Atomicity completes all transaction operations or rolls them back. Durability preserves committed changes.",
      },
    ],
  };
  const topics = [];
  let count = 0;
  const questions = await generatePracticeQuestions(
    module,
    [answer(true)],
    [],
    {
      history: [{ answers: [answer(false)] }, { answers: [answer(false)] }],
      generateBatch: async (batch) => {
        assert.equal(batch.difficulty, "medium");
        topics.push(...batch.practiceFocus.target_topics);
        assert.equal(
          batch.practiceFocus.missed_concepts[0].userAnswer,
          "Durability",
        );
        const generated = batch.types.map((type, index) => ({
          question: `Transaction scenario ${++count}?`,
          type,
          options:
            type === "multiple_choice"
              ? ["Atomicity", "Durability", "Consistency", "Isolation"]
              : [],
          correct_answer: "Atomicity",
          explanation: "All operations complete or none do.",
          topic:
            batch.practiceFocus.target_topics[index] || "Transaction review",
          concept: `Application ${count}`,
          thinking_skill: batch.skills[index],
          cognitive_level: "Understand",
        }));
        batch.onValidated(generated);
        return generated;
      },
    },
  );
  assert.equal(questions.length, 10);
  assert.equal(topics.length, 6);
  assert.equal(
    questions.filter((item) => item.topic === "Transaction Management").length,
    6,
  );
});

test("target allocation changes when recurring historical weaknesses change", async () => {
  const module = {
    id: "db",
    title: "Databases",
    lessonPages: [
      {
        title: "Concepts",
        content:
          "Atomicity concerns whole transactions. Indexes accelerate searches. Views show data.",
      },
    ],
  };
  const capture = async (history) => {
    const topics = [];
    let id = 0;
    await generatePracticeQuestions(
      module,
      [answer(true, { topic: "Views" })],
      [],
      {
        history,
        generateBatch: async (batch) => {
          topics.push(...batch.practiceFocus.target_topics);
          return batch.types.map((type) => ({
            question: `Scenario ${++id}?`,
            type,
            options: type === "multiple_choice" ? ["A", "B", "C", "D"] : [],
          }));
        },
      },
    );
    return topics;
  };
  const tx = await capture([{ answers: [answer(false)] }]);
  const indexes = await capture([
    { answers: [answer(false, { topic: "Indexes", concept: "Search" })] },
  ]);
  assert.deepEqual(tx, Array(6).fill("Transaction Management"));
  assert.deepEqual(indexes, Array(6).fill("Indexes"));
});

test("a generator cannot ignore an assigned weak topic and return an unrelated question", async () => {
  let drafts = 0;
  await assert.rejects(
    generateQuizBatch(
      {
        types: ["true_false"],
        skills: ["LOTS"],
        chunks: [
          {
            chunk_id: 1,
            chunk_text: "Atomicity makes all operations complete or none do.",
            source_filename: "Transactions",
          },
        ],
        practiceFocus: {
          target_count: 1,
          target_topics: ["Transaction Management"],
          missed_concepts: [],
        },
      },
      async () => {
        drafts++;
        return {
          questions: [
            {
              type: "true_false",
              question: "Atomicity makes a transaction all-or-nothing.",
              options: ["True", "False"],
              correct_answer: "True",
              explanation: "All operations complete or none do.",
              topic: "Unrelated topic",
              cognitive_level: "Understand",
              thinking_skill: "LOTS",
              evidence_ids: ["c1-e0"],
            },
          ],
        };
      },
    ),
    /assigned weak topic/,
  );
  assert.equal(drafts, 3);
});

test("ANSI-SPARC direct level keys reject swapped internal/external roles", () => {
  for (const [question, correct_answer] of [
    ["Which ANSI-SPARC level describes physical storage?", "External Level"],
    [
      "Which database architecture level describes user views?",
      "Internal Level",
    ],
  ])
    assert.throws(
      () => validateKnownAnswerKey({ question, correct_answer }),
      /Inconsistent ANSI-SPARC/,
    );
  validateKnownAnswerKey({
    question: "Which ANSI-SPARC level describes physical storage?",
    correct_answer: "Internal Level",
  });
  validateKnownAnswerKey({
    question: "Which database architecture level describes user views?",
    correct_answer: "External Level",
  });
  assert.throws(
    () =>
      validateKnownAnswerKey({
        type: "true_false",
        question:
          "The external level of database architecture describes physical storage.",
        correct_answer: "True",
      }),
    /Inconsistent ANSI-SPARC/,
  );
  validateKnownAnswerKey({
    type: "true_false",
    question:
      "The external level of database architecture describes physical storage.",
    correct_answer: "False",
  });
});

test("generation repairs a swapped ANSI-SPARC key before it can be saved or graded", async () => {
  let drafts = 0;
  const questions = await generateQuizBatch(
    {
      types: ["identification"],
      skills: ["LOTS"],
      chunks: [
        {
          chunk_id: 1,
          source_filename: "Database architecture",
          chunk_text:
            "The internal level describes physical storage. The external level describes user views.",
        },
      ],
    },
    async (request) => {
      if (!request.schema.properties.questions)
        return { verdicts: [{ question_index: 0, supported: true }] };
      drafts++;
      if (drafts === 2)
        assert.match(request.data.correction, /Inconsistent ANSI-SPARC/);
      return {
        questions: [
          {
            question: "Which ANSI-SPARC level describes physical storage?",
            type: "identification",
            options: [],
            correct_answer: drafts === 1 ? "External Level" : "Internal Level",
            explanation: "The internal level describes physical storage.",
            topic: "Database architecture",
            concept: "Internal Level",
            cognitive_level: "Understand",
            thinking_skill: "LOTS",
            evidence_ids: ["c1-e0"],
          },
        ],
      };
    },
  );
  assert.equal(drafts, 2);
  assert.equal(questions[0].correct_answer, "Internal Level");
});

test("historical questions with a known incorrect key do not contribute to measured accuracy", async () => {
  const [history] = await loadPracticeHistory([1, 2, "db"], {
    execute: async () => [
      [
        {
          attempt_id: 1,
          questions_json: JSON.stringify([
            {
              question: "Which ANSI-SPARC level describes physical storage?",
              correct_answer: "External Level",
            },
          ]),
          result_json: JSON.stringify({ answers: [answer(false)] }),
        },
      ],
    ],
  });
  assert.equal(history.answers[0].answerKeyValid, false);
  const feedback = buildPracticeFeedback([answer(true)], [history])[0];
  assert.equal(feedback.historicalTotal, 1);
  assert.equal(feedback.historicalAccuracy, 100);
  assert.equal(feedback.recurring, false);
});

test("diversity rejects near copies and preserves different scenarios about one weak concept", () => {
  assert.throws(
    () =>
      validateQuizUniqueness([
        {
          question:
            "Which database transaction property guarantees that every operation succeeds completely or rolls back?",
        },
        {
          question:
            "Which database transaction property guarantees that every operation succeeds completely or rolls back fully?",
        },
      ]),
    /Duplicate/,
  );
  assert.equal(
    validateQuizUniqueness([
      {
        question:
          "A transfer debits one account but its credit fails. Which property requires rolling back the debit?",
      },
      {
        question:
          "After a power failure, a committed payment remains saved. Which property explains this behavior?",
      },
    ]).length,
    2,
  );
});
