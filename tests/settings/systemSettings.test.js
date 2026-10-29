import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config({ quiet: true });
test("settings load and save using valid SQL whitespace", async () => {
 const schema = "puffy_settings_test_" + process.pid;
 const source = process.env.DB_NAME || "puffybrain";
 const bootstrap = await mysql.createConnection({ host: process.env.DB_HOST || "127.0.0.1", user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "" });
 let pool;
 try {
  await bootstrap.query("CREATE DATABASE ??", [schema]);
  for (const table of ["system_settings", "audit_logs"]) await bootstrap.query("CREATE TABLE ??.?? LIKE ??.??", [schema, table, source, table]);
  await bootstrap.query(`INSERT INTO ??.system_settings (system_name,academic_year,semester) VALUES ('Test System','2026-2027','1st Semester')`, [schema]);
  process.env.DB_NAME = schema;
  ({ db: pool } = await import("../../src/db.js"));
  const { getSystemSettings, updateSystemSettings } = await import("../../src/controllers/systemSettingsController.js");
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const loaded = response(); await getSystemSettings({}, loaded);
  assert.equal(loaded.code, 200); assert.equal(loaded.body.success, true);
  assert.equal(loaded.body.settings.systemName, "Test System");
  const saved = response();
  await updateSystemSettings({ body: { ...loaded.body.settings, systemName: "Updated Test System" }, user: { userId: 1, role: "super_admin", name: "Test Admin" }, headers: {} }, saved);
  assert.equal(saved.code, 200); assert.equal(saved.body.success, true);
  const reloaded = response(); await getSystemSettings({}, reloaded);
  assert.equal(reloaded.body.settings.systemName, "Updated Test System");
 } finally {
  if (pool) await pool.end();
  await bootstrap.query("DROP DATABASE IF EXISTS ??", [schema]); await bootstrap.end();
 }
});
