import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { requestError } from "../rag/courseAccessService.js";
import {
  modulePracticeScope,
  startModulePractice,
} from "./modulePracticeService.js";

// Use the same clock as the claim query to recognize an interrupted job.
const readJobStatus = `SELECT job_id, payload, result_json, error_json,
  CASE WHEN status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP
       THEN 'queued' ELSE status END AS status
  FROM module_practice_jobs WHERE job_id = ? AND user_id = ?`;

function publicJob(row) {
  return {
    id: row.job_id,
    status: row.status,
    ...(row.status === "ready" ? { attempt: JSON.parse(row.result_json) } : {}),
    ...(row.status === "failed" ? { error: JSON.parse(row.error_json) } : {}),
  };
}

export async function queueModulePractice(user, body, database = db) {
  const { courseId, module, mode, format } = await modulePracticeScope(
    user,
    body,
  );
  const payload = {
    courseId,
    moduleId: String(module.id),
    mode,
    recapAnswers: body.recapAnswers,
  };
  // Do not store arbitrary request fields or oversized recap input in the queue.
  if (JSON.stringify(payload).length > 25000)
    throw requestError("Quick Recap answers are invalid.", 400);
  const [insert] = await database.execute(
    `INSERT INTO module_practice_jobs
      (job_id, user_id, course_id, module_id, question_format, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, course_id, module_id, question_format)
      WHERE status IN ('queued', 'running')
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    [
      randomUUID(),
      user.userId,
      courseId,
      String(module.id),
      format,
      JSON.stringify(payload),
    ],
  );
  const [[row]] = await database.execute(readJobStatus, [
    insert.insertId,
    user.userId,
  ]);
  return publicJob(row);
}

export async function getModulePracticeJob(user, jobId, database = db) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(String(jobId)))
    throw requestError("Practice preparation not found.", 404);
  const [[row]] = await database.execute(readJobStatus, [jobId, user.userId]);
  if (!row) throw requestError("Practice preparation not found.", 404);
  await modulePracticeScope(user, JSON.parse(row.payload));
  return publicJob(row);
}

export async function runModulePracticeJob({
  database = db,
  start = startModulePractice,
} = {}) {
  const runToken = randomUUID();
  // An expired lease lets another worker resume after a backend restart.
  const [[job]] = await database.execute(
    `WITH pending AS (
      SELECT job_id FROM module_practice_jobs
      WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE module_practice_jobs SET status = 'running', run_token = ?,
        lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '90 seconds',
        runs = runs + 1, updated_at = CURRENT_TIMESTAMP
      WHERE job_id IN (SELECT job_id FROM pending) RETURNING *
    ) SELECT * FROM claimed`,
    [runToken],
  );
  if (!job) return false;
  const startedAt = performance.now();
  const timing = () => ({
    jobId: job.job_id,
    ...(job.runs === 1
      ? { queueMs: new Date(job.updated_at) - new Date(job.created_at) }
      : {}),
    runMs: Math.round(performance.now() - startedAt),
  });
  const heartbeat = setInterval(() => {
    database
      .execute(
        `UPDATE module_practice_jobs SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '90 seconds'
       WHERE job_id = ? AND run_token = ? AND status = 'running'`,
        [job.job_id, runToken],
      )
      .catch((error) =>
        console.error(
          "Practice job heartbeat:",
          error.code || "DATABASE_ERROR",
        ),
      );
  }, 15000);
  heartbeat.unref();
  try {
    if (job.runs > 3)
      throw requestError(
        "Practice preparation was interrupted. Please try again.",
        503,
      );
    const attempt = await start(
      { userId: job.user_id, role: "student" },
      JSON.parse(job.payload),
    );
    if (attempt.total !== 10 || attempt.questions?.length !== 10)
      throw requestError(
        "We couldn't prepare all 10 practice questions. Please try again.",
        502,
      );
    await database.execute(
      `UPDATE module_practice_jobs SET status = 'ready', result_json = ?,
       lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = ? AND run_token = ? AND status = 'running'`,
      [JSON.stringify(attempt), job.job_id, runToken],
    );
    console.info("Practice preparation ready:", timing());
  } catch (error) {
    console.error(
      "Practice preparation failed:",
      error.code || error.statusCode || "GENERATION_ERROR",
      timing(),
    );
    await database.execute(
      `UPDATE module_practice_jobs SET status = 'failed', error_json = ?,
       lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = ? AND run_token = ? AND status = 'running'`,
      [
        JSON.stringify({
          message: error.statusCode
            ? error.message
            : "Practice could not be prepared. Please try again.",
          code: error.code === "QUICK_RECAP_REQUIRED" ? error.code : undefined,
          status: error.statusCode || 500,
        }),
        job.job_id,
        runToken,
      ],
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function startModulePracticeWorker({
  poll = true,
  runJob = runModulePracticeJob,
} = {}) {
  let active = 0;
  let stopped = false;
  const wake = async () => {
    if (stopped || active >= 2) return;
    active++;
    try {
      // Each claim holds its own database lease. Drain waiting jobs as soon
      // as a slot opens, including jobs queued while both slots were busy.
      let claimed;
      do {
        claimed = await runJob();
      } while (claimed && !stopped);
    } catch (error) {
      console.error("Practice worker:", error.code || "DATABASE_ERROR");
    } finally {
      active--;
    }
  };
  const timer = poll ? setInterval(wake, 1500) : null;
  timer?.unref();
  if (poll) void wake();
  return {
    wake,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
