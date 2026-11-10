import test, { after } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { db } from "../src/db.js";
import { resendOtp } from "../src/controllers/authController.js";

after(() => db.end());

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("OTP resend rejects requests while the existing code is active", async (context) => {
  const query = context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("SELECT *")) return [[{ userId: 1, is_verified: 0 }]];
    assert.match(sql, /otp_seconds_remaining/);
    return [[{ otp_seconds_remaining: 240 }]];
  });
  const response = createResponse();

  await resendOtp({ body: { email: "professor@example.test" } }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.body.otpSecondsRemaining, 240);
  assert.equal(query.mock.callCount(), 2);
});

test("simultaneous OTP resends cannot replace a newly requested code", async (context) => {
  let timingQueries = 0;
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("SELECT *")) return [[{ userId: 1, is_verified: 0 }]];
    if (sql.includes("UPDATE users")) {
      assert.match(sql, /otp_expires IS NULL OR otp_expires <= NOW\(\)/);
      return [{ affectedRows: 0 }];
    }
    timingQueries += 1;
    return [[{ otp_seconds_remaining: timingQueries === 1 ? 0 : 300 }]];
  });
  const response = createResponse();

  await resendOtp({ body: { email: "professor@example.test" } }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.body.otpSecondsRemaining, 300);
});

test("an unsuccessful OTP email releases the resend cooldown", async (context) => {
  const smtpSettings = {
    OTP_SMTP_HOST: "smtp.example.test",
    OTP_SMTP_PORT: "587",
    OTP_SMTP_USERNAME: "sender@example.test",
    OTP_SMTP_PASSWORD: "test",
    OTP_SMTP_FROM_EMAIL: "sender@example.test",
  };
  for (const [key, value] of Object.entries(smtpSettings)) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  const email = "professor@example.test";
  const user = { userId: 1, email, name: "Sample Professor", is_verified: 0 };
  let savedOtp;
  let accepted = false;
  context.mock.method(db, "execute", async (sql, args) => {
    if (sql.includes("SELECT *")) return [[user]];
    if (sql.includes("otp_seconds_remaining")) {
      return [[{ otp_seconds_remaining: savedOtp ? 300 : 0 }]];
    }
    if (sql.includes("SET otp_code = NULL")) {
      assert.match(sql, /AND otp_code = \? AND is_verified = 0/);
      assert.deepEqual(args, [user.userId, savedOtp]);
      savedOtp = null;
    } else {
      assert.match(sql, /SET\s+otp_code = \?/);
      savedOtp = args[0];
    }
    return [{ affectedRows: 1 }];
  });
  context.mock.method(nodemailer, "createTransport", () => ({
    async sendMail() {
      if (!accepted) throw new Error("Mock delivery error");
      return { accepted: [email] };
    },
  }));
  context.mock.method(console, "error", () => {});

  const failed = createResponse();
  await resendOtp({ body: { email } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.equal(savedOtp, null);

  accepted = true;
  const retried = createResponse();
  await resendOtp({ body: { email } }, retried);
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.otpSecondsRemaining, 300);
});
