import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { migrateCatalogCodeAvailability } from "../../src/migrations/catalogCodeAvailability.js";
dotenv.config({quiet:true});
test("archived codes can be reused; current codes and restores remain unique", async () => {
 const db = await mysql.createConnection({host:process.env.DB_HOST || "127.0.0.1",user:process.env.DB_USER || "root",password:process.env.DB_PASSWORD || "",database:process.env.DB_NAME || "puffybrain"});
 try {
  // Temporary table shadows the application table on this connection only.
  await db.query(`CREATE TEMPORARY TABLE course_catalog (catalog_id INT AUTO_INCREMENT PRIMARY KEY, normalized_code VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, archived_at DATETIME NULL, UNIQUE KEY catalog_normalized_code(normalized_code))`);
  await db.query("INSERT INTO course_catalog(normalized_code,archived_at) VALUES ('GNED05',NOW())");
  await migrateCatalogCodeAvailability(db);
  await migrateCatalogCodeAvailability(db);
  await db.query("INSERT INTO course_catalog(normalized_code) VALUES ('GNED05')");
  await assert.rejects(db.query("INSERT INTO course_catalog(normalized_code) VALUES ('GNED05')"), {code:"ER_DUP_ENTRY"});
  await assert.rejects(db.query("UPDATE course_catalog SET archived_at=NULL WHERE catalog_id=1"), {code:"ER_DUP_ENTRY"});
  await db.query("UPDATE course_catalog SET archived_at=NOW() WHERE catalog_id=2");
  await db.query("UPDATE course_catalog SET archived_at=NULL WHERE catalog_id=1");
  const [[row]] = await db.query("SELECT COUNT(*) AS total FROM course_catalog");
  assert.equal(row.total,2);
 } finally { await db.end(); }
});
