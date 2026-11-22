import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { requestError } from "../rag/courseAccessService.js";
import {
  modulePracticeScope,
  PRACTICE_GENERATION_TIMEOUT_MS,
  startModulePractice,
} from "./modulePracticeService.js";

const leaseExpired = "(lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)";
const generationDeadline = `COALESCE(started_at, updated_at) + INTERVAL '${PRACTICE_GENERATION_TIMEOUT_MS} milliseconds'`;
const expired = `((status = 'queued' AND created_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes')
  OR (status = 'running' AND (CURRENT_TIMESTAMP >= ${generationDeadline}
    OR (runs >= 3 AND ${leaseExpired}))))`;
const effectiveStatus = `CASE WHEN status = 'running' AND ${leaseExpired}
       THEN 'queued' ELSE status END AS status`;
const readJobStatus = `SELECT job_id, payload, result_json, error_json, ${effectiveStatus}, ${expired} AS expired
  FROM module_practice_jobs WHERE job_id = ? AND user_id = ?`;

function expireJobs(database, filter = "", values = []) {
  return database.execute(
    `UPDATE module_practice_jobs SET status = 'failed',
       error_json = json_build_object('status', 503, 'message', CASE
         WHEN status = 'queued' THEN 'Your practice waited too long in the queue. Please try again.'
         WHEN CURRENT_TIMESTAMP >= ${generationDeadline} THEN 'Practice preparation timed out. Please try again.'
         ELSE 'Practice preparation was interrupted. Please try again.' END)::text,
       lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued', 'running') AND ${expired} ${filter}`,
    values,
  );
}

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
  const scope = [user.userId, courseId, String(module.id), format];
  await expireJobs(database, "AND user_id=? AND course_id=? AND module_id=? AND question_format=?", scope);
  // The PostgreSQL adapter returns rows for WITH queries. On conflict,
  // RETURNING yields the stored UUID rather than the proposed UUID.
  const [[row]] = await database.execute(
    `WITH active_job AS (
      INSERT INTO module_practice_jobs
      (job_id, user_id, course_id, module_id, question_format, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, course_id, module_id, question_format)
      WHERE status IN ('queued', 'running')
      DO UPDATE SET job_id = module_practice_jobs.job_id
      RETURNING job_id, status, lease_expires_at, result_json, error_json
    ) SELECT job_id, result_json, error_json, ${effectiveStatus} FROM active_job`,
    [
      randomUUID(),
      ...scope,
      JSON.stringify(payload),
    ],
  );
  return publicJob(row);
}

export async function getModulePracticeJob(user, jobId, database = db) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(String(jobId)))
    throw requestError("Practice preparation not found.", 404);
  const key = [jobId, user.userId];
  let [[row]] = await database.execute(readJobStatus, key);
  if (!row) throw requestError("Practice preparation not found.", 404);
  await modulePracticeScope(user, JSON.parse(row.payload));
  if (row.expired) {
    await expireJobs(database, "AND job_id = ? AND user_id = ?", key);
    [[row]] = await database.execute(readJobStatus, key);
  }
  return publicJob(row);
}

export async function runModulePracticeJob({
  database = db,
  start = startModulePractice,
} = {}) {
  const runToken = randomUUID();
  await expireJobs(database);
  // An expired lease lets another worker resume after a backend restart.
  const [[job]] = await database.execute(
    `WITH pending AS (
      SELECT job_id FROM module_practice_jobs
      WHERE (status = 'queued' OR (status = 'running' AND ${leaseExpired})) AND NOT ${expired}
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE module_practice_jobs SET status = 'running', run_token = ?,
        started_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP ELSE COALESCE(started_at, updated_at) END,
        lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '90 seconds',
        runs = runs + 1, updated_at = CURRENT_TIMESTAMP
      WHERE job_id IN (SELECT job_id FROM pending) RETURNING *
    ) SELECT *, CEIL(EXTRACT(EPOCH FROM (${generationDeadline} - CURRENT_TIMESTAMP)) * 1000)::int AS remaining_ms
      FROM claimed`,
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
        `UPDATE module_practice_jobs SET lease_expires_at = LEAST(CURRENT_TIMESTAMP + INTERVAL '90 seconds', ${generationDeadline})
       WHERE job_id = ? AND run_token = ? AND status = 'running' AND NOT ${leaseExpired}`,
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
  const controller = new AbortController();
  const deadlineAt = Date.now() + job.remaining_ms;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(
          requestError("Practice preparation timed out. Please try again.", 503),
          { code: "GENERATION_TIMEOUT" },
        );
        controller.abort(error);
        reject(error);
      }, job.remaining_ms);
    });
    const attempt = await Promise.race([
      timeout,
      start(
        { userId: job.user_id, role: "student" },
        JSON.parse(job.payload),
        undefined,
        { signal: controller.signal, deadlineAt, jobId: job.job_id },
      ),
    ]);
    if (attempt.total !== 10 || attempt.questions?.length !== 10)
      throw requestError(
        "We couldn't prepare all 10 practice questions. Please try again.",
        502,
      );
    const [saved] = await database.execute(
      `UPDATE module_practice_jobs SET status = 'ready', result_json = ?,
       lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = ? AND run_token = ? AND status = 'running'
         AND NOT ${leaseExpired} AND CURRENT_TIMESTAMP < ${generationDeadline}`,
      [JSON.stringify(attempt), job.job_id, runToken],
    );
    if (saved.affectedRows) console.info("Practice preparation ready:", timing());
    else await expireJobs(database, "AND job_id = ?", [job.job_id]);
  } catch (error) {
    console.error(
      "Practice preparation failed:",
      error.code || error.statusCode || "GENERATION_ERROR",
      { ...timing(), reason: error.cause?.code || error.code || "GENERATION_ERROR" },
    );
    const [failed] = await database.execute(
      `UPDATE module_practice_jobs SET status = 'failed', error_json = ?,
       lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = ? AND run_token = ? AND status = 'running' AND NOT ${leaseExpired}`,
      [
        JSON.stringify({
          message: error.statusCode
            ? error.message
            : "Practice could not be prepared. Please try again.",
          code: ["QUICK_RECAP_REQUIRED", "PRACTICE_VALIDATION_FAILED"].includes(
            error.code,
          )
            ? error.code
            : undefined,
          status: error.statusCode || 500,
        }),
        job.job_id,
        runToken,
      ],
    );
    if (!failed.affectedRows) await expireJobs(database, "AND job_id = ?", [job.job_id]);
  } finally {
    clearTimeout(timer);
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
