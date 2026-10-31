import { migrateCatalogCodeAvailability } from "./catalogCodeAvailability.js";
import { recoverCatalogModuleShells } from "../services/courses/courseModulePersistence.js";
import fs from "node:fs/promises";

// Additive and repeatable. Existing class records and unique join codes are preserved.
export async function migrateCourseCatalog(db) {
  const sql = await fs.readFile(
    new URL("./create_course_catalog.sql", import.meta.url),
    "utf8",
  );
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.query(statement);
  await migrateCatalogCodeAvailability(db);
  const [versionColumns] = await db.query(
    "SELECT column_name AS \"Field\" FROM information_schema.columns WHERE table_schema=CURRENT_SCHEMA() AND table_name='syllabus_versions'",
  );
  if (!versionColumns.some((column) => column.Field === "coverage_modules"))
    await db.query(
      "ALTER TABLE syllabus_versions ADD COLUMN coverage_modules JSONB NULL",
    );
  const [columns] = await db.query("SELECT column_name AS \"Field\" FROM information_schema.columns WHERE table_schema=CURRENT_SCHEMA() AND table_name='courses'");
  const names = new Set(columns.map((c) => c.Field));
  for (const [name, type] of Object.entries({
    content_modules: "JSONB NULL",
    catalog_id: "INT NULL",
    syllabus_version_id: "INT NULL",
    catalog_code: "VARCHAR(50) NULL",
    class_name: "VARCHAR(255) NULL",
    academic_year: "VARCHAR(30) NULL",
    semester: "VARCHAR(30) NULL",
    program: "VARCHAR(10) NULL",
    year_level: "VARCHAR(50) NULL",
    section_name: "VARCHAR(50) NULL",
  }))
    if (!names.has(name))
      await db.query(`ALTER TABLE courses ADD COLUMN ${name} ${type}`);
  const [constraints] = await db.query(
    "SELECT CONSTRAINT_NAME FROM information_schema.table_constraints WHERE TABLE_SCHEMA=CURRENT_SCHEMA() AND TABLE_NAME='courses'",
  );
  const existing = new Set(constraints.map((c) => c.CONSTRAINT_NAME));
  if (!existing.has("courses_catalog_fk"))
    await db.query(
      "ALTER TABLE courses ADD CONSTRAINT courses_catalog_fk FOREIGN KEY (catalog_id) REFERENCES course_catalog(catalog_id)",
    );
  if (!existing.has("courses_syllabus_catalog_fk"))
    await db.query(
      "ALTER TABLE courses ADD CONSTRAINT courses_syllabus_catalog_fk FOREIGN KEY (syllabus_version_id, catalog_id) REFERENCES syllabus_versions(version_id, catalog_id)",
    );
  await recoverCatalogModuleShells(db);
}
