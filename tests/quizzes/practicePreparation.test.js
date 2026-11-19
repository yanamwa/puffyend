import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import lessonRoutes from "../../src/routes/lessonRoutes.js";
import courseRoutes from "../../src/routes/courseRoutes.js";
import { getEnrolledPracticeModule } from "../../src/controllers/courseController.js";
import {
  startModulePractice,
  submitModulePractice,
} from "../../src/services/quizzes/modulePracticeService.js";
import {
  queueModulePractice,
  getModulePracticeJob,
  runModulePracticeJob,
} from "../../src/services/quizzes/modulePracticeJobs.js";

after(() => db.end());

test("background practice survives retries, rejects partial sets, and uses Node quiz routes with legacy course IDs", async (context) => {
  const engine = await PGlite.create();
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
  const [insertUser] = await db.execute(
    "INSERT INTO users(name,email,password,role,onboarding_completed,is_verified) VALUES('Practice student','jobs@example.test','hash','student',1,1)",
  );
  const user = { userId: insertUser.insertId, role: "student" };
  const module = {
    id: "database",
    title: "Databases",
    studentPublished: true,
    lessonPages: [
      { title: "Storage", content: "A database stores organized data." },
    ],
    quizItems: [],
  };
  const [insertCourse] = await db.execute(
    "INSERT INTO courses(title,code,summary,subject,content_modules,lesson_pages) VALUES('Information Management','JOBS','','Computing',?,?)",
    [
      JSON.stringify([
        module,
        {
          ...module,
          id: "hidden",
          studentPublished: false,
          lessonPages: [{ content: "Private content" }],
        },
      ]),
      JSON.stringify(module.lessonPages),
    ],
  );
  const scope = {
    courseId: insertCourse.insertId,
    moduleId: module.id,
    mode: "multiple",
  };
  await db.execute(
    "INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')",
    [scope.courseId, user.userId],
  );
  // Invoke the registered Express handlers in-process; no listening port or AI API is needed.
  const invoke = async (path, method, body, anonymous = false) => {
    const url = new URL(path, "http://test");
    const lesson = url.pathname.startsWith("/lessons/");
    const router = lesson ? lessonRoutes : courseRoutes;
    const actual = lesson
      ? url.pathname.slice("/lessons".length)
      : url.pathname;
    const jobId = /^\/practice\/jobs\/(.+)$/.exec(actual)?.[1];
    const pattern = jobId ? "/practice/jobs/:jobId" : actual;
    const route = router.stack.find(
      (layer) =>
        layer.route?.methods[method] &&
        [layer.route.path].flat().includes(pattern),
    )?.route;
    assert.ok(route, `${method} ${pattern} must be registered`);
    let payload;
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(value) {
        payload = value;
        return this;
      },
    };
    const req = {
      user,
      body,
      params: { jobId },
      query: Object.fromEntries(url.searchParams),
      headers: {},
    };
    await (anonymous ? route.stack[0] : route.stack.at(-1)).handle(
      req,
      res,
      (error) => {
        if (error) throw error;
      },
    );
    return { status: res.statusCode, json: async () => payload };
  };
  const post = (path, body) => invoke(path, "post", body);
  const get = (path) => invoke(path, "get");
  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    question: `Database fact ${index + 1}?`,
    type: "true_false",
    options: ["True", "False"],
    correct_answer: "True",
    topic: "Storage",
    explanation: "The lesson supports it.",
  }));

  const response = await post("/lessons/practice/start", scope);
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.status, "queued");
  assert.equal((await queueModulePractice(user, scope)).id, job.id);
  assert.equal(
    (await queueModulePractice(user, { ...scope, mode: "timed" })).id,
    job.id,
  );
  await assert.rejects(
    getModulePracticeJob({ ...user, userId: user.userId + 1 }, job.id),
    { statusCode: 404 },
  );

  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const running = runModulePracticeJob({
    start: async (student, body) => {
      entered();
      await waiting;
      return startModulePractice(student, body, async () => questions);
    },
  });
  await started;
  assert.equal(
    (await (await get(`/lessons/practice/jobs/${job.id}`)).json()).job.status,
    "running",
  );
  assert.equal(
    await runModulePracticeJob({
      start: () => assert.fail("Must not claim an active lease twice"),
    }),
    false,
  );
  release();
  await running;
  const ready = await getModulePracticeJob(user, job.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.attempt.questions.length, 10);
  const result = await submitModulePractice(user, {
    attemptId: ready.attempt.id,
    mode: "multiple",
    answers: questions.map(({ id }) => ({ questionId: id, answer: "True" })),
  });
  assert.equal(result.total, 10);
  assert.equal(result.attempts, 1);

  const broken = await queueModulePractice(user, { ...scope, mode: "qna" });
  await runModulePracticeJob({
    start: async () => ({ id: 99, total: 5, questions: questions.slice(0, 5) }),
  });
  const failed = await getModulePracticeJob(user, broken.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /10/);
  assert.equal(failed.attempt, undefined);
  const retry = await queueModulePractice(user, { ...scope, mode: "qna" });
  assert.notEqual(retry.id, broken.id);
  await db.execute(
    "UPDATE module_practice_jobs SET status='running', lease_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_id=?",
    [retry.id],
  );
  await runModulePracticeJob({
    start: async () => ({ id: 101, total: 10, questions }),
  });
  assert.equal((await getModulePracticeJob(user, retry.id)).status, "ready");

  const combined = await getEnrolledPracticeModule(
    user,
    scope.courseId,
    "all-modules",
  );
  assert.equal(combined.lessonPages.length, 1);
  assert.deepEqual(combined.practiceModuleIds, [module.id]);
  let coursePerformance;
  const all = await startModulePractice(
    user,
    { ...scope, moduleId: "all-modules" },
    async (content, performance) => {
      coursePerformance = performance;
      assert.equal(content.id, "all-modules");
      return questions;
    },
  );
  assert.equal(all.questions.length, 10);
  assert.equal(coursePerformance.length, 10);
  assert.ok(coursePerformance.every((answer) => answer.isCorrect));

  const compositeId = `${scope.courseId}-all-modules`;
  const save = await post("/quiz-attempts", {
    lessonId: compositeId,
    source: "course",
    quizMode: "multiple",
    score: 4,
    total: 5,
    answers: result.answers.slice(0, 5),
  });
  assert.equal(save.status, 201);
  const feedback = await post("/quiz-feedback", {
    lessonId: compositeId,
    source: "course",
    quizMode: "multiple",
    answers: result.answers.slice(0, 5),
  });
  assert.equal(feedback.status, 200);
  assert.equal((await feedback.json()).success, true);
  const count = await get(
    `/quiz-attempts?source=course&lessonId=${compositeId}&quizMode=multiple`,
  );
  assert.equal(count.status, 200);
  assert.equal((await count.json()).attempts, 1);
  const moduleCount = await get(
    `/quiz-attempts?source=module&quizMode=adaptive_practice&courseId=${scope.courseId}&moduleId=database`,
  );
  assert.equal((await moduleCount.json()).attempts, 1);
  assert.equal(
    (await invoke("/quiz-attempts", "get", undefined, true)).status,
    401,
  );
});
