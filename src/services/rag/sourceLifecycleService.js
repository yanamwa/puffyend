import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../../db.js";

export const sourceDirectory = fileURLToPath(
  new URL("../../uploads/lessons/", import.meta.url),
);

export function assertPrivatePath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(sourceDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Invalid private source path.");
  return resolved;
}

export async function removePrivateFile(filePath) {
  const safe = assertPrivatePath(filePath);
  const metadata = await fs.lstat(safe).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (metadata?.isDirectory()) throw new Error("Refusing directory deletion.");
  await fs.unlink(safe).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function drainFileDeletions() {
  const [rows] = await db.execute(
    "SELECT deletion_id, storage_path FROM lesson_rag_file_deletions ORDER BY deletion_id LIMIT 50",
  );
  for (const row of rows) {
    try {
      await removePrivateFile(row.storage_path);
      await db.execute(
        "DELETE FROM lesson_rag_file_deletions WHERE deletion_id = ?",
        [row.deletion_id],
      );
    } catch (error) {
      await db.execute(
        "UPDATE lesson_rag_file_deletions SET attempts = attempts + 1, last_error = ? WHERE deletion_id = ?",
        [error.message.slice(0, 500), row.deletion_id],
      );
    }
  }
}

export async function deleteWithSources({ entity, id, deleteSql, parameters }) {
  if (!["course", "lesson", "document"].includes(entity))
    throw new Error("Invalid deletion scope.");
  const column = {
    course: "course_id",
    lesson: "lesson_id",
    document: "document_id",
  }[entity];
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [sources] = await connection.execute(
      `SELECT storage_path FROM lesson_source_documents WHERE ${column} = ? FOR UPDATE`,
      [id],
    );
    const jobCondition =
      entity === "document"
        ? "(j.document_id = ? OR EXISTS (SELECT 1 FROM lesson_rag_job_documents r WHERE r.job_id = j.job_id AND r.document_id = ?))"
        : `j.${column} = ?`;
    const jobParameters = entity === "document" ? [id, id] : [id];
    const [jobs] = await connection.execute(
      `SELECT j.job_id, j.input_path FROM lesson_rag_jobs j WHERE ${jobCondition} FOR UPDATE`,
      jobParameters,
    );
    const inputs = [];
    for (const job of jobs) {
      const [rows] = await connection.execute(
        "SELECT storage_path FROM lesson_rag_job_inputs WHERE job_id = ?",
        [job.job_id],
      );
      inputs.push(...rows);
    }
    if (entity === "document")
      for (const job of jobs)
        await connection.execute(
          "DELETE FROM lesson_rag_jobs WHERE job_id = ?",
          [job.job_id],
        );
    const [result] = await connection.execute(deleteSql, parameters);
    if (result.affectedRows) {
      for (const storagePath of new Set(
        [
          ...sources.map((s) => s.storage_path),
          ...jobs.map((j) => j.input_path),
          ...inputs.map((i) => i.storage_path),
        ].filter(Boolean),
      )) {
        assertPrivatePath(storagePath);
        await connection.execute(
          "INSERT INTO lesson_rag_file_deletions (storage_path) VALUES (?)",
          [storagePath],
        );
      }
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function sweepOrphanSources() {
  await fs.mkdir(sourceDirectory, { recursive: true });
  const [documents] = await db.execute(
    "SELECT storage_path FROM lesson_source_documents",
  );
  const [jobs] = await db.execute(
    "SELECT input_path FROM lesson_rag_jobs WHERE input_path IS NOT NULL",
  );
  const [inputs] = await db.execute(
    "SELECT storage_path FROM lesson_rag_job_inputs",
  );
  const retained = new Set([
    ...documents.map((d) => path.resolve(d.storage_path)),
    ...jobs.map((j) => path.resolve(j.input_path)),
    ...inputs.map((i) => path.resolve(i.storage_path)),
  ]);
  for (const name of await fs.readdir(sourceDirectory)) {
    const filePath = path.join(sourceDirectory, name);
    const info = await fs.lstat(filePath);
    if (
      !info.isFile() ||
      retained.has(filePath) ||
      Date.now() - info.mtimeMs < 3600000
    )
      continue;
    await removePrivateFile(filePath);
  }
}
