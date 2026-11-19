import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import lessonRoutes from "../../src/routes/lessonRoutes.js";
import courseRoutes from "../../src/routes/courseRoutes.js";
import { getEnrolledPracticeModule } from "../../src/controllers/courseController.js";
import { generateQuizBatch } from "../../src/services/rag/quizRagService.js";
import {
  generatePracticeQuestions,
  startModulePractice,
  submitModulePractice,
} from "../../src/services/quizzes/modulePracticeService.js";
import {
  queueModulePractice,
  getModulePracticeJob,
  runModulePracticeJob,
  startModulePracticeWorker,
} from "../../src/services/quizzes/modulePracticeJobs.js";

after(() => db.end());

test("a request wakes an idle worker and two students can prepare practice concurrently", async () => {
  let claims = 0;
  const releases = [];
  const worker = startModulePracticeWorker({
    poll: false,
    runJob: async () => {
      if (claims >= 3) return false;
      claims++;
      return new Promise((resolve) => releases.push(() => resolve(true)));
    },
  });
  assert.equal(claims, 0);
  const first = worker.wake();
  const second = worker.wake();
  await worker.wake();
  assert.equal(claims, 2);
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 3);
  releases[1]();
  releases[2]();
  await Promise.all([first, second]);
  worker.stop();
});

async function enrolledPracticeCourse(context) {
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
  return { user, scope, module };
}

test("background practice survives retries, rejects partial sets, and uses Node quiz routes with legacy course IDs", async (context) => {
  const { user, scope, module } = await enrolledPracticeCourse(context);
  // Invoke the registered Express handlers in-process; no listening port or AI API is needed.
  let wakeCalls = 0;
  const practiceWorker = {
    wake: () => {
      wakeCalls++;
    },
  };
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
      app: { locals: { practiceWorker } },
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
  assert.equal(wakeCalls, 1);
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
  const beforeWake = wakeCalls;
  assert.equal(
    (await (await get(`/lessons/practice/jobs/${retry.id}`)).json()).job.status,
    "queued",
  );
  assert.equal(wakeCalls, beforeWake + 1);
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

  const rejected = (await (await post("/lessons/practice/start", scope)).json())
    .job;
  await runModulePracticeJob({
    start: (student, body) =>
      startModulePractice(student, body, async () => {
        throw Object.assign(new Error("Private text from the answer review"), {
          statusCode: 422,
          code: "QUIZ_REVIEW_REJECTED",
        });
      }),
  });
  const rejectedStatus = await get(`/lessons/practice/jobs/${rejected.id}`);
  assert.equal(rejectedStatus.status, 200);
  const rejectedJob = (await rejectedStatus.json()).job;
  assert.equal(rejectedJob.status, "failed");
  assert.equal(rejectedJob.error.status, 422);
  assert.equal(rejectedJob.error.code, "PRACTICE_VALIDATION_FAILED");
  assert.match(rejectedJob.error.message, /lesson evidence check/);
  assert.doesNotMatch(rejectedJob.error.message, /Private text/);
  const retried = (await (await post("/lessons/practice/start", scope)).json())
    .job;
  assert.notEqual(retried.id, rejected.id);
  await runModulePracticeJob({
    start: (student, body) =>
      startModulePractice(student, body, async () => questions),
  });
  const retriedJob = (
    await (await get(`/lessons/practice/jobs/${retried.id}`)).json()
  ).job;
  assert.equal(retriedJob.status, "ready");
  assert.equal(retriedJob.attempt.questions.length, 10);
});

test("every practice mode can recover and submit a full module or course quiz", async (context) => {
  const { user, scope } = await enrolledPracticeCourse(context);
  for (const moduleId of [scope.moduleId, "all-modules"]) {
    for (const mode of ["flashcard", "qna", "multiple", "matching", "timed", "mixed"]) {
      await context.test(`${moduleId} / ${mode}`, async () => {
        const body = { ...scope, moduleId, mode };
        let retry = false;
        const drafts = [];
        async function provider({ schema, data }) {
          if (schema.properties.verdicts) {
            return {
              verdicts: data.questions.map((_, index) => ({
                question_index: index,
                supported: retry && (drafts.length > 1 || index !== 1),
                reason: "Answer needs better lesson evidence.",
              })),
            };
          }
          const draft = drafts.push(data.assigned_slots.length);
          const sampleName = `${mode}${moduleId === scope.moduleId ? "Module" : "Course"}Set${draft}`;
          const questions = data.assigned_slots.map((slot, index) => ({
            question: slot.type === "true_false"
              ? `Database ${sampleName}Case${index} stores organized data.`
              : `What stores records for ${sampleName}Case${index}?`,
            type: slot.type,
            options: slot.type === "multiple_choice"
              ? ["Database", "Mouse", "Monitor", "Cable"]
              : slot.type === "true_false" ? ["True", "False"] : [],
            correct_answer: slot.type === "true_false" ? "True" : "Database",
            explanation: "A database stores organized data.",
            topic: slot.topic || "Storage",
            concept: slot.concept || "Organized data",
            thinking_skill: slot.thinking_skill,
            cognitive_level: slot.allowed_cognitive_levels[0],
            evidence_ids: [data.evidence[0].evidence_id],
          }));
          if (retry && draft === 1) questions[1].question = questions[0].question;
          return { questions };
        }
        const generate = (module, performance, previousQuestions, options) =>
          generatePracticeQuestions(module, performance, previousQuestions, {
            ...options,
            generateBatch: (batch) => generateQuizBatch(batch, provider),
          });
        const start = (student, request) => startModulePractice(student, request, generate);

        const first = await queueModulePractice(user, body);
        await runModulePracticeJob({ start });
        const failed = await getModulePracticeJob(user, first.id);
        assert.equal(failed.status, "failed");
        assert.equal(failed.error.status, 422);
        assert.match(failed.error.message, /lesson evidence check/);
        const [[{ count }]] = await db.execute(
          "SELECT COUNT(*) AS count FROM module_practice_attempts WHERE user_id=? AND course_id=? AND module_id=? AND result_json IS NULL",
          [user.userId, scope.courseId, moduleId],
        );
        assert.equal(Number(count), 0);

        retry = true;
        drafts.length = 0;
        const next = await queueModulePractice(user, body);
        assert.notEqual(next.id, first.id);
        await runModulePracticeJob({ start });
        const ready = await getModulePracticeJob(user, next.id);
        assert.equal(ready.status, "ready", ready.error?.message);
        assert.deepEqual(drafts, [10, 2]);
        const { id, questions } = ready.attempt;
        assert.equal(new Set(questions.map((item) => item.question)).size, 10);
        assert.equal(questions.filter((item) => item.question.includes("Set1Case")).length, 8);
        assert.equal(questions.filter((item) => item.type === "identification").length, mode === "qna" ? 10 : 2);

        const answers = questions.map((item, index) => ({
          questionId: item.id,
          answer: mode === "flashcard" ? (index ? "good" : "hard")
            : mode === "timed" && index === 0 ? "" : item.correct_answer,
        }));
        const result = await submitModulePractice(user, { attemptId: id, mode, answers });
        assert.equal(result.total, 10);
        assert.equal(result.score, ["flashcard", "timed"].includes(mode) ? 9 : 10);
        assert.equal(result.assessmentBasis, mode === "flashcard" ? "self_assessment" : "graded_answers");
      });
    }
  }
});
