import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import nodemailer from "nodemailer";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import {
  mainQuizStatus,
  requestMainQuizCode,
  startMainQuiz,
  submitMainQuiz,
  verifyMainQuizCode,
} from "../../src/services/quizzes/mainQuizService.js";
import { mainQuizSessionHash } from "../../src/services/quizzes/mainQuizVerification.js";

test("Main Quiz requires email verification and preserves exactly one submission", async (context) => {
  const engine = new PGlite();
  await engine.exec(
    "CREATE SCHEMA puffybrain; SET search_path=puffybrain,public",
  );
  const query = (...args) => engine.query(...args);
  Object.assign(
    db,
    createDatabase({ query, connect: async () => ({ query, release() {} }) }),
  );
  context.after(() => engine.close());

  Object.assign(process.env, {
    SUPER_ADMIN_PASSWORD: "",
    OTP_SMTP_HOST: "smtp.example.test",
    OTP_SMTP_PORT: "587",
    OTP_SMTP_USERNAME: "test-user",
    OTP_SMTP_PASSWORD: "test-password",
    OTP_SMTP_FROM_EMAIL: "mail@example.test",
  });
  const messages = [];
  context.mock.method(nodemailer, "createTransport", () => ({
    async sendMail(message) {
      messages.push(message);
      return { accepted: [message.to.address] };
    },
  }));

  await migrateApplication();
  const email = "student@example.test";
  const [studentRow] = await db.execute(
    "INSERT INTO users(name,email,password,role,is_verified) VALUES('Student',?,'fake','student',1)",
    [email],
  );
  const user = { userId: studentRow.insertId, role: "student", email };
  const moduleId = "module-1";
  const questions = [
    {
      type: "true_false",
      question: "Is sunlight used by plants?",
      options: ["True", "False"],
      correct_answer: "True",
      explanation: "Plants use light energy.",
      topic: "Plants",
      cognitive_level: "Understand",
      thinking_skill: "LOTS",
    },
  ];
  const [course] = await db.execute(
    "INSERT INTO courses(title,code,summary,subject,lesson_pages) VALUES('Plants','PLANTS1','','Science',?)",
    [
      JSON.stringify([
        {
          moduleId,
          moduleIndex: 0,
          mainQuizSettings: { enabled: true, manualQuestions: questions },
        },
      ]),
    ],
  );
  const courseId = course.insertId;
  const body = { course_id: courseId, module_id: moduleId };
  const session = mainQuizSessionHash("Bearer student-session");
  const differentSession = mainQuizSessionHash("Bearer second-session");
  await db.execute(
    "INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')",
    [courseId, user.userId],
  );

  const getStatus = (hash = session) =>
    mainQuizStatus(user, courseId, moduleId, hash);
  const drafts = async () =>
    (await engine.query("SELECT quiz_id FROM personalized_main_quizzes")).rows;
  const confirm = (code, hash = session) =>
    verifyMainQuizCode(user, { ...body, code }, hash);
  const currentCode = () => messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
  assert.deepEqual(await getStatus(), {
    taken: false,
    verificationRequired: true,
  });
  await assert.rejects(startMainQuiz(user, body, session), /Verify your email/);
  await assert.rejects(
    requestMainQuizCode({ ...user, userId: -1 }, body, session),
    /not enrolled/,
  );
  assert.equal(messages.length, 0);
  assert.deepEqual(await drafts(), []);

  const pending = await requestMainQuizCode(
    user,
    { ...body, email: "other@example.test" },
    session,
  );
  assert.equal(pending.codeAvailable, true);
  await requestMainQuizCode(user, body, session);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to.address, email);
  const firstCode = currentCode();
  assert.match(firstCode, /^\d{6}$/);
  await assert.rejects(confirm(firstCode, differentSession), /no longer valid/);
  const wrongCode = firstCode === "000000" ? "000001" : "000000";
  for (let index = 0; index < 4; index++) {
    await assert.rejects(confirm(wrongCode), /incorrect/);
  }
  await assert.rejects(confirm(wrongCode), /no longer valid/);
  await assert.rejects(confirm(firstCode), /no longer valid/);
  assert.equal((await getStatus()).verificationRequired, true);

  await engine.exec(
    "UPDATE main_quiz_verifications SET resend_after = NOW() - INTERVAL '1 second'",
  );
  await requestMainQuizCode(user, body, session);
  assert.equal(messages.length, 2);
  assert.deepEqual(await confirm(currentCode()), { verified: true });
  assert.deepEqual(await getStatus(), {
    taken: false,
    verificationRequired: false,
  });
  assert.equal((await getStatus(differentSession)).verificationRequired, true);
  await assert.rejects(
    startMainQuiz(user, body, differentSession),
    /Verify your email/,
  );
  assert.deepEqual(await drafts(), []);

  const quiz = await startMainQuiz(user, body, session);
  assert.equal((await drafts()).length, 1);
  assert.equal((await startMainQuiz(user, body, session)).quizId, quiz.quizId);
  const result = await submitMainQuiz(user, {
    quiz_id: quiz.quizId,
    answers: ["True"],
  });
  assert.equal(result.score, 1);
  await engine.exec("UPDATE main_quiz_configs SET revision = revision + 1");
  assert.deepEqual(await getStatus(), { taken: true });
  await assert.rejects(
    startMainQuiz(user, body, session),
    /already been submitted/,
  );
  await assert.rejects(
    requestMainQuizCode(user, body, session),
    /already been submitted/,
  );
  assert.equal((await drafts()).length, 1);
});
