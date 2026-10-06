import { parallelMap } from './parallelMap.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractText } from './extractText.js';
import { chunkText } from './chunkText.js';
import { embeddingConfig, embedTexts } from './embeddingService.js';
import { createDocument, saveChunks, markFailed, loadChunks, loadDocument, findReusableDocument, withDatabaseLock, withDatabaseLocks } from './vectorRepository.js';
import { retrieveContexts } from './retrievalService.js';
import { createSemanticOutline } from './outlineService.js';
import { generateGroundedPage } from './groundingService.js';
import { sourceDirectory, assertPrivatePath, removePrivateFile } from './sourceLifecycleService.js';
import { db } from '../../db.js';

async function extractChunks(file) {
  const chunks = chunkText(await extractText(file));
  if (chunks.length > 200) throw Object.assign(new Error('This document exceeds 200 chunks. Split it into smaller files.'), { statusCode: 413 });
  return chunks;
}

export async function indexDocument({ file, courseId, lessonId, uploaderId, preparedChunks, onProgress = async () => {} }) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
  const config = embeddingConfig();
  const scopeHash = crypto.createHash('sha256').update(`${courseId}:${lessonId ?? ''}:${hash}`).digest('hex').slice(0, 48);
  return withDatabaseLock(`rag-upload:${scopeHash}`, async () => {
    const existing = await findReusableDocument(courseId, lessonId, hash, config);
    if (existing) return existing.document_id;
    await onProgress({ phase: 'extracting', progress: 5 });
    const chunks = preparedChunks || await extractChunks(file);
    await fs.mkdir(sourceDirectory, { recursive: true });
    const storagePath = path.join(sourceDirectory, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    await fs.copyFile(file.path, storagePath);
    let documentId;
    try {
      documentId = await createDocument({ courseId, lessonId, uploaderId, file, hash, storagePath });
      await onProgress({ phase: 'embedding', progress: 10, documentId });
      const vectors = await embedTexts(chunks.map(c => c.text), 'RETRIEVAL_DOCUMENT', config);
      await saveChunks(documentId, chunks, vectors, config);
      return documentId;
    } catch (error) {
      if (documentId) await markFailed(documentId, error).catch(() => {});
      else await removePrivateFile(storagePath).catch(() => {});
      throw error;
    }
  });
}

export async function reindexDocument(documentId, onProgress = async () => {}) {
  return withDatabaseLock(`rag-document:${documentId}`, async () => {
    const document = await loadDocument(documentId);
    if (!document) throw Object.assign(new Error('Source not found.'), { statusCode: 404 });
    const file = { path: assertPrivatePath(document.storage_path), originalname: document.filename };
    try {
      await db.execute("UPDATE lesson_source_documents SET processing_status = 'processing', processing_error = NULL WHERE document_id = ?", [documentId]);
      const hash = crypto.createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
      if (hash !== document.content_hash) throw Object.assign(new Error('Stored source checksum changed. Upload the revised file as a new source.'), { statusCode: 409 });
      await onProgress({ phase: 'extracting', progress: 5, documentId });
      const chunks = await extractChunks(file);
      const config = embeddingConfig();
      await onProgress({ phase: 'embedding', progress: 10 });
      await saveChunks(documentId, chunks, await embedTexts(chunks.map(c => c.text), 'RETRIEVAL_DOCUMENT', config), config);
      return documentId;
    } catch (error) { await markFailed(documentId, error); throw error; }
  });
}

export function computeCoverage(chunks, outline, pages, suppliedIds) {
  const points = outline.topics.flatMap(t => t.key_points);
  const covered = new Set(pages.flatMap(p => p.covered_point_ids));
  const cited = new Set(pages.flatMap(p => p.source_chunks.map(c => String(c.chunk_id))));
  const missing = points.filter(p => !covered.has(p.id)).map(p => p.id);
  return { total_chunks: chunks.length, supplied_chunks: suppliedIds.size, cited_chunks: cited.size,
    evidence_ratio: suppliedIds.size / chunks.length,
    required_key_points: points.length, reviewed_key_points: points.length - missing.length,
    key_point_ratio: (points.length - missing.length) / points.length, missing_point_ids: missing,
    human_review_required: true,
    meaning: 'Evidence ratio measures prompt inclusion. Key-point ratio measures model-reviewed coverage of extracted points, not every fact in the original.' };
}

export async function generateFromDocument(documentId, onProgress = async () => {}) {
  return generateFromDocuments([documentId], onProgress);
}

export async function generateFromDocuments(documentIds, onProgress = async () => {}, checkpoint = []) {
  const ids = [...new Set(documentIds.map(String))];
  return withDatabaseLocks(ids.map(id => `rag-document:${id}`), async () => {
    const sources = await Promise.all(ids.map(loadDocument));
    if (sources.some(s => !s)) throw Object.assign(new Error('A selected source no longer exists.'), { statusCode: 404 });
    if (sources.some(s => s.course_id !== sources[0].course_id || s.lesson_id !== sources[0].lesson_id)) throw Object.assign(new Error('Sources must belong to the same course/module scope.'), { statusCode: 403 });
    const chunks = [];
    for (const source of sources) {
      if (source.processing_status !== 'ready') throw Object.assign(new Error(`${source.filename} is not ready. Reindex it first.`), { statusCode: 409 });
      const sourceChunks = await loadChunks(source.document_id);
      if (!sourceChunks.length) throw Object.assign(new Error(`${source.filename} is not indexed.`), { statusCode: 409 });
      for (const chunk of sourceChunks) chunks.push({ ...chunk, source_filename: source.filename, source_order: chunks.length });
    }
    if (!chunks.length) throw Object.assign(new Error('Document is not ready.'), { statusCode: 409 });
    if (chunks.length > 200) throw Object.assign(new Error('The combined materials exceed 200 chunks. Generate smaller batches.'), { statusCode: 413 });
    const outline = await createSemanticOutline(chunks, onProgress, checkpoint);
    const used = new Set();
    const configured = Number(process.env.RAG_PAGE_CONCURRENCY || 3);
    const concurrency = Number.isInteger(configured) ? Math.max(1, Math.min(4, configured)) : 3;
    let completed = 0, progressQueue = Promise.resolve();
    await onProgress({ phase: `generating ${outline.topics.length} pages`, progress: 40 });
    const pages = await parallelMap(outline.topics, concurrency, async topic => {
      const relevant = await retrieveContexts(ids, topic.title, { topK: 3, chunks });
      const context = [...new Map([...topic.anchors, ...relevant].map(c => [String(c.chunk_id), c])).values()].sort((a, b) => a.source_order - b.source_order);
      const page = await generateGroundedPage(topic, context);
      const citedSources = sources.filter(source => page.source_chunks.some(c => String(c.document_id) === String(source.document_id)));
      const result = { ...page, source_document_id: ids.length === 1 ? sources[0].document_id : null,
        source_document_ids: citedSources.map(s => s.document_id), source_filename: citedSources.map(s => s.filename).join(', ') };
      context.forEach(c => used.add(String(c.chunk_id)));
      const count = ++completed;
      // Serialize database progress writes; completed page order may differ from source order.
      progressQueue = progressQueue.then(() => onProgress({ phase: `verified ${count}/${outline.topics.length} pages`, progress: 40 + Math.round(55 * count / outline.topics.length) }));
      await progressQueue;
      return result;
    });
    const coverage = computeCoverage(chunks, outline, pages, used);
    coverage.sources = sources.map(source => {
      const local = chunks.filter(c => String(c.document_id) === String(source.document_id));
      return { document_id: source.document_id, filename: source.filename, total_chunks: local.length,
        supplied_chunks: local.filter(c => used.has(String(c.chunk_id))).length };
    });
    if (coverage.missing_point_ids.length) throw Object.assign(new Error('Required key points are missing.'), { statusCode: 422 });
    const { topics, ...metadata } = outline;
    return { ...metadata, document_id: sources[0].document_id, document_ids: sources.map(s => s.document_id), lesson_pages: pages,
      outline: topics.map(({ anchors: ignored, ...topic }) => topic), source_coverage: coverage,
      rag_version: '3', embedding_model: chunks[0].embedding_model, embedding_dimensions: chunks[0].embedding_dimensions,
      generation_model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  });
}

export async function processLessonWithRag(options) {
  const files = options.files || (options.file ? [options.file] : []);
  if (!files.length || files.length > 10) throw Object.assign(new Error('Select between 1 and 10 files.'), { statusCode: 400 });
  const progress = options.onProgress || (async () => {});
  const prepared = [];
  for (const file of files) {
    try { prepared.push(await extractChunks(file)); }
    catch (error) { throw Object.assign(new Error(`${file.originalname}: ${error.message}`), { statusCode: error.statusCode || 422 }); }
  }
  if (prepared.flat().length > 200) throw Object.assign(new Error('The combined materials exceed 200 chunks. Generate smaller batches.'), { statusCode: 413 });
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const documentId = await indexDocument({ ...options, file: files[i], preparedChunks: prepared[i],
      onProgress: async step => {
        if (step.documentId) await progress({ phase: `indexing ${files[i].originalname}`, progress: 5 + Math.round(20 * i / files.length), documentId: ids[0] || step.documentId, documentIds: [...ids, step.documentId] });
      },
    });
    if (!ids.includes(documentId)) ids.push(documentId);
    await progress({ phase: 'indexed', progress: 5 + Math.round(20 * (i + 1) / files.length), documentId: ids[0], documentIds: ids });
  }
  return generateFromDocuments(ids, progress, options.outlineCheckpoint || []);
}
