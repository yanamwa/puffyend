import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { resendOtp } from "../src/controllers/authController.js";

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
