import { db } from "../db.js";
import { migrateApplication } from "./applicationMigration.js";
try {
  await migrateApplication();
  console.log("PostgreSQL application migrations completed.");
} catch (error) {
  console.error(
    "PostgreSQL migration failed:",
    error.code || "configuration error",
    error.message,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
