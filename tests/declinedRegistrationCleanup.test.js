import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { cleanupDeclinedRegistrations } from "../src/services/declinedRegistrationCleanup.js";
import { signup } from "../src/controllers/authController.js";

test("cleanup removes only expired declined professor registrations and rechecks before deletion", async (context) => {
  const query = context.mock.method(db, "execute", async (sql, values) => {
    assert.match(sql, /role = 'professor'/);
    assert.match(sql, /verification_status = 'declined'/);
    assert.match(sql, /professor_declined_at <= DATE_SUB\(NOW\(\), INTERVAL 24 HOUR\)/);
    if (sql.includes("SELECT")) {
      assert.deepEqual(values, ["professor@example.test"]);
      return [[{ userId: 1 }, { userId: 2 }]];
    }
    return [{ affectedRows: values[0] === 1 ? 1 : 0 }];
  });
  assert.equal(await cleanupDeclinedRegistrations("professor@example.test"), 1);
  assert.equal(query.mock.callCount(), 3);
});

for (const declined of [true, false]) {
  test(`signup ${declined ? "explains the decline waiting period" : "keeps ordinary duplicate-email handling"}`, async (context) => {
    context.mock.method(db, "execute", async (sql) => {
      if (sql.includes("DATE_SUB")) return [[]];
      assert.match(sql, /SELECT userId, role, verification_status/);
      return [[{ userId: 1, role: "professor", verification_status: declined ? "declined" : "approved", retry_after_seconds: 7200 }]];
    });
    const response = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    await signup({ body: {
      name: "Test Professor", email: "professor@example.test", password: "TestPassword123!",
      department: "Computer Science", employmentProof: "/api/uploads/professor-ids/test.png",
    } }, response);
    assert.equal(response.statusCode, 409);
    if (declined) {
      assert.equal(response.body.code, "REGISTRATION_DECLINED");
      assert.equal(response.body.retryAfterSeconds, 7200);
      assert.match(response.body.message, /2 hours/);
      assert.match(response.body.message, /24-hour waiting period/);
    } else {
      assert.equal(response.body.message, "Email is already registered.");
    }
  });
}
