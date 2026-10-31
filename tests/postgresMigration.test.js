import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcrypt";
import express from "express";
import {
  db,
  pgPool,
  createDatabase,
  postgresConfig,
  bindParameters,
  initializeDatabase,
  migrateLessonTables,
  finalizeDatabase,
} from "../src/database/postgres.js";
import { migrateApplication } from "../src/migrations/applicationMigration.js";
import { migrateCourseCatalog } from "../src/migrations/courseCatalogMigration.js";
import { migrateAcademicCalendar } from "../src/migrations/academicCalendarMigration.js";

const response = () => ({
  code: 200,
  status(n) {
    this.code = n;
    return this;
  },
  json(v) {
    this.body = v;
    return this;
  },
  send(v) {
    this.body = v;
    return this;
  },
  set() {
    return this;
  },
  setHeader() {},
});

test("PostgreSQL configuration and safe parameter binding", () => {
  const config = postgresConfig({
    DATABASE_URL:
      "postgresql://user:secret@example.com:5432/postgres?sslmode=require",
    DB_SCHEMA: "puffybrain",
    NODE_ENV: "production",
  });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.match(config.options, /search_path=puffybrain/);
  assert.throws(
    () => postgresConfig({ NODE_ENV: "production" }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => postgresConfig({ DATABASE_URL: "https://example.supabase.co" }),
    /PostgreSQL/,
  );
  assert.throws(
    () => postgresConfig({ DB_SCHEMA: "x;DROP TABLE users" }),
    /DB_SCHEMA/,
  );
  assert.throws(
    () =>
      postgresConfig({
        DATABASE_URL:
          "postgresql://u:p@aws-0-region.pooler.supabase.com:6543/postgres",
      }),
    /session pooler/,
  );
  const query = bindParameters(
    "SELECT '?' AS literal, ? AS value, $$?$$ AS body -- ?\n, ? AS other",
    ["x'; DROP TABLE users;--", null],
  );
  assert.equal(
    query.text,
    "SELECT '?' AS literal, $1 AS value, $$?$$ AS body -- ?\n, $2 AS other",
  );
  assert.deepEqual(query.values, ["x'; DROP TABLE users;--", null]);
  assert.throws(() => bindParameters("SELECT ?", []), /Missing/);
  assert.throws(() => bindParameters("SELECT 1", [1]), /Unexpected/);
});

test(
  "application migration and API flows run on real embedded PostgreSQL",
  { timeout: 120000 },
  async (t) => {
    const engine = new PGlite();
    await engine.exec(
      "CREATE SCHEMA puffybrain; SET search_path=puffybrain,public;",
    );
    const adapter = createDatabase({
      query: (s, v) => engine.query(s, v),
      connect: async () => ({
        query: (s, v) => engine.query(s, v),
        release() {},
      }),
      end: () => engine.close(),
    });
    const original = { ...db };
    Object.assign(db, adapter);
    let server, userId, courseId, lessonId;
    const migrate = migrateApplication;
    try {
      await t.test("all migrations are repeatable", async () => {
        await migrate();
        await migrate();
        const [[modes]] = await db.query(
          "SELECT COUNT(*) AS count FROM quiz_modes",
        );
        assert.equal(Number(modes.count), 6);
      });
      await t.test(
        "IDs, camelCase aliases, conflicts and bound values survive the driver change",
        async () => {
          const [user] = await db.execute(
            "INSERT INTO users(name,email,password,role,is_verified,verification_status) VALUES(?,?,?,'super_admin',1,'approved')",
            [
              "Migration Admin",
              "admin@example.test",
              await bcrypt.hash("Test-Password-123!", 4),
            ],
          );
          userId = user.insertId;
          assert.ok(userId);
          const [[row]] = await db.query(
            "SELECT userId, name AS displayName FROM users WHERE userId=?",
            [userId],
          );
          assert.equal(row.userId, userId);
          assert.equal(row.displayName, "Migration Admin");
          const [course] = await db.execute(
            "INSERT INTO courses(title,code,summary,subject,professor_id,status) VALUES(?,?,?,?,?,'published')",
            ["Biology", "BIO-101", "Cells", "Science", userId],
          );
          courseId = course.insertId;
          const [lesson] = await db.execute(
            "INSERT INTO learning_modules(course_id,title,status) VALUES(?,?,'published')",
            [courseId, "Cells"],
          );
          lessonId = lesson.insertId;
          const injection = "x'; DROP TABLE users;--";
          await db.execute("UPDATE users SET name=? WHERE userId=?", [
            injection,
            userId,
          ]);
          const [[saved]] = await db.execute(
            "SELECT name FROM users WHERE userId=?",
            [userId],
          );
          assert.equal(saved.name, injection);
          await db.execute(
            "UPDATE users SET name='Migration Admin' WHERE userId=?",
            [userId],
          );
        },
      );
      await t.test(
        "imported boolean flags and ordinary generated columns are migrated without losing users",
        async () => {
          await db.query(
            "ALTER TABLE users ALTER COLUMN is_verified DROP DEFAULT",
          );
          await db.query(
            "ALTER TABLE users ALTER COLUMN is_verified TYPE BOOLEAN USING (is_verified<>0)",
          );
          await db.query(
            "ALTER TABLE users ALTER COLUMN is_verified SET DEFAULT FALSE",
          );
          await db.query(
            "ALTER TABLE course_catalog ALTER COLUMN available_normalized_code DROP EXPRESSION",
          );
          await db.query(
            "CREATE UNIQUE INDEX imported_old_code ON course_catalog(normalized_code)",
          );
          await initializeDatabase();
          await migrateCourseCatalog(db);
          const [[user]] = await db.query(
            "SELECT userId,is_verified FROM users WHERE userId=?",
            [userId],
          );
          assert.equal(user.userId, userId);
          assert.equal(user.is_verified, 1);
          const [catalog] = await db.execute(
            "INSERT INTO course_catalog(code,normalized_code,title,programs,status) VALUES('BIO','BIO','Biology',?,'active')",
            [JSON.stringify(["BSIT"])],
          );
          await assert.rejects(
            db.execute(
              "INSERT INTO course_catalog(code,normalized_code,title,programs) VALUES('BIO','BIO','Duplicate','[]')",
            ),
            (e) => e.code === "23505",
          );
          await db.execute(
            "UPDATE course_catalog SET archived_at=NOW() WHERE catalog_id=?",
            [catalog.insertId],
          );
          await db.execute(
            "INSERT INTO course_catalog(code,normalized_code,title,programs) VALUES('BIO','BIO','Replacement','[]')",
          );
          const [[count]] = await db.execute(
            "SELECT COUNT(*) AS count FROM course_catalog WHERE programs::jsonb @> ?::jsonb",
            [JSON.stringify("BSIT")],
          );
          assert.equal(Number(count.count), 1);
        },
      );
      await t.test(
        "login and authenticated frontend course requests work over HTTP with CORS",
        async () => {
          const { default: authRoutes } =
            await import("../src/routes/authRoutes.js");
          const { default: courseRoutes } =
            await import("../src/routes/courseRoutes.js");
          const { default: catalogRoutes } =
            await import("../src/routes/catalogRoutes.js");
          const { apiCors, mountApiAvailability } =
            await import("../src/middleware/apiAvailability.js");
          const app = express();
          app.use(apiCors(["https://puffybrain.fun"]));
          mountApiAvailability(app, { ready: true });
          app.use(express.json());
          app.use("/api", authRoutes);
          app.use("/api", courseRoutes);
          app.use("/api/catalog", catalogRoutes);
          server = app.listen(0, "127.0.0.1");
          await new Promise((r) => server.once("listening", r));
          const base = `http://127.0.0.1:${server.address().port}`;
          const login = await fetch(`${base}/api/login`, {
            method: "POST",
            headers: {
              Origin: "https://puffybrain.fun",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: "admin@example.test",
              password: "Test-Password-123!",
            }),
          });
          assert.equal(login.status, 200);
          assert.equal(
            login.headers.get("access-control-allow-origin"),
            "https://puffybrain.fun",
          );
          const session = await login.json();
          assert.equal(session.success, true);
          assert.equal(session.user.userId, userId);
          assert.ok(session.token);
          const courses = await fetch(`${base}/api/courses`, {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          assert.equal(courses.status, 200);
          assert.equal((await courses.json()).success, true);
          for (const path of [
            "/api/catalog/summary",
            "/api/catalog?q=bio&program=BSIT",
          ]) {
            const result = await fetch(`${base}${path}`, {
              headers: { Authorization: `Bearer ${session.token}` },
            });
            assert.equal(result.status, 200);
            assert.equal((await result.json()).success, true);
          }
          const invalid = await fetch(`${base}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: "admin@example.test",
              password: "wrong",
            }),
          });
          assert.equal(invalid.status, 401);
        },
      );
      await t.test(
        "progress and quiz writes update rather than duplicate records",
        async () => {
          const { saveLessonProgress, saveQuizAttempt } =
            await import("../src/controllers/monitoringController.js");
          for (const studied of [1, 2]) {
            const res = response();
            await saveLessonProgress(
              {
                user: { userId },
                body: {
                  lessonId,
                  courseId,
                  totalCards: 2,
                  studiedCards: studied,
                },
              },
              res,
            );
            assert.equal(res.code, 200);
            assert.equal(res.body.success, true);
          }
          const [[count]] = await db.query(
            "SELECT COUNT(*) AS count FROM lesson_progress",
          );
          assert.equal(Number(count.count), 1);
          const quiz = response();
          await saveQuizAttempt(
            {
              user: { userId },
              body: {
                lessonId,
                courseId,
                score: 1,
                total: 2,
                quizMode: "multiple_choice",
                source: "lesson",
              },
            },
            quiz,
          );
          assert.equal(quiz.code, 201);
          assert.equal(quiz.body.success, true);
        },
      );
      await t.test(
        "quiz config upserts increment revisions and JSON job checkpoints persist",
        async () => {
          const sql =
            "INSERT INTO main_quiz_configs(course_id,module_id,config_json) VALUES(?,?,?) ON CONFLICT (course_id,module_id) DO UPDATE SET config_json=EXCLUDED.config_json,revision=main_quiz_configs.revision+1";
          await db.execute(sql, [courseId, "module-1", "{}"]);
          await db.execute(sql, [courseId, "module-1", '{"enabled":true}']);
          const [[row]] = await db.query(
            "SELECT revision FROM main_quiz_configs WHERE course_id=?",
            [courseId],
          );
          assert.equal(row.revision, 2);
          await db.execute(
            "INSERT INTO lesson_rag_jobs(job_id,job_type,course_id,requester_id,payload) VALUES('test-job','generate',?,?,?)",
            [courseId, userId, '{"fingerprint":"abc"}'],
          );
          await db.execute(
            "UPDATE lesson_rag_jobs SET payload=jsonb_set(payload::jsonb,'{outlineCheckpoint}',?::jsonb),next_run_at=(NOW()+INTERVAL '30 second') WHERE job_id='test-job'",
            ['{"phase":"ready"}'],
          );
          const [[job]] = await db.query(
            "SELECT payload FROM lesson_rag_jobs WHERE payload::jsonb->>'fingerprint'=?",
            ["abc"],
          );
          assert.equal(job.payload.outlineCheckpoint.phase, "ready");
        },
      );
      await t.test(
        "reports and analytics execute PostgreSQL aggregates and date ranges",
        async () => {
          const { getSystemAnalytics } =
            await import("../src/controllers/systemAnalyticsController.js");
          const { getReports } =
            await import("../src/controllers/reportController.js");
          const analytics = response();
          await getSystemAnalytics({}, analytics);
          assert.equal(analytics.code, 200);
          assert.equal(analytics.body.success, true);
          assert.equal(analytics.body.quizzes.averageScore, 50);
          const reports = response();
          let failure;
          await getReports(
            { query: { start: "2020-01-01", end: "2030-12-31" } },
            reports,
            (e) => {
              failure = e;
            },
          );
          if (failure) throw failure;
          assert.equal(reports.code, 200);
          assert.equal(reports.body.success, true);
        },
      );
      await t.test(
        "system settings load and save PostgreSQL boolean values",
        async () => {
          const { getSystemSettings, updateSystemSettings } =
            await import("../src/controllers/systemSettingsController.js");
          const before = response();
          await getSystemSettings({}, before);
          assert.equal(before.code, 200);
          const saved = response();
          await updateSystemSettings(
            {
              user: { userId, role: "super_admin" },
              headers: {},
              body: {
                ...before.body.settings,
                systemName: "Postgres Test",
                academicYear: "2026-2027",
                semester: "1st Semester",
                maintenanceMode: true,
              },
            },
            saved,
          );
          assert.equal(saved.code, 200);
          assert.equal(saved.body.success, true);
          const [[row]] = await db.query(
            "SELECT maintenance_mode FROM system_settings",
          );
          assert.equal(row.maintenance_mode, true);
        },
      );
      await t.test(
        "PostgreSQL session locks protect background operations",
        async () => {
          const { withDatabaseLock } =
            await import("../src/services/rag/vectorRepository.js");
          assert.equal(
            await withDatabaseLock("migration-test", async () => 42),
            42,
          );
        },
      );
      await t.test(
        "backup round trip preserves JSON, generated values, IDs, and next sequence values",
        async () => {
          const { createDatabaseBackup, restoreDatabaseBackup } =
            await import("../src/controllers/backupController.js");
          await db.execute(
            "INSERT INTO academic_calendars(title,academic_year,events,published,filename,mime_type,document,updated_by) VALUES('Test','2026-2027',?,1,'test.pdf','application/pdf',?,?)",
            [
              JSON.stringify([{ title: "Term start" }]),
              Buffer.from("%PDF-test"),
              userId,
            ],
          );
          const req = {
            user: { userId, role: "super_admin", name: "Migration Admin" },
            headers: {},
          };
          const backup = response();
          await createDatabaseBackup(req, backup);
          assert.equal(backup.code, 200);
          const content = JSON.parse(backup.body);
          const restored = response();
          await restoreDatabaseBackup({ ...req, body: content }, restored);
          assert.equal(restored.code, 200, restored.body?.message);
          assert.equal(restored.body.success, true);
          const [[user]] = await db.query(
            "SELECT userId FROM users WHERE email='admin@example.test'",
          );
          assert.equal(user.userId, userId);
          const [[calendar]] = await db.query(
            "SELECT events,document FROM academic_calendars",
          );
          assert.equal(calendar.events[0].title, "Term start");
          assert.equal(calendar.document.toString(), "%PDF-test");
          const [next] = await db.execute(
            "INSERT INTO users(name,email,password) VALUES('Next','next@example.test','hash')",
          );
          assert.ok(Number(next.insertId) > Number(userId));
        },
      );
    } finally {
      if (server) await new Promise((r) => server.close(r));
      Object.assign(db, original);
      await engine.close();
      await pgPool.end();
    }
  },
);
