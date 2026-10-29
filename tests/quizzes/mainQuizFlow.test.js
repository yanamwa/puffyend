import assert from "node:assert/strict";
import { db } from "../../src/db.js";
import {
  saveMainQuizPreview,
  baselineQuestionBlueprint,
  savedLessonChunks,
  saveMainConfig,
  validateManualQuestions,
  listGeneratedMainQuizzes,
  getMainConfig,
  startMainQuiz,
  submitMainQuiz,
} from "../../src/services/quizzes/mainQuizService.js";
const originalExecute = db.execute,
  originalGetConnection = db.getConnection;
const user = { userId: 8, role: "student" },
  config = {
    questionCount: 1,
    multipleChoiceCount: 0,
    identificationCount: 0,
    trueFalseCount: 1,
    documentIds: [],
    passingPercentage: 60,
    attemptLimit: 2,
    moduleIndex: 0,
  };
const question = {
  question: "Is sunlight used by plants?",
  type: "true_false",
  options: ["True", "False"],
  correct_answer: "True",
  explanation: "Plants use sunlight.",
  topic: "Plants",
  cognitive_level: "Understand",
  thinking_skill: "LOTS",
};
const saved = {
  quiz_id: 10,
  course_id: 1,
  module_id: "module-1",
  user_id: 8,
  revision: 1,
  questions_json: JSON.stringify([question]),
  config_json: JSON.stringify(config),
  submissions: 0,
};
let approved = true,
  locked = false,
  revision = 1,
  commits = 0,
  rollbacks = 0,
  missingSavedQuiz = false;
async function execute(sql, args) {
  if (sql.includes("FROM course_enrollments"))
    return [approved ? [{ user_id: 8 }] : []];
  if (sql.includes("FROM courses")) {
    assert.ok(
      !sql.includes("SELECT lesson_contents"),
      "Use actual course storage columns",
    );
    return [
      [
        {
          lesson_contents: JSON.stringify([
            {
              moduleId: "module-1",
              moduleIndex: 0,
              statements: [{ citations: [{ document_id: 9 }] }],
              mainQuizSettings: { enabled: !locked },
            },
          ]),
          quiz_contents: "[]",
        },
      ],
    ];
  }
  if (sql.includes("FROM main_quiz_configs"))
    return [[{ revision, config_json: JSON.stringify(config) }]];
  if (sql.includes("FROM personalized_main_quizzes"))
    return [missingSavedQuiz ? [] : [{ ...saved }]];
  if (
    sql.includes("FROM quiz_attempts") ||
    sql.includes("FROM lesson_source_documents")
  )
    return [[]];
  if (sql.startsWith("UPDATE main_quiz_configs")) {
    const edited = JSON.parse(args[0]);
    assert.equal(edited.questionCount, 1);
    assert.equal(edited.trueFalseCount, 1);
    assert.equal(
      edited.baselineQuestions[0].explanation,
      "Edited explanation.",
    );
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith("INSERT")) return [{ insertId: 77 }];
  if (sql.startsWith("UPDATE personalized")) {
    saved.submissions++;
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected SQL ${sql}`);
}
db.execute = execute;
db.getConnection = async () => ({
  execute,
  beginTransaction: async () => {},
  commit: async () => {
    commits++;
  },
  rollback: async () => {
    rollbacks++;
  },
  release: () => {},
});
try {
  const lessonChunks = savedLessonChunks(
    [
      {
        moduleId: "module-1",
        title: "Plants",
        content: "Plants use sunlight for photosynthesis.",
      },
      { moduleId: "other", content: "Other course content." },
    ],
    "module-1",
  );
  assert.equal(lessonChunks.length, 1);
  assert.equal(
    lessonChunks[0].chunk_text,
    "Plants use sunlight for photosynthesis.",
  );
  validateManualQuestions([question]);
  const editedConfig = await saveMainQuizPreview(
    { userId: 1, role: "admin" },
    {
      course_id: 1,
      module_id: "module-1",
      questions: [{ ...question, explanation: "Edited explanation." }],
    },
  );
  assert.equal(
    editedConfig.baselineQuestions[0].explanation,
    "Edited explanation.",
  );
  assert.equal(
    baselineQuestionBlueprint(editedConfig.baselineQuestions).lotsCount,
    1,
  );
  await assert.rejects(
    () =>
      saveMainQuizPreview(user, {
        course_id: 1,
        module_id: "module-1",
        questions: [question],
      }),
    /cannot edit/,
  );
  await assert.rejects(
    () =>
      saveMainQuizPreview(
        { userId: 1, role: "admin" },
        {
          course_id: 1,
          module_id: "module-1",
          questions: [{ ...question, correct_answer: "" }],
        },
      ),
    /Complete every/,
  );
  assert.throws(
    () => validateManualQuestions([{ ...question, correct_answer: "" }]),
    /Complete every/,
  );
  assert.throws(
    () => validateManualQuestions([question, question]),
    /duplicate/,
  );
  const generated = await listGeneratedMainQuizzes(
    { userId: 1, role: "admin" },
    1,
    "module-1",
  );
  assert.equal(generated[0].questions[0].correct_answer, "True");
  await assert.rejects(
    () => listGeneratedMainQuizzes(user, 1, "module-1"),
    /cannot edit/,
  );
  const savedConfig = await saveMainConfig(
    { userId: 1, role: "admin" },
    {
      course_id: 1,
      module_id: "module-1",
      question_count: 20,
      multiple_choice_count: 10,
      identification_count: 5,
      true_false_count: 5,
      passing_percentage: 70,
    },
  );
  assert.deepEqual(savedConfig.documentIds, ["9"]);
  const mainConfig = await getMainConfig(
    { userId: 1, role: "admin" },
    1,
    "module-1",
  );
  assert.deepEqual(mainConfig, config);
  await assert.rejects(() => getMainConfig(user, 1, "module-1"), /cannot edit/);
  const quiz = await startMainQuiz(user, {
    course_id: 1,
    module_id: "module-1",
  });
  assert.equal(quiz.quizId, 10);
  assert.ok(!("correct_answer" in quiz.questions[0]));
  missingSavedQuiz = true;
  await assert.rejects(
    () => startMainQuiz(user, { course_id: 1, module_id: "module-1" }),
    /No indexed source evidence/,
  );
  missingSavedQuiz = false;
  approved = false;
  await assert.rejects(
    () => startMainQuiz(user, { course_id: 1, module_id: "module-1" }),
    /not enrolled/,
  );
  approved = true;
  locked = true;
  await assert.rejects(
    () => startMainQuiz(user, { course_id: 1, module_id: "module-1" }),
    /locked/,
  );
  locked = false;
  const first = await submitMainQuiz(user, {
    quiz_id: 10,
    answers: ["False"],
    score: 999,
  });
  assert.equal(first.score, 0);
  assert.equal(first.passed, false);
  assert.equal(first.answers[0].correct_answer, "True");
  assert.equal(commits, 1);
  await assert.rejects(
    () => submitMainQuiz(user, { quiz_id: 10, answers: ["True"] }),
    /already been submitted and recorded/,
  );
  assert.equal(rollbacks, 1);
  await assert.rejects(
    () => startMainQuiz(user, { course_id: 1, module_id: "module-1" }),
    /already been submitted and recorded/,
  );
  saved.submissions = 0;
  revision = 2;
  await assert.rejects(
    () => submitMainQuiz(user, { quiz_id: 10, answers: ["True"] }),
    /configuration changed/,
  );
  console.log(
    "Saved quiz privacy, enrollment, access locks, attempt limits, stale configurations, transactions, and backend scoring checks passed.",
  );
} finally {
  db.execute = originalExecute;
  db.getConnection = originalGetConnection;
  await db.end();
}
