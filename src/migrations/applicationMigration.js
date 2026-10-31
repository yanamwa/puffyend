import { db, initDb } from "../db.js";
import { migrateCourseCatalog } from "./courseCatalogMigration.js";
import { migrateAcademicCalendar } from "./academicCalendarMigration.js";
import { migrateLessonTables, finalizeDatabase } from "../database/postgres.js";
import { reconcileArchivedCatalogClasses } from "../services/catalog/catalogArchive.js";

export async function migrateApplication() {
  // Deployments may overlap. Serialize schema changes on a dedicated session.
  const connection = await db.getConnection();
  let locked = false;
  try {
    await connection.query("SET statement_timeout='120s'");
    await connection.query(
      "SELECT pg_advisory_lock(hashtextextended(?::text,0))",
      [`puffy-schema:${process.env.DB_SCHEMA || "puffybrain"}`],
    );
    locked = true;
    await initDb();
    await migrateCourseCatalog(db);
    await migrateAcademicCalendar(db);
    await migrateLessonTables(db);
    await finalizeDatabase(db);
    await reconcileArchivedCatalogClasses(db);
  } finally {
    try {
      if (locked)
        await connection.query(
          "SELECT pg_advisory_unlock(hashtextextended(?::text,0))",
          [`puffy-schema:${process.env.DB_SCHEMA || "puffybrain"}`],
        );
      await connection.query("RESET statement_timeout");
    } finally {
      connection.release();
    }
  }
}
