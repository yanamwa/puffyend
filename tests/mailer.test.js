import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import * as mailer from "../src/utils/mailer.js";

const recipient = "recipient@example.test";
const name = "Sample & Student";
const course = "Sample Course";
const resetLink = "https://app.example.test/change-password?token=test";
const quiz = {
  courseTitle: course,
  studentName: name,
  email: recipient,
  score: 1,
  total: 1,
  answers: [{ question: "Sample question", correct_answer: "A" }],
};
const examples = [
  ["verification code", "sendOtpEmail", [recipient, name, "1234"], /1234/],
  [
    "password reset",
    "sendPasswordResetEmail",
    [recipient, name, resetLink],
    /change-password/,
  ],
  [
    "temporary password",
    "sendStudentTemporaryPasswordEmail",
    [recipient, "sample-password"],
    /sample-password/,
  ],
  [
    "professor admin access",
    "sendProfessorAdminAccessEmail",
    [{ email: recipient, name }],
    /administrator access/,
  ],
  [
    "professor approval",
    "sendProfessorRegistrationDecisionEmail",
    [{ email: recipient, name, status: "approved" }],
    /approved/,
  ],
  [
    "professor decline",
    "sendProfessorRegistrationDecisionEmail",
    [{ email: recipient, name, status: "declined", reason: "Sample reason" }],
    /Sample reason/,
  ],
  [
    "enrollment request",
    "sendEnrollmentRequestEmail",
    [recipient, name, "Sample Learner", course],
    /Sample Learner/,
  ],
  [
    "enrollment approval",
    "sendEnrollmentAcceptedEmail",
    [recipient, name, course],
    /Sample Course/,
  ],
  [
    "enrollment decline",
    "sendEnrollmentDeclinedEmail",
    [recipient, name, course, "TEST01", "Sample reason"],
    /Sample reason/,
  ],
  [
    "unenrollment",
    "sendStudentUnenrolledEmail",
    [recipient, name, course, "Sample reason", "Sample Professor"],
    /Sample reason/,
  ],
  [
    "main quiz results",
    "sendQuizResultEmail",
    [recipient, "Quiz results", "Score: 1 of 1", quiz],
    /Score: 1 of 1/,
  ],
];

test("notification templates compose mail and require SMTP acceptance", async (context) => {
  const settings = {
    OTP_SMTP_HOST: "smtp.example.test",
    OTP_SMTP_PORT: "587",
    OTP_SMTP_USERNAME: "sender@example.test",
    OTP_SMTP_PASSWORD: "test",
    OTP_SMTP_FROM_EMAIL: "sender@example.test",
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  context.after(() => composer.close());

  for (const [label, method, args, expectedText] of examples) {
    await context.test(label, async (subtest) => {
      let accepted = [recipient];
      const sendMail = subtest.mock.fn(async (message) => {
        const composed = await composer.sendMail(message);
        assert.deepEqual(composed.envelope.to, [recipient]);
        assert.equal(composed.envelope.from, settings.OTP_SMTP_FROM_EMAIL);
        assert.ok(message.subject);
        assert.match(message.text, expectedText);
        assert.ok(composed.message.length > 0);
        if (method === "sendOtpEmail")
          assert.match(message.html, /Sample &amp; Student/);
        return { accepted };
      });
      subtest.mock.method(nodemailer, "createTransport", () => ({ sendMail }));

      await mailer[method](...args);
      assert.equal(sendMail.mock.callCount(), 1);
      accepted = [];
      await assert.rejects(
        mailer[method](...args),
        /did not accept the recipient/,
      );
      assert.equal(sendMail.mock.callCount(), 2);
    });
  }
});
