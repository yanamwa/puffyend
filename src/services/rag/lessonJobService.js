import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../../db.js";
import {
  processLessonWithRag,
  generateFromDocuments,
<<<<<<< HEAD
=======
  generateFromDocument,
>>>>>>> backend/main
  reindexDocument,
} from "./lessonRagService.js";
import {
  sourceDirectory,
  removePrivateFile,
  drainFileDeletions,
  sweepOrphanSources,
} from "./sourceLifecycleService.js";
import { withDatabaseLock } from "./vectorRepository.js";
import { assertWorkerAccess, requestError } from "./courseAccessService.js";

const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);

export async function loadJob(jobId) {
  const [rows] = await db.execute(
    "SELECT * FROM lesson_rag_jobs WHERE job_id = ?",
    [jobId],
  );
  return (
    rows[0] && {
      ...rows[0],
      payload: json(rows[0].payload),
      result: json(rows[0].result),
    }
  );
}

export async function enqueueJob({
  type,
  courseId,
  lessonId = null,
  requesterId,
  file,
  files = file ? [file] : [],
  documentId = null,
<<<<<<< HEAD
  generationContext = null,
=======
>>>>>>> backend/main
}) {
  const hashes = await Promise.all(
    files.map(async (input) =>
      crypto
        .createHash("sha256")
        .update(await fs.readFile(input.path))
        .digest("hex"),
    ),
  );
  const hash = files.length ? hashes.join(":") : String(documentId);
  const fingerprint = crypto
    .createHash("sha256")
<<<<<<< HEAD
    .update(`${type}:${courseId}:${lessonId}:${hash}:${JSON.stringify(generationContext)}`)
=======
    .update(`${type}:${courseId}:${lessonId}:${hash}`)
>>>>>>> backend/main
    .digest("hex")
    .slice(0, 48);
  return withDatabaseLock(`rag-job:${fingerprint}`, async () => {
    const [existing] = await db.execute(
<<<<<<< HEAD
      `SELECT job_id FROM lesson_rag_jobs WHERE course_id = ? AND lesson_id IS NOT DISTINCT FROM ?
      AND status IN ('queued', 'running') AND (payload::jsonb ->> 'fingerprint') = ? LIMIT 1`,
=======
      `SELECT job_id FROM lesson_rag_jobs WHERE course_id = ? AND lesson_id <=> ?
      AND status IN ('queued', 'running') AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.fingerprint')) = ? LIMIT 1`,
>>>>>>> backend/main
      [courseId, lessonId, fingerprint],
    );
    if (existing[0]) return { jobId: existing[0].job_id, reused: true };
    const [counts] = await db.execute(
      "SELECT COUNT(*) AS count FROM lesson_rag_jobs WHERE status IN ('queued', 'running')",
    );
    if (counts[0].count >= 20)
      throw requestError("The lesson queue is full. Try again later.", 429);
    const jobId = crypto.randomUUID();
    const inputs = [];
    if (files.length) {
      await fs.mkdir(sourceDirectory, { recursive: true });
    }
    const connection = await db.getConnection();
    try {
      for (let i = 0; i < files.length; i++) {
        const input = files[i];
        const inputPath = path.join(
          sourceDirectory,
          `pending-${jobId}-${i}${path.extname(input.originalname).toLowerCase()}`,
        );
        inputs.push({
          path: inputPath,
          originalname: input.originalname,
          size: input.size,
          mimetype: input.mimetype,
        });
        await fs.copyFile(input.path, inputPath);
      }
      const payload = {
        fingerprint,
<<<<<<< HEAD
        generationContext,
=======
>>>>>>> backend/main
        sourceHashes: hashes,
        courseId,
        lessonId,
        uploaderId: requesterId,
        documentId,
        ...(inputs.length ? { files: inputs } : {}),
      };
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO lesson_rag_jobs (job_id, course_id, lesson_id, requester_id, document_id, job_type, input_path, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          courseId,
          lessonId,
          requesterId,
          documentId,
          type,
          inputs[0]?.path || null,
          JSON.stringify(payload),
        ],
      );
      for (let i = 0; i < inputs.length; i++)
        await connection.execute(
          "INSERT INTO lesson_rag_job_inputs (job_id, file_order, storage_path) VALUES (?, ?, ?)",
          [jobId, i, inputs[i].path],
        );
      if (documentId)
        await connection.execute(
          "INSERT INTO lesson_rag_job_documents (job_id, document_id) VALUES (?, ?)",
          [jobId, documentId],
        );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      await Promise.all(
        inputs.map((input) => removePrivateFile(input.path).catch(() => {})),
      );
      throw error;
    } finally {
      connection.release();
    }
    return { jobId, reused: false };
  });
}

export async function claimJob() {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(`UPDATE lesson_rag_jobs SET status = 'failed', phase = 'failed', error_message = 'Worker interrupted too many times.'
      WHERE status = 'running' AND lease_expires_at < NOW() AND attempts >= 3`);
    const [rows] =
      await connection.execute(`SELECT * FROM lesson_rag_jobs WHERE attempts < 3 AND
      ((status = 'queued' AND next_run_at <= NOW()) OR (status = 'running' AND lease_expires_at < NOW()))
      ORDER BY created_at LIMIT 1 FOR UPDATE`);
    const job = rows[0];
    if (!job) {
      await connection.commit();
      return null;
    }
    const token = crypto.randomUUID();
    await connection.execute(
      `UPDATE lesson_rag_jobs SET status = 'running', phase = 'starting', attempts = attempts + 1,
<<<<<<< HEAD
      worker_token = ?, lease_expires_at = (NOW() + INTERVAL '10 minute'), error_message = NULL WHERE job_id = ?`,
=======
      worker_token = ?, lease_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE), error_message = NULL WHERE job_id = ?`,
>>>>>>> backend/main
      [token, job.job_id],
    );
    await connection.commit();
    return {
      ...job,
      attempts: job.attempts + 1,
      worker_token: token,
      payload: json(job.payload),
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function queueTerminalInputCleanup() {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] =
      await connection.execute(`SELECT job_id, input_path FROM lesson_rag_jobs WHERE status IN ('completed', 'failed') AND
      (input_path IS NOT NULL OR EXISTS (SELECT 1 FROM lesson_rag_job_inputs i WHERE i.job_id = lesson_rag_jobs.job_id)) LIMIT 50 FOR UPDATE`);
    for (const row of rows) {
      const [inputs] = await connection.execute(
        "SELECT storage_path FROM lesson_rag_job_inputs WHERE job_id = ?",
        [row.job_id],
      );
      for (const inputPath of new Set(
        [row.input_path, ...inputs.map((i) => i.storage_path)].filter(Boolean),
      )) {
        await connection.execute(
          "INSERT INTO lesson_rag_file_deletions (storage_path) VALUES (?)",
          [inputPath],
        );
      }
      await connection.execute(
        "DELETE FROM lesson_rag_job_inputs WHERE job_id = ?",
        [row.job_id],
      );
      await connection.execute(
        "UPDATE lesson_rag_jobs SET input_path = NULL WHERE job_id = ?",
        [row.job_id],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function runClaimedJob(job) {
  const owner = [job.job_id, job.worker_token];
  const progress = async ({
    phase,
    progress: percent,
    documentId,
    outlineCheckpoint,
    documentIds = documentId ? [documentId] : [],
  }) => {
    const [result] = await db.execute(
      `UPDATE lesson_rag_jobs SET phase = ?, progress = ?,
<<<<<<< HEAD
      document_id = COALESCE(?, document_id), lease_expires_at = (NOW() + INTERVAL '10 minute')
=======
      document_id = COALESCE(?, document_id), lease_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE)
>>>>>>> backend/main
      WHERE job_id = ? AND worker_token = ? AND status = 'running'`,
      [phase, percent, documentId ?? null, ...owner],
    );
    if (!result.affectedRows)
      throw requestError("Job was deleted or reassigned.", 409);
    if (outlineCheckpoint)
      await db.execute(
<<<<<<< HEAD
        "UPDATE lesson_rag_jobs SET payload = jsonb_set(payload::jsonb, '{outlineCheckpoint}', ?::jsonb) WHERE job_id = ? AND worker_token = ?",
=======
        "UPDATE lesson_rag_jobs SET payload = JSON_SET(payload, '$.outlineCheckpoint', JSON_EXTRACT(?, '$')) WHERE job_id = ? AND worker_token = ?",
>>>>>>> backend/main
        [JSON.stringify(outlineCheckpoint), ...owner],
      );
    for (const id of new Set(documentIds)) {
      await db.execute(
<<<<<<< HEAD
        "INSERT INTO lesson_rag_job_documents (job_id, document_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
=======
        "INSERT IGNORE INTO lesson_rag_job_documents (job_id, document_id) VALUES (?, ?)",
>>>>>>> backend/main
        [job.job_id, id],
      );
    }
  };
  const heartbeat = setInterval(() => {
    db.execute(
<<<<<<< HEAD
      "UPDATE lesson_rag_jobs SET lease_expires_at = (NOW() + INTERVAL '10 minute') WHERE job_id = ? AND worker_token = ? AND status = 'running'",
=======
      "UPDATE lesson_rag_jobs SET lease_expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE job_id = ? AND worker_token = ? AND status = 'running'",
>>>>>>> backend/main
      owner,
    ).catch((error) => console.error("RAG heartbeat:", error.message));
  }, 30000);
  heartbeat.unref();
  try {
    await assertWorkerAccess(job.requester_id, job.course_id, job.lesson_id);
    let result;
    if (job.payload.retryDocumentIds)
      result = await generateFromDocuments(
        job.payload.retryDocumentIds,
        progress,
        job.payload.outlineCheckpoint || [],
<<<<<<< HEAD
        job.payload.generationContext,
=======
>>>>>>> backend/main
      );
    else if (job.job_type === "upload")
      result = await processLessonWithRag({
        ...job.payload,
        onProgress: progress,
      });
    else {
      // Deletion never silently regenerates a document belonging to another job.
      if (!job.document_id) throw requestError("Source no longer exists.", 404);
      if (job.job_type === "reindex")
        await reindexDocument(job.document_id, progress);
<<<<<<< HEAD
      result = await generateFromDocuments([job.document_id], progress, [], job.payload.generationContext);
=======
      result = await generateFromDocument(job.document_id, progress);
>>>>>>> backend/main
    }
    await db.execute(
      `UPDATE lesson_rag_jobs SET status = 'completed', phase = 'completed', progress = 100, result = ?,
      document_id = ?, lease_expires_at = NULL WHERE job_id = ? AND worker_token = ? AND status = 'running'`,
      [JSON.stringify(result), result.document_id, ...owner],
    );
  } catch (error) {
    const retry = error.retryable === true && job.attempts < 3;
    await db.execute(
      `UPDATE lesson_rag_jobs SET status = ?, phase = ?, error_message = ?, lease_expires_at = NULL,
<<<<<<< HEAD
      next_run_at = (NOW() + INTERVAL '30 second') WHERE job_id = ? AND worker_token = ? AND status = 'running'`,
=======
      next_run_at = DATE_ADD(NOW(), INTERVAL 30 SECOND) WHERE job_id = ? AND worker_token = ? AND status = 'running'`,
>>>>>>> backend/main
      [
        retry ? "queued" : "failed",
        retry ? "retrying" : "failed",
        error.message.slice(0, 2000),
        ...owner,
      ],
    );
  } finally {
    clearInterval(heartbeat);
    await queueTerminalInputCleanup();
  }
}

export function startLessonWorker() {
  let busy = false,
    lastSweep = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await queueTerminalInputCleanup();
      await drainFileDeletions();
      if (Date.now() - lastSweep > 3600000) {
        await sweepOrphanSources();
        lastSweep = Date.now();
      }
      const job = await claimJob();
      if (job) await runClaimedJob(job);
    } catch (error) {
      console.error("RAG worker:", error.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
