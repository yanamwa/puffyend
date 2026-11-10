import test, { after } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { db } from "../src/db.js";
import { updateProfessorRegistration } from "../src/controllers/userController.js";

after(() => db.end());

function response() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function mockMailer(context, sendMail) {
  context.mock.method(nodemailer, "createTransport", () => ({ sendMail }));
  const previous = {};
  for (const [key, value] of Object.entries({ HOST: "smtp.example.test", PORT: "587", USERNAME: "test", PASSWORD: "test", FROM_EMAIL: "sender@example.test" })) {
    const name = `OTP_SMTP_${key}`;
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("decline requires a reason before updating any account", async (context) => {
  const query = context.mock.method(db, "execute", async () => assert.fail("Unexpected database access"));
  const result = response();
  await updateProfessorRegistration({ params: { id: "1" }, body: { status: "declined", reason: " " } }, result);
  assert.equal(result.statusCode, 400);
  assert.equal(query.mock.callCount(), 0);
});

for (const status of ["approved", "declined"]) {
  test(`${status} sends a decision to the professor's registered email`, async (context) => {
    const messages = [];
    const queries = [];
    const reason = "Please upload a clearer ID. <script>unsafe</script>";
    mockMailer(context, async (message) => {
      messages.push(message);
      return { accepted: [message.to] };
    });
    context.mock.method(db, "execute", async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes("FROM system_settings")) return [[{ professor_approval_notification: 1 }]];
      if (sql.includes("SELECT")) return [[{ id: 1, userId: 1, role: "professor", name: "Professor Test", email: "professor@example.test", verification_status: status }]];
      return [{ affectedRows: 1, insertId: 1 }];
    });
    const result = response();
    await updateProfessorRegistration({ params: { id: "1" }, body: { status, reason } }, result);
    assert.equal(result.body.success, true);
    assert.equal(result.body.emailSent, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, "professor@example.test");
    assert.match(messages[0].text, new RegExp(status));
    if (status === "declined") {
      assert.ok(messages[0].text.includes(reason));
      assert.ok(!messages[0].html.includes("<script>"));
      assert.ok(queries.some(query => query.sql.includes("INSERT INTO audit_logs") && query.values.some(value => String(value).includes(reason))));
    }
  });
}

test("mail failure reports the saved decision without claiming the email was sent", async (context) => {
  mockMailer(context, async () => { throw new Error("Test delivery failure"); });
  context.mock.method(db, "execute", async (sql) => {
    if (sql.includes("FROM system_settings")) return [[{ professor_approval_notification: 1 }]];
    if (sql.includes("SELECT")) return [[{ id: 1, userId: 1, role: "professor", email: "professor@example.test", verification_status: "approved" }]];
    return [{ affectedRows: 1, insertId: 1 }];
  });
  context.mock.method(console, "error", () => {});
  const result = response();
  await updateProfessorRegistration({ params: { id: "1" }, body: { status: "approved" } }, result);
  assert.equal(result.body.success, true);
  assert.equal(result.body.emailSent, false);
  assert.match(result.body.message, /could not be sent/);
});
