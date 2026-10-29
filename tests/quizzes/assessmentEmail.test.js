import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = readFileSync(
  new URL("../../src/controllers/monitoringController.js", import.meta.url),
  "utf8",
);
const handler = source
  .slice(
    source.indexOf("export async function emailAssessmentResult"),
    source.indexOf("export async function getAssessmentAttempts"),
  )
  .replace("export ", "");
async function run({ denied = false, rows = [], fail = false } = {}) {
  const sent = [];
  const queries = [];
  const context = vm.createContext({
    console: { error() {} },
    parseJsonList: JSON.parse,
    assertCourseAccess: async () => {
      if (denied)
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    },
    db: {
      execute: async (sql, args) => {
        queries.push(args);
        return [rows];
      },
    },
    sendQuizResultEmail: async (...args) => {
      if (fail) throw new Error("SMTP");
      sent.push(args);
    },
  });
  vm.runInContext(handler + ";this.handler=emailAssessmentResult", context);
  const response = {
    code: 200,
    status(n) {
      this.code = n;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await context.handler(
    {
      user: {},
      params: { courseId: "7", attemptId: "23" },
      body: { email: "attacker@example.com", score: 100 },
    },
    response,
  );
  return { response, sent, queries };
}
const row = {
  assessment_type: "main",
  email: "student@example.com",
  student_name: "Student",
  course_title: "Course",
  score: 1,
  total: 2,
  answers_json: JSON.stringify([
    { question: "Q", selected_answer: false, correct_answer: true },
  ]),
};
test("emails saved recipient, score and personalized answers", async () => {
  const { response, sent, queries } = await run({ rows: [row] });
  assert.equal(response.code, 200);
  assert.equal(sent[0][0], row.email);
  assert.ok(sent[0][2].includes("Score: 1 / 2"));
  assert.match(sent[0][2], /Student answer: false/);
  assert.match(sent[0][2], /Correct answer: true/);
  assert.deepEqual(Array.from(queries[0]), [23, 7]);
});
test("denies unauthorized course access before loading results", async () => {
  const { response, sent, queries } = await run({ denied: true });
  assert.equal(response.code, 403);
  assert.equal(sent.length, 0);
  assert.equal(queries.length, 0);
});
test("rejects missing response, invalid email and missing key", async () => {
  for (const [rows, code] of [
    [[], 404],
    [[{ ...row, email: "" }], 400],
    [[{ ...row, answers_json: "[]" }], 409],
  ]) {
    const result = await run({ rows });
    assert.equal(result.response.code, code);
    assert.equal(result.sent.length, 0);
  }
});
test("reports SMTP failures without claiming success", async () => {
  const { response } = await run({ rows: [row], fail: true });
  assert.equal(response.code, 502);
  assert.equal(response.body.success, false);
});
