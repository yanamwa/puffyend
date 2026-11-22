export async function migrateAcademicWorkflows(database) {
  // Retain the server-verified PDF extraction across upload, review and save.
  await database.execute(
    "ALTER TABLE syllabus_uploads ADD COLUMN IF NOT EXISTS extraction_json JSONB",
  );
  await database.execute(
    "ALTER TABLE syllabus_versions ADD COLUMN IF NOT EXISTS academic_context JSONB",
  );
  // The existing numeric lesson_id cannot identify a course-builder UUID draft.
  await database.execute(
    "ALTER TABLE lesson_source_documents ADD COLUMN IF NOT EXISTS module_key VARCHAR(100)",
  );
  await database.execute(
    "CREATE INDEX IF NOT EXISTS lesson_sources_module_key ON lesson_source_documents (course_id,module_key)",
  );
}
