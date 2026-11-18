import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import nodemailer from "nodemailer";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import {
  mainQuizStatus,
  startMainQuiz,
  submitMainQuiz,
} from "../../src/services/quizzes/mainQuizService.js";

test("Main Quiz opens without email verification and allows one submission", async (context) => {
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
  await db.execute(
    "INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')",
    [courseId, user.userId],
  );

  const getStatus = () => mainQuizStatus(user, courseId, moduleId);
  const drafts = async () =>
    (await engine.query("SELECT quiz_id FROM personalized_main_quizzes")).rows;
  await assert.rejects(
    startMainQuiz({ ...user, userId: -1 }, body),
    /not enrolled/,
  );
  assert.deepEqual(await getStatus(), {
    taken: false,
    verificationRequired: false,
  });
  assert.deepEqual(await drafts(), []);

  const quiz = await startMainQuiz(user, body);
  assert.equal((await drafts()).length, 1);
  assert.equal((await startMainQuiz(user, body)).quizId, quiz.quizId);
  const submission = {
    quiz_id: quiz.quizId,
    answers: ["True"],
  };
  const result = await submitMainQuiz(user, submission);
  assert.equal(result.score, 1);
  await assert.rejects(
    submitMainQuiz(user, submission),
    /already been submitted/,
  );
  await engine.exec("UPDATE main_quiz_configs SET revision = revision + 1");
  assert.deepEqual(await getStatus(), { taken: true });
  await assert.rejects(
    startMainQuiz(user, body),
    /already been submitted/,
  );
  assert.equal((await drafts()).length, 1);
  assert.deepEqual(messages, []);
});
