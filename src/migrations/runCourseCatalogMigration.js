import { db } from "../db.js";
import { migrateCourseCatalog } from "./courseCatalogMigration.js";
try {
  await migrateCourseCatalog(db);
  console.log(
    "Course Catalog migration complete. Existing class records preserved.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.end();
}
