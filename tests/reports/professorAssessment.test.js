import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/controllers/reportController.js", import.meta.url),
  "utf8",
);
const scoreHelper = source.slice(
  source.indexOf("const percentage ="),
  source.indexOf("function dateBounds"),
);
const handler = source
  .slice(source.indexOf("export async function getProfessorAssessmentSummary"))
  .replace("export ", "");

async function run({
  user = { userId: 7, email: "Professor@Example.test", role: "professor" },
  courses = [
    { id: 42, title: "Understanding the Self", code: "PB-SELF" },
    { id: 43, title: "History", code: "PB-HISTORY" },
  ],
  threshold = 70,
  enrollments = [
    { courseId: 42, userId: 1, name: "Diana" },
    { courseId: 43, userId: 1, name: "Diana" },
    { courseId: 42, userId: 2, name: "Anya" },
  ],
  modules = [
    { courseId: 42, id: 10 },
    { courseId: 42, id: 11 },
    { courseId: 43, id: 20 },
  ],
  progress = [],
  attempts = [],
  fails = false,
} = {}) {
  const queries = [];
  let failure;
  const context = vm.createContext({
    db: {
      execute: async (sql, args = []) => {
        queries.push({ sql, args: Array.from(args) });
        if (fails) throw new Error("Database unavailable");
        if (/FROM courses c/.test(sql)) return [courses];
        if (/FROM system_settings/.test(sql))
          return [[{ passing_percentage: threshold }]];
        if (/FROM course_enrollments/.test(sql)) return [enrollments];
        if (/FROM learning_modules/.test(sql)) return [modules];
        if (/FROM lesson_progress/.test(sql)) return [progress];
        if (/FROM quiz_attempts/.test(sql)) return [attempts];
        throw new Error("Unexpected report query");
      },
    },
  });
  vm.runInContext(
    scoreHelper + handler + ";this.handler=getProfessorAssessmentSummary;",
    context,
  );
  const res = {
    code: 200,
    headers: {},
    status(code) {
      this.code = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = JSON.parse(JSON.stringify(body));
      return this;
    },
  };
  await context.handler(
    { user, query: { professorId: 999, courseId: 999 }, body: { userId: 999 } },
    res,
    (error) => {
      failure = error;
    },
  );
  return { res, queries, failure };
}

test("professor assessment queries use authenticated ownership and approved active enrollments", async () => {
  const { res, queries } = await run();
  assert.equal(res.code, 200);
  assert.deepEqual(queries[0].args, [
    7,
    "professor@example.test",
    "professor@example.test",
  ]);
  assert.match(queries[0].sql, /c\.professor_id = \?/);
  assert.match(queries[0].sql, /c\.professor_id IS NULL/);
  assert.match(queries[0].sql, /COALESCE\(c\.archived, 0\) = 0/);
  const enrollmentQuery = queries.find(({ sql }) =>
    /FROM course_enrollments/.test(sql),
  );
  assert.match(enrollmentQuery.sql, /ce\.status = 'approved'/);
  assert.match(enrollmentQuery.sql, /COALESCE\(ce\.archived, 0\) = 0/);
  assert.match(enrollmentQuery.sql, /COALESCE\(u\.is_archived, 0\) = 0/);
  assert.match(enrollmentQuery.sql, /u\.role = 'student'/);
  queries.slice(2).forEach(({ args }) => assert.deepEqual(args, [42, 43]));
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("averages and scored-attempt counts remain separate for each student and course", async () => {
  const { res } = await run({
    attempts: [
      { courseId: 42, userId: 1, score: 1, total: 10 },
      { courseId: 42, userId: 1, score: 2, total: 10 },
      { courseId: 43, userId: 1, score: 10, total: 10 },
      { courseId: 99, userId: 1, score: 10, total: 10 },
      { courseId: 42, userId: 99, score: 10, total: 10 },
    ],
  });
  const self = res.body.students.find(({ key }) => key === "42:1");
  const history = res.body.students.find(({ key }) => key === "43:1");
  assert.equal(self.averageScore, 15);
  assert.equal(self.scoredAttempts, 2);
  assert.equal(self.needsAttention, true);
  assert.equal(history.averageScore, 100);
  assert.equal(history.scoredAttempts, 1);
  assert.equal(history.needsAttention, false);
  assert.equal(res.body.students.length, 3);
});

test("zero scores count, unscored attempts do not, and threshold equality is not flagged", async () => {
  const { res } = await run({
    attempts: [
      { courseId: 42, userId: 1, score: 0, total: 10 },
      { courseId: 42, userId: 1, score: null, total: 10 },
      { courseId: 42, userId: 1, score: 5, total: 0 },
      { courseId: 42, userId: 1, score: "invalid", total: 10 },
      { courseId: 43, userId: 1, score: 7, total: 10 },
    ],
  });
  const zero = res.body.students.find(({ key }) => key === "42:1");
  const boundary = res.body.students.find(({ key }) => key === "43:1");
  const unassessed = res.body.students.find(({ key }) => key === "42:2");
  assert.equal(zero.averageScore, 0);
  assert.equal(zero.scoredAttempts, 1);
  assert.equal(zero.needsAttention, true);
  assert.equal(boundary.averageScore, 70);
  assert.equal(boundary.needsAttention, false);
  assert.equal(unassessed.averageScore, null);
  assert.equal(unassessed.scoredAttempts, 0);
  assert.equal(unassessed.needsAttention, false);
});

test("module completion counts distinct course modules and excludes unrelated or incomplete progress", async () => {
  const { res } = await run({
    progress: [
      { courseId: 42, userId: 1, lessonId: 10, progressPercent: 100 },
      { courseId: 42, userId: 1, lessonId: 10, progressPercent: 100 },
      { courseId: 42, userId: 1, lessonId: 11, progressPercent: 50 },
      { courseId: 42, userId: 1, lessonId: 20, progressPercent: 100 },
      { courseId: 42, userId: 2, lessonId: 10, progressPercent: "invalid" },
    ],
  });
  const self = res.body.students.find(({ key }) => key === "42:1");
  assert.equal(self.completedModules, 1);
  assert.equal(self.totalModules, 2);
  assert.equal(
    res.body.students.find(({ key }) => key === "43:1").completedModules,
    0,
  );
  assert.equal(
    res.body.students.find(({ key }) => key === "42:2").completedModules,
    0,
  );
});

test("missing reporting settings do not invent a threshold or attention flags", async () => {
  for (const threshold of [null, "invalid", -1, 101]) {
    const { res } = await run({
      threshold,
      attempts: [{ courseId: 42, userId: 1, score: 0, total: 10 }],
    });
    assert.equal(res.body.passingPercentage, null);
    assert.equal(
      res.body.students.some(({ needsAttention }) => needsAttention),
      false,
    );
  }
});

test("non-professors cannot load this report and empty or failed queries do not leak records", async () => {
  for (const role of ["student", "admin", "super_admin"]) {
    const { res, queries } = await run({ user: { userId: 7, role } });
    assert.equal(res.code, 403);
    assert.equal(queries.length, 0);
  }
  const empty = await run({ courses: [] });
  assert.deepEqual(empty.res.body.students, []);
  assert.equal(empty.queries.length, 2);
  const failed = await run({ fails: true });
  assert.equal(failed.res.body, undefined);
  assert.match(failed.failure.message, /Database unavailable/);
});
