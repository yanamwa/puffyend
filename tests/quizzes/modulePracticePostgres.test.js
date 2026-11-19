import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import { getQuizAttempts } from "../../src/controllers/monitoringController.js";
import { studentPracticeHistory } from "../../src/services/quizzes/studentQuizHistory.js";
import {
  startModulePractice,
  submitModulePractice,
} from "../../src/services/quizzes/modulePracticeService.js";

after(() => db.end());

test("PostgreSQL saves six practices, resumes once, and repairs a five-question set", async (context) => {
  const engine = new PGlite();
  await engine.exec(
    "CREATE SCHEMA puffybrain; SET search_path=puffybrain,public",
  );
  const query = (...args) => engine.query(...args);
  const original = { ...db };
  Object.assign(
    db,
    createDatabase({ query, connect: async () => ({ query, release() {} }) }),
  );
  const previousPassword = process.env.SUPER_ADMIN_PASSWORD;
  process.env.SUPER_ADMIN_PASSWORD = "";
  context.after(async () => {
    Object.assign(db, original);
    if (previousPassword === undefined) delete process.env.SUPER_ADMIN_PASSWORD;
    else process.env.SUPER_ADMIN_PASSWORD = previousPassword;
    await engine.close();
  });
  await migrateApplication();
  const [student] = await db.execute(
    "INSERT INTO users(name,email,password,role) VALUES('Practice student','practice@example.test','hash','student')",
  );
  const user = { userId: student.insertId, role: "student" };
  const module = {
    id: "database",
    title: "Introduction to Database",
    studentPublished: true,
    lessonPages: [
      { title: "Databases", content: "A database stores organized data." },
    ],
    quizItems: [],
  };
  const [course] = await db.execute(
    "INSERT INTO courses(title,code,summary,subject,content_modules,lesson_pages) VALUES('Information Management','IM-PRACTICE','','Computing',?,?)",
    [
      JSON.stringify([module]),
      JSON.stringify(
        module.lessonPages.map((page) => ({ ...page, moduleId: module.id })),
      ),
    ],
  );
  const scope = { courseId: course.insertId, moduleId: module.id };
  await db.execute(
    "INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')",
    [scope.courseId, user.userId],
  );
  let generations = 0;
  const generate = async () =>
    Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      question: `Set ${generations}, fact ${index + 1}?`,
      type: "true_false",
      options: ["True", "False"],
      correct_answer: "True",
      topic: "Databases",
      explanation: "A database stores organized data.",
    }));
  const fresh = async (...args) => {
    generations++;
    return generate(...args);
  };
  const readCount = async () => {
    let payload;
    await getQuizAttempts(
      {
        user,
        query: { ...scope, source: "module", quizMode: "adaptive_practice" },
      },
      {
        json(body) {
          payload = body;
        },
        status(code) {
          assert.fail(`Attempt count failed: ${code}`);
        },
      },
    );
    return payload.attempts;
  };
  for (let count = 1; count <= 6; count++) {
    const body = { ...scope, mode: count % 2 ? "multiple" : "timed" };
    const attempt = await startModulePractice(user, body, fresh);
    assert.equal(attempt.questions.length, 10);
    assert.equal((await startModulePractice(user, body, fresh)).id, attempt.id);
    assert.equal(await readCount(), count - 1);
    const submission = {
      attemptId: attempt.id,
      mode: body.mode,
      answers: attempt.questions.map(({ id }) => ({
        questionId: id,
        answer: "True",
      })),
    };
    const result = await submitModulePractice(user, submission);
    assert.equal(result.total, 10);
    assert.equal(result.score, 10);
    assert.equal(result.attempts, count);
    assert.equal(result.feedback[0].latestAccuracy, 100);
    assert.equal(result.feedback[0].historicalTotal, count * 10);
    assert.equal(result.feedback[0].gradedAttempts, count);
    assert.equal(
      (await submitModulePractice(user, submission)).attempts,
      count,
    );
    assert.equal(await readCount(), count);
  }
  assert.equal(generations, 6);
  assert.equal((await studentPracticeHistory(user))[0].attempts.length, 6);

  const unfinished = await startModulePractice(
    user,
    { ...scope, mode: "multiple" },
    fresh,
  );
  await db.execute(
    "UPDATE module_practice_attempts SET questions_json=? WHERE attempt_id=?",
    [JSON.stringify((await generate()).slice(0, 5)), unfinished.id],
  );
  const repaired = await startModulePractice(
    user,
    { ...scope, mode: "multiple" },
    fresh,
  );
  assert.equal(repaired.id, unfinished.id);
  assert.equal(repaired.questions.length, 10);
  assert.equal(await readCount(), 6);
  const [[details]] = await db.execute(
    "SELECT COUNT(*) AS total FROM quiz_attempt_details WHERE assessment_type='practice'",
  );
  assert.equal(Number(details.total), 6);

  await assert.rejects(
    startModulePractice(user, { ...scope, mode: "qna" }, async () =>
      (await generate()).slice(0, 5),
    ),
    {
      statusCode: 502,
      message: "We couldn't prepare 10 practice questions. Please try again.",
    },
  );

  const badKey = {
    ...(await generate())[0],
    question: "Which ANSI-SPARC level describes physical storage?",
    type: "identification",
    options: [],
    correct_answer: "External Level",
  };
  const badQuestions = [badKey, ...(await generate()).slice(1)];
  await db.execute(
    "UPDATE module_practice_attempts SET questions_json=? WHERE attempt_id=?",
    [JSON.stringify(badQuestions), unfinished.id],
  );
  await assert.rejects(
    submitModulePractice(user, {
      attemptId: unfinished.id,
      mode: "multiple",
      answers: badQuestions.map(({ id, correct_answer }) => ({
        questionId: id,
        answer: correct_answer,
      })),
    }),
    { code: "PRACTICE_KEY_INVALID" },
  );
  const refreshed = await startModulePractice(
    user,
    { ...scope, mode: "multiple" },
    fresh,
  );
  assert.equal(refreshed.id, unfinished.id);
  assert.notEqual(refreshed.questions[0].correct_answer, "External Level");
  assert.equal(await readCount(), 6);
});
