import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import jwt from "jsonwebtoken";
import { PGlite } from "@electric-sql/pglite";
import { JWT_SECRET } from "../../src/config/security.js";
import { db } from "../../src/db.js";
import { createDatabase } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import { migrateModulePracticeJobs } from "../../src/migrations/modulePracticeJobs.js";
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

test("the queue migration upgrades existing rows and enforces only one active job per format", async (context) => {
  const { user, scope } = await enrolledPracticeCourse(context);
  const original = await queueModulePractice(user, scope);
  await db.execute("ALTER TABLE module_practice_jobs DROP COLUMN started_at");
  await db.execute("DROP INDEX module_practice_active_job");
  await migrateModulePracticeJobs(db);
  await migrateModulePracticeJobs(db);
  const [[index]] = await db.execute(`SELECT indisunique, indisvalid, pg_get_indexdef(indexrelid) AS definition
    FROM pg_index WHERE indexrelid='module_practice_active_job'::regclass`);
  assert.equal(index.indisunique, true);
  assert.equal(index.indisvalid, true);
  assert.match(index.definition, /user_id, course_id, module_id, question_format.*WHERE.*queued.*running/i);
  const jobs = await Promise.all(Array.from({ length: 5 }, () => queueModulePractice(user, scope)));
  assert.ok(jobs.every((job) => job.id === original.id && job.status === "queued"));
  const [[row]] = await db.execute("SELECT job_id, started_at FROM module_practice_jobs");
  assert.equal(row.job_id, original.id);
  assert.equal(row.started_at, null);
  await db.execute("UPDATE module_practice_jobs SET created_at=CURRENT_TIMESTAMP - INTERVAL '16 minutes'");
  const expired = await getModulePracticeJob(user, original.id);
  assert.equal(expired.status, "failed");
  assert.match(expired.error.message, /queue/);
  const retry = await queueModulePractice(user, scope);
  assert.notEqual(retry.id, original.id);
  await db.execute(`UPDATE module_practice_jobs SET status='running', runs=3,
    started_at=CURRENT_TIMESTAMP, lease_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE job_id=?`, [retry.id]);
  assert.equal(await runModulePracticeJob({ start: () => assert.fail("No fourth claim") }), false);
  assert.match((await getModulePracticeJob(user, retry.id)).error.message, /interrupted/);
  const stalled = await queueModulePractice(user, scope);
  await db.execute(`UPDATE module_practice_jobs SET status='running', started_at=CURRENT_TIMESTAMP - INTERVAL '241 seconds',
    lease_expires_at=CURRENT_TIMESTAMP + INTERVAL '60 seconds' WHERE job_id=?`, [stalled.id]);
  const final = await getModulePracticeJob(user, stalled.id);
  assert.equal(final.status, "failed");
  assert.match(final.error.message, /timed out/);
  const hung = await queueModulePractice(user, scope);
  await db.execute(`UPDATE module_practice_jobs SET status='running', runs=1,
    started_at=CURRENT_TIMESTAMP - INTERVAL '238 seconds', lease_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second'
    WHERE job_id=?`, [hung.id]);
  const aborted = Promise.withResolvers();
  await runModulePracticeJob({ start: (_user, _body, _generate, { signal, deadlineAt, jobId }) => {
    assert.equal(jobId, hung.id);
    assert.ok(deadlineAt - Date.now() <= 2000);
    signal.addEventListener("abort", () => aborted.resolve(signal.reason.code), { once: true });
    return new Promise(() => {});
  } });
  assert.equal(await aborted.promise, "GENERATION_TIMEOUT");
  const [[terminal]] = await db.execute("SELECT status FROM module_practice_jobs WHERE job_id=?", [hung.id]);
  assert.equal(terminal.status, "failed");
});

test("a replacement process reclaims the original job only after its lease expires", { timeout: 90_000 }, async (context) => {
  const { user, scope } = await enrolledPracticeCourse(context);
  function launch() {
    const child = fork(new URL("../helpers/practiceWorkerProcess.js", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true,
    });
    const events = new EventEmitter();
    child.on("error", (error) => events.emit("error", error));
    child.on("message", async (message) => {
      if (message.event) return events.emit(message.event, message);
      let reply;
      try {
        const [result] = await db.execute(message.sql, message.values);
        reply = { id: message.id, result };
      } catch (error) {
        reply = { id: message.id, error: error.code || "Query failed" };
      }
      if (child.connected) child.send(reply);
    });
    context.after(() => { if (child.connected) child.kill(); });
    return { child, events };
  }
  const original = await queueModulePractice(user, scope);
  const first = launch();
  await once(first.events, "claimed");
  const [[initial]] = await db.execute("SELECT started_at FROM module_practice_jobs WHERE job_id=?", [original.id]);
  const exited = once(first.child, "exit");
  first.child.kill();
  await exited;
  assert.equal((await queueModulePractice(user, scope)).id, original.id);
  const locked = launch();
  assert.equal((await once(locked.events, "finished"))[0].claimed, false);
  await db.execute("UPDATE module_practice_jobs SET lease_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE job_id=?", [original.id]);
  assert.equal((await getModulePracticeJob(user, original.id)).status, "queued");
  const replacement = launch();
  await once(replacement.events, "claimed");
  const again = await queueModulePractice(user, scope);
  assert.equal(again.id, original.id);
  assert.equal(again.status, "running");
  const other = await queueModulePractice(user, { ...scope, mode: "qna" });
  const independent = launch();
  assert.equal((await once(independent.events, "claimed"))[0].mode, "qna");
  const [[reclaimed]] = await db.execute("SELECT started_at,runs FROM module_practice_jobs WHERE job_id=?", [original.id]);
  assert.deepEqual(reclaimed.started_at, initial.started_at);
  assert.equal(reclaimed.runs, 2);
  const finished = [replacement, independent].map(({ child, events }) => {
    const result = once(events, "finished");
    child.send("finish");
    return result;
  });
  await Promise.all(finished);
  for (const [job, worker] of [[original, replacement], [other, independent]]) {
    const ready = await getModulePracticeJob(user, job.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.attempt.id, worker.child.pid);
  }
});

function practiceHttp(worker) {
  const app = express();
  app.use(express.json());
  app.locals.practiceWorker = worker;
  app.use("/api/lessons", lessonRoutes);
  return async (student, action, body) => {
    const request = new IncomingMessage(new Socket());
    request.method = body === undefined ? "GET" : "POST";
    request.url = `/api/lessons/practice/${action}`;
    request.headers.authorization = `Bearer ${jwt.sign(student, JWT_SECRET, { expiresIn: "5m" })}`;
    if (body !== undefined) {
      const payload = Buffer.from(JSON.stringify(body));
      request.headers["content-type"] = "application/json";
      request.headers["content-length"] = String(payload.length);
      request.push(payload);
    }
    request.push(null);
    const response = new ServerResponse(request);
    // Dispatch through the mounted router, including JSON parsing, auth and
    // response serialization, without opening a network port in the test.
    const serialized = await new Promise((resolve, reject) => {
      response.end = resolve;
      app.handle(request, response, (error) => reject(error || new Error("Missing practice route")));
    });
    assert.equal(response.statusCode, action === "start" ? 202 : 200);
    const data = JSON.parse(serialized);
    assert.equal(data.success, true);
    if (action !== "submit") {
      assert.ok(data.job.id);
      assert.ok(["queued", "running", "ready", "failed"].includes(data.job.status));
    }
    return data;
  };
}

test("five students complete five queued quizzes each with isolated retries and histories", async (context) => {
  const { user, scope } = await enrolledPracticeCourse(context);
  const students = [user];
  const histories = new Map();
  for (let n = 2; n <= 5; n++) {
    const [row] = await db.execute(
      "INSERT INTO users(name,email,password,role,onboarding_completed,is_verified) VALUES(?,?,'hash','student',1,1)",
      [`Practice student ${n}`, `queue-${n}@example.test`],
    );
    students.push({ userId: row.insertId, role: "student" });
    await db.execute("INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')", [scope.courseId, row.insertId]);
  }
  for (const student of students) histories.set(student.userId, new Set());

  let active = 0, peak = 0, interruptOnce = true;
  let notifyPair, releasePair;
  const pairStarted = new Promise((resolve) => { notifyPair = resolve; });
  const firstJobs = new Promise((resolve) => { releasePair = resolve; });
  const start = async (student, body) => {
    active++;
    peak = Math.max(peak, active);
    if (active === 2) notifyPair();
    try {
      await firstJobs;
      if (student.userId === students[2].userId && interruptOnce) {
        interruptOnce = false;
        throw Object.assign(new Error("Practice could not be prepared. Please try again."), { statusCode: 503 });
      }
      return await startModulePractice(student, body, async (module, performance, previous, options) => {
        const own = histories.get(student.userId);
        assert.deepEqual(new Set(previous), own);
        const attempt = own.size / 10 + 1;
        const provider = async ({ data, schema }) => {
          if (schema.properties.verdicts) {
            return { verdicts: data.questions.map(({ question_index, question_number }) => ({ question_index, question_number, supported: true, reason: "" })) };
          }
          if (attempt > 1) assert.equal(data.practice_focus.target_count, 1);
          return { questions: data.assigned_slots.map((slot, index) => ({
            question_number: slot.question_number,
            learning_objective: slot.learning_objective || data.learning_objectives[0] || "Identify how a database stores records.",
            question: `Storage check ${student.userId}-${attempt}-${index}?`,
            type: slot.type,
            options: slot.type === "multiple_choice" ? ["Database", "Mouse", "Display", "Keyboard"] :
              slot.type === "true_false" ? ["True", "False"] : [],
            correct_answer: slot.type === "true_false" ? "True" : "Database",
            explanation: "A database stores organized data.", topic: slot.topic || "Storage",
            concept: slot.concept || "Organized data", thinking_skill: slot.thinking_skill,
            cognitive_level: slot.allowed_cognitive_levels[0], evidence_ids: [data.evidence[0].evidence_id],
          })) };
        };
        return generatePracticeQuestions(module, performance, previous, {
          ...options, generateBatch: (batch) => generateQuizBatch(batch, provider),
        });
      });
    } finally {
      active--;
    }
  };
  const worker = startModulePracticeWorker({ poll: false, runJob: () => runModulePracticeJob({ start }) });
  context.after(() => worker.stop());
  const api = practiceHttp(worker);
  const enqueue = async (student, body) => (await api(student, "start", body)).job;
  async function waitForJob(student, id) {
    for (let poll = 0; poll < 200; poll++) {
      const { job } = await api(student, `jobs/${id}`);
      assert.equal(job.id, id);
      if (job.status === "ready" || job.status === "failed") return job;
      await delay(20);
    }
    assert.fail("The test worker did not finish this quiz");
  }
  const completedIds = new Set();
  for (let round = 1; round <= 5; round++) {
    const jobs = await Promise.all(students.map((student) => enqueue(student, scope)));
    assert.equal(new Set(jobs.map((job) => job.id)).size, 5);
    if (round === 1) {
      await pairStarted;
      try {
        const [statuses] = await db.execute("SELECT status FROM module_practice_jobs");
        assert.equal(statuses.filter((row) => row.status === "queued").length, 3);
        assert.equal(statuses.filter((row) => row.status === "running").length, 2);
        assert.equal((await enqueue(user, { ...scope, mode: "timed" })).id, jobs[0].id);
      } finally {
        releasePair();
      }
    }
    for (const [index, student] of students.entries()) {
      let job = await waitForJob(student, jobs[index].id);
      if (round === 1 && index === 2) {
        assert.equal(job.status, "failed");
        assert.equal(job.error.status, 503);
        const retry = await enqueue(student, scope);
        assert.notEqual(retry.id, job.id);
        job = await waitForJob(student, retry.id);
      }
      assert.equal(job.status, "ready", job.error?.message);
      const { id, questions } = job.attempt;
      assert.equal(questions.length, 10);
      completedIds.add(id);
      const { result } = await api(student, "submit", {
        attemptId: id, mode: scope.mode,
        answers: questions.map((q, i) => ({
          questionId: q.id,
          answer: i ? q.correct_answer : (q.options.find((option) => option !== q.correct_answer) || "Incorrect"),
        })),
      });
      assert.equal(result.total, 10);
      assert.equal(result.attempts, round);
      const own = histories.get(student.userId);
      questions.forEach((q) => own.add(q.question));
      assert.equal(own.size, round * 10);
    }
  }
  assert.equal(completedIds.size, 25);
  assert.equal(peak, 2);
  const [counts] = await db.execute("SELECT user_id, COUNT(*) AS total FROM module_practice_attempts WHERE result_json IS NOT NULL GROUP BY user_id");
  assert.deepEqual(counts.map((row) => Number(row.total)), [5, 5, 5, 5, 5]);
});

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
              verdicts: data.questions.map(({ question_number }, index) => ({
                question_index: index,
                question_number,
                supported: retry
                  ? drafts.length > 1 || index !== 1
                  : drafts.length === 1 && index < 8,
                reason: "Answer needs better lesson evidence.",
              })),
            };
          }
          const draft = drafts.push(data.assigned_slots.length);
          const sampleName = `${mode}${moduleId === scope.moduleId ? "Module" : "Course"}Set${draft}`;
          const questions = data.assigned_slots.map((slot, index) => ({
            question_number: slot.question_number,
            learning_objective: slot.learning_objective || data.learning_objectives[0] || "Identify how a database stores records.",
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
        assert.equal(failed.error.code, "PRACTICE_VALIDATION_FAILED");
        assert.match(failed.error.message, /lesson evidence check/);
        assert.deepEqual(drafts, [10, 2, 2, 2]);
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
