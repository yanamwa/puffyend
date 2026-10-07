import { db } from '../../db.js';
import { validateVector } from './embeddingService.js';

export async function createDocument({ courseId, lessonId, uploaderId, file, hash, storagePath }) {
  const [result] = await db.execute(`INSERT INTO lesson_source_documents
    (course_id, lesson_id, uploader_id, filename, storage_path, mime_type, file_size_bytes, content_hash, processing_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')`,
  [courseId, lessonId ?? null, uploaderId, file.originalname, storagePath, file.mimetype, file.size, hash]);
  return result.insertId;
}

export async function saveChunks(documentId, chunks, vectors, config) {
  if (chunks.length !== vectors.length || !chunks.length) throw new Error('Chunks and vectors must match.');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM lesson_source_chunks WHERE document_id = ?', [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await connection.execute(`INSERT INTO lesson_source_chunks
        (document_id, chunk_order, source_start, source_end, source_position, chunk_text, embedding, embedding_model, embedding_dimensions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [documentId, chunk.order, chunk.start, chunk.end, JSON.stringify(chunk.position), chunk.text,
        JSON.stringify(validateVector(vectors[i], config.dimensions)), config.model, config.dimensions]);
    }
    await connection.execute("UPDATE lesson_source_documents SET processing_status = 'ready', processing_error = NULL, chunk_count = ? WHERE document_id = ?", [chunks.length, documentId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function markFailed(documentId, error) {
  await db.execute("UPDATE lesson_source_documents SET processing_status = 'failed', processing_error = ? WHERE document_id = ?", [String(error.message).slice(0, 2000), documentId]);
}

export async function loadDocument(documentId) {
  const [rows] = await db.execute('SELECT * FROM lesson_source_documents WHERE document_id = ?', [documentId]);
  return rows[0];
}

export async function findReusableDocument(courseId, lessonId, hash, config) {
  const [rows] = await db.execute(`SELECT d.* FROM lesson_source_documents d
    WHERE d.course_id = ? AND d.lesson_id <=> ? AND d.content_hash = ? AND d.processing_status = 'ready'
    AND d.chunk_count > 0 AND d.chunk_count = (SELECT COUNT(*) FROM lesson_source_chunks c WHERE c.document_id = d.document_id)
    AND NOT EXISTS (SELECT 1 FROM lesson_source_chunks c WHERE c.document_id = d.document_id
      AND (c.embedding_model <> ? OR c.embedding_dimensions <> ?))
    ORDER BY d.document_id DESC LIMIT 1`, [courseId, lessonId ?? null, hash, config.model, config.dimensions]);
  return rows[0];
}

export async function withDatabaseLock(name, operation) {
  return withDatabaseLocks([name], operation);
}

export async function withDatabaseLocks(names, operation) {
  const connection = await db.getConnection();
  const acquired = [];
  try {
    for (const name of [...new Set(names)].sort()) {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 5) AS acquired', [name]);
      if (Number(rows[0].acquired) !== 1) throw Object.assign(new Error('This source is already being processed. Retry shortly.'), { retryable: true, statusCode: 409 });
      acquired.push(name);
    }
    return await operation();
  } finally {
    try { for (const name of acquired.reverse()) await connection.execute('SELECT RELEASE_LOCK(?)', [name]); }
    finally { connection.release(); }
  }
}

export async function loadChunks(documentId) {
  const [rows] = await db.execute(`SELECT c.* FROM lesson_source_chunks c JOIN lesson_source_documents d
    ON d.document_id = c.document_id WHERE c.document_id = ? AND d.processing_status = 'ready' ORDER BY c.chunk_order`, [documentId]);
  return rows.map(row => ({ ...row,
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    source_position: typeof row.source_position === 'string' ? JSON.parse(row.source_position) : row.source_position,
  }));
}
