import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { enqueueJob, loadJob } from '../services/rag/lessonJobService.js';
import { loadDocument, withDatabaseLock } from '../services/rag/vectorRepository.js';
import { assertCourseAccess, requestError } from '../services/rag/courseAccessService.js';
import { deleteWithSources, drainFileDeletions, assertPrivatePath } from '../services/rag/sourceLifecycleService.js';
import { generateQuizWithRag } from '../services/rag/quizRagService.js';

function reportError(res, error) {
  console.error('Lesson RAG:', error.message);
  return res.status(error.statusCode || 500).json({ success: false, message: error.code === 'ER_NO_SUCH_TABLE'
    ? 'Run all three lesson RAG SQL migrations before using this endpoint.' : error.message });
}

export async function processLessonFile(req, res) {
  const files = [...(req.files?.files || []), ...(req.files?.file || []), ...(req.file ? [req.file] : [])];
  try {
    if (!files.length) throw requestError('No files uploaded.', 400);
    if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) throw requestError('Upload at most 10 files with a combined size of 50 MB.', 400);
    const courseId = Number(req.body.course_id);
    const lessonId = req.body.lesson_id ? Number(req.body.lesson_id) : null;
    await assertCourseAccess(req.user, courseId, lessonId);
    const result = await enqueueJob({ type: 'upload', files, courseId, lessonId, requesterId: req.user.userId });
    return res.status(202).json({ success: true, job_id: result.jobId, reused: result.reused, status_url: `/api/lessons/jobs/${result.jobId}` });
  } catch (error) { return reportError(res, error); }
  finally { await Promise.all(files.map(file => fs.unlink(file.path).catch(() => {}))); }
}

export async function getLessonJob(req, res) {
  try {
    const job = await loadJob(req.params.jobId);
    if (!job) throw requestError('Job not found.', 404);
    await assertCourseAccess(req.user, job.course_id, job.lesson_id);
    return res.json({ success: true, job_id: job.job_id, status: job.status, phase: job.phase, progress: job.progress,
      attempts: job.attempts, document_id: job.document_id, message: job.error_message,
      ...(job.status === 'completed' ? { result: job.result } : {}) });
  } catch (error) { return reportError(res, error); }
}

async function authorizedDocument(req) {
  if (!/^\d+$/.test(req.params.documentId)) throw requestError('Invalid document ID.', 400);
  const document = await loadDocument(req.params.documentId);
  if (!document) throw requestError('Source not found.', 404);
  await assertCourseAccess(req.user, document.course_id, document.lesson_id);
  return document;
}

export async function listLessonSources(req, res) {
  try {
    const courseId = Number(req.query.course_id);
    await assertCourseAccess(req.user, courseId);
    const [rows] = await db.execute(`SELECT document_id, lesson_id, filename, processing_status, processing_error,
      chunk_count, created_at FROM lesson_source_documents WHERE course_id = ? ORDER BY document_id DESC LIMIT 200`, [courseId]);
    const [failedJobs] = await db.execute("SELECT job_id, lesson_id, error_message FROM lesson_rag_jobs WHERE course_id = ? AND status = 'failed' AND document_id IS NOT NULL ORDER BY created_at DESC LIMIT 20", [courseId]);
    return res.json({ success: true, sources: rows, failed_jobs: failedJobs });
  } catch (error) { return reportError(res, error); }
}

export async function queueSourceGeneration(req, res) {
  try {
    const document = await authorizedDocument(req);
    const type = req.path.endsWith('/reindex') ? 'reindex' : 'generate';
    if (type === 'generate' && document.processing_status !== 'ready') throw requestError('Index or reindex this source first.', 409);
    const result = await enqueueJob({ type, documentId: document.document_id, courseId: document.course_id,
      lessonId: document.lesson_id, requesterId: req.user.userId });
    return res.status(202).json({ success: true, job_id: result.jobId, reused: result.reused });
  } catch (error) { return reportError(res, error); }
}

export async function deleteLessonSource(req, res) {
  try {
    const document = await authorizedDocument(req);
    await withDatabaseLock(`rag-document:${document.document_id}`, async () => {
      const [jobs] = await db.execute(`SELECT j.job_id FROM lesson_rag_jobs j LEFT JOIN lesson_rag_job_documents r ON r.job_id = j.job_id
        WHERE (j.document_id = ? OR r.document_id = ?) AND j.status IN ('queued', 'running') LIMIT 1`, [document.document_id, document.document_id]);
      if (jobs.length) throw requestError('Wait for the active source job to finish before deleting it.', 409);
      await deleteWithSources({ entity: 'document', id: document.document_id,
        deleteSql: 'DELETE FROM lesson_source_documents WHERE document_id = ?', parameters: [document.document_id] });
    });
    await drainFileDeletions();
    return res.json({ success: true, message: 'Source deleted; private file cleanup queued.' });
  } catch (error) { return reportError(res, error); }
}

export async function downloadLessonSource(req, res) {
  try {
    const document = await authorizedDocument(req);
    res.download(assertPrivatePath(document.storage_path), path.basename(document.filename), error => {
      if (error && !res.headersSent) reportError(res, requestError('Source file is unavailable.', 404));
    });
  } catch (error) { return reportError(res, error); }
}
export async function generateLessonQuiz(req, res) {
  try {
    const result = await generateQuizWithRag({ user: req.user, body: req.body || {} });
    return res.json({ success: true, quiz: { questions: result.questions },
      generated_count: result.questions.length, question_count: result.questionCount,
      identification_count: result.identificationCount,
      multiple_choice_count: result.questionCount - result.identificationCount,
      difficulty: result.difficulty, document_ids: result.document_ids, rag_version: 'quiz-1' });
  } catch (error) { return reportError(res, error); }
}

export async function retryLessonJob(req, res) {
  try {
    const job = await loadJob(req.params.jobId);
    if (!job) throw requestError('Job not found.', 404);
    await assertCourseAccess(req.user, job.course_id, job.lesson_id);
    const [sources] = await db.execute('SELECT d.document_id, d.processing_status, d.content_hash FROM lesson_rag_job_documents r JOIN lesson_source_documents d ON d.document_id = r.document_id WHERE r.job_id = ? ORDER BY d.document_id', [job.job_id]);
    if (!sources.length || sources.some(s => s.processing_status !== 'ready')) throw requestError('Some sources are not indexed. Upload the materials again or reindex the failed sources.', 409);
    const indexedHashes = new Set(sources.map(s => s.content_hash));
    if (job.job_type === 'upload' && (job.payload.sourceHashes?.length
      ? job.payload.sourceHashes.some(hash => !indexedHashes.has(hash))
      : (job.payload.files?.length || 0) > sources.length)) throw requestError('Some uploaded files were not indexed. Upload the complete batch again; ready sources will reuse their embeddings.', 409);
    const [result] = await db.execute("UPDATE lesson_rag_jobs SET status = 'queued', phase = 'retrying generation', attempts = 0, progress = 25, error_message = NULL, next_run_at = NOW(), requester_id = ?, payload = JSON_SET(payload, '$.retryDocumentIds', JSON_EXTRACT(?, '$')) WHERE job_id = ? AND status = 'failed'", [req.user.userId, JSON.stringify(sources.map(s => s.document_id)), job.job_id]);
    if (!result.affectedRows) throw requestError('Only failed jobs can be retried.', 409);
    return res.status(202).json({ success: true, job_id: job.job_id });
  } catch (error) { return reportError(res, error); }
}
