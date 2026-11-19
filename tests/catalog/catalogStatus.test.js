import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { JWT_SECRET } from "../../src/config/security.js";
import { createDatabase, db } from "../../src/database/postgres.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import catalogRoutes from "../../src/routes/catalogRoutes.js";
import { resolveClassCatalog } from "../../src/services/catalog/classCatalogService.js";
import {
  syllabusDirectory,
  syllabusFilePath,
} from "../../src/services/catalog/syllabusStorage.js";
import { makePdf } from "../helpers/fixtureBuilders.js";

test(
  "super admins toggle syllabus catalog visibility directly and notify uploaders",
  { timeout: 60_000 },
  async (t) => {
    const engine = new PGlite();
    await engine.exec(
      "CREATE SCHEMA puffybrain; SET search_path=puffybrain,public",
    );
    const query = (sql, values) => engine.query(sql, values);
    const originalDb = { ...db };
    Object.assign(
      db,
      createDatabase({ query, connect: async () => ({ query, release() {} }) }),
    );
    t.after(async () => {
      try {
        const { rows } = await engine.query(
          "SELECT storage_name FROM syllabus_versions UNION SELECT storage_name FROM syllabus_uploads",
        );
        for (const { storage_name } of rows)
          await fs.rm(syllabusFilePath(storage_name), { force: true });
      } finally {
        Object.assign(db, originalDb);
        await engine.close();
      }
    });

    const readdir = fs.readdir;
    t.mock.method(fs, "readdir", (directory, ...args) =>
      directory === syllabusDirectory
        ? Promise.resolve([])
        : readdir(directory, ...args),
    );

    const mail = [];
    const smtp = {
      OTP_SMTP_HOST: "smtp.example.test",
      OTP_SMTP_PORT: "587",
      OTP_SMTP_USERNAME: "sender@example.test",
      OTP_SMTP_PASSWORD: "test",
      OTP_SMTP_FROM_EMAIL: "sender@example.test",
    };
    const previousSmtp = Object.fromEntries(
      Object.keys(smtp).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, smtp);
    t.after(() => {
      for (const [key, value] of Object.entries(previousSmtp)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    t.mock.method(nodemailer, "createTransport", () => ({
      async sendMail(message) {
        const {
          rows: [course],
        } = await engine.query("SELECT status FROM course_catalog");
        assert.match(message.subject, new RegExp(`now ${course.status}$`));
        mail.push(message);
        return { accepted: [message.to.address] };
      },
    }));

    await migrateApplication();
    const roles = ["admin", "professor", "super_admin", "student"];
    const tokens = {};
    for (const role of roles) {
      const [user] = await db.execute(
        "INSERT INTO users(name,email,password,role,verification_status) VALUES (?,?,?,?,'approved')",
        [role, `${role}@example.test`, "test", role],
      );
      tokens[role] = jwt.sign({ userId: user.insertId, role }, JWT_SECRET);
    }
    const [otherProfessor] = await db.execute(
      "INSERT INTO users(name,email,password,role,verification_status) VALUES ('Other Professor','other@example.test','test','professor','approved')",
    );
    tokens.other_professor = jwt.sign(
      { userId: otherProfessor.insertId, role: "professor" },
      JWT_SECRET,
    );

    // Exercise the route stack and multipart parser without opening a socket.
    const request = async (role, path, method = "GET", body) => {
      const url = new URL("/" + path.replace(/^\//, ""), "http://localhost");
      const headers = { authorization: `Bearer ${tokens[role]}` };
      let bytes;
      if (body instanceof FormData) {
        const multipart = new Request(url, { method, body });
        bytes = Buffer.from(await multipart.arrayBuffer());
        headers["content-type"] = multipart.headers.get("content-type");
        headers["content-length"] = String(bytes.length);
      }
      const req = Object.assign(Readable.from(bytes ? [bytes] : []), {
        url: url.pathname + url.search,
        method,
        headers,
        query: Object.fromEntries(url.searchParams),
        body: bytes ? undefined : body,
      });
      return new Promise((resolve, reject) => {
        const res = {
          statusCode: 200,
          status(code) {
            this.statusCode = code;
            return this;
          },
          set() {
            return this;
          },
          json(data) {
            resolve({ status: this.statusCode, data });
          },
          sendFile(path) {
            fs.readFile(path).then((bytes) => this.json(bytes), reject);
          },
        };
        catalogRoutes(req, res, (error) =>
          reject(error ?? new Error(`No route for ${method} ${path}`)),
        );
      });
    };
    function syllabus(filename) {
      const form = new FormData();
      const bytes = makePdf(
        "Cavite State University\nCOURSE SYLLABUS\nCourse Code: DCIT 24\nCourse Title: Information Management",
      );
      form.append(
        "file",
        new Blob([bytes], { type: "application/pdf" }),
        filename,
      );
      return form;
    }

    assert.equal(
      (
        await request(
          "super_admin",
          "/uploads",
          "POST",
          syllabus("blocked.pdf"),
        )
      ).status,
      403,
    );
    assert.equal((await request("super_admin", "", "POST", {})).status, 403);
    const uploaded = await request(
      "admin",
      "/uploads",
      "POST",
      syllabus("admin.pdf"),
    );
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    const review = {
      uploadId: uploaded.data.uploadId,
      coverage_modules: [{ title: "Introduction to Database" }],
    };
    assert.equal(
      (await request("admin", "", "POST", { ...review, activate: true }))
        .status,
      403,
    );
    const submitted = await request("admin", "", "POST", review);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
    const { catalogId, versionId } = submitted.data;
    const path = "/" + catalogId;
    const activate = { action: "activate" };
    assert.equal((await request("admin", path, "PATCH", activate)).status, 403);
    assert.equal(
      (await request("professor", path, "PATCH", activate)).status,
      403,
    );
    for (const action of ["edit", "approve", "reject"]) {
      assert.equal((await request("super_admin", path, "PATCH", { action })).status, 400);
    }
    assert.equal(
      (await request("professor", "/active")).data.courses.length,
      0,
    );

    const initial = await request("super_admin", "/syllabi?view=activation&status=inactive");
    assert.equal(initial.data.records[0].status, "inactive");
    assert.equal(initial.data.summary.inactive, 1);
    for (const role of ["admin", "professor"]) {
      for (const action of ["activate", "deactivate"]) {
        assert.equal((await request(role, path, "PATCH", { action })).status, 403);
      }
    }
    assert.equal(mail.length, 0);
    const activated = await request("super_admin", path, "PATCH", activate);
    assert.deepEqual(activated.data, {
      success: true,
      status: "active",
      changed: true,
      notification: "sent",
    });
    const repeated = await request("super_admin", path, "PATCH", activate);
    assert.equal(repeated.data.changed, false);
    assert.equal(mail.length, 1, "repeated activation does not send another email");
    assert.equal(
      (await request("professor", "/active")).data.courses.length,
      1,
    );
    const {
      rows: [job],
    } = await engine.query("SELECT version_id FROM catalog_lesson_jobs");
    assert.equal(job.version_id, versionId);
    assert.match(mail[0].text, /now active and available in catalog selection/);
    assert.doesNotMatch(mail[0].text, /approved|rejected/);
    const [[activationRecord]] = await db.query("SELECT reviewed_by,reviewed_at FROM course_catalog WHERE catalog_id=?", [catalogId]);

    await db.execute(
      "INSERT INTO courses (title,code,summary,subject,catalog_id,syllabus_version_id) VALUES ('Existing class','CLASS-1','','Database',?,?)",
      [catalogId, versionId],
    );
    const deactivated = await request("super_admin", path, "PATCH", {
      action: "deactivate",
    });
    assert.deepEqual(deactivated.data, {
      success: true,
      status: "inactive",
      changed: true,
      notification: "sent",
    });
    const [[afterDeactivation]] = await db.query("SELECT reviewed_by,reviewed_at FROM course_catalog WHERE catalog_id=?", [catalogId]);
    assert.equal(afterDeactivation.reviewed_by, activationRecord.reviewed_by);
    assert.ok(afterDeactivation.reviewed_at >= activationRecord.reviewed_at);
    assert.match(mail[1].text, /inactive and hidden from catalog selection/);
    assert.equal(
      (await request("professor", "/active")).data.courses.length,
      0,
    );
    const {
      rows: [existingClass],
    } = await engine.query("SELECT archived FROM courses WHERE code='CLASS-1'");
    assert.equal(existingClass.archived, 0);
    assert.equal(
      (await request("super_admin", "?status=inactive")).data.records[0]
        .catalog_id,
      catalogId,
    );

    const next = await request(
      "professor",
      "/uploads",
      "POST",
      syllabus("professor.pdf"),
    );
    assert.equal(next.status, 201, JSON.stringify(next.data));
    assert.equal(next.data.matches[0].catalog_id, catalogId);
    const preview = `/uploads/${next.data.uploadId}/pdf`;
    assert.equal((await request("professor", preview)).status, 200);
    assert.equal((await request("admin", preview)).status, 404);
    const attached = await request("professor", "", "POST", {
      ...review,
      uploadId: next.data.uploadId,
      catalogId,
    });
    assert.equal(attached.status, 201, JSON.stringify(attached.data));
    assert.equal(attached.data.generationQueued, false);
    assert.equal(
      (await request("super_admin", path, "PATCH", activate)).data.notification,
      "sent",
    );
    assert.deepEqual(
      mail.map((message) => [message.to.address, message.subject]),
      [
        [
          "admin@example.test",
          "PuffyBrain course status: DCIT 24 is now active",
        ],
        [
          "admin@example.test",
          "PuffyBrain course status: DCIT 24 is now inactive",
        ],
        [
          "professor@example.test",
          "PuffyBrain course status: DCIT 24 is now active",
        ],
      ],
    );
    assert.match(mail[2].text, /professor\.pdf/);

    const thirdUpload = await request(
      "professor",
      "/uploads",
      "POST",
      syllabus("updated-professor.pdf"),
    );
    const replacement = await request("professor", "", "POST", {
      ...review,
      uploadId: thirdUpload.data.uploadId,
      catalogId,
      reviewed: true,
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
    assert.equal(replacement.data.generationQueued, false);
    assert.equal(
      (await request("professor", "/active")).data.courses.length,
      0,
    );
    await assert.rejects(
      resolveClassCatalog(db, { catalogId }),
      /no longer available/,
    );

    assert.equal((await request("student", "/syllabi")).status, 403);
    assert.equal((await request("student", "/syllabi/" + replacement.data.versionId)).status, 403);
    const pending = await request("super_admin", "/syllabi?view=activation&status=inactive");
    assert.equal(pending.status, 200, JSON.stringify(pending.data));
    assert.equal(pending.data.records.length, 1);
    assert.equal(
      pending.data.records[0].version_id,
      replacement.data.versionId,
    );
    assert.equal(pending.data.summary.inactive, 1);
    assert.equal(pending.data.records[0].status, "inactive");
    assert.equal((await request("other_professor", "/syllabi")).data.total, 0);
    assert.equal(
      (await request("other_professor", "/syllabi?view=history")).data.total,
      0,
    );
    assert.equal(
      (await request("professor", "/syllabi?view=history")).data.total,
      2,
    );
    assert.equal(
      (await request("admin", "/syllabi?view=history")).data.total,
      3,
    );
    assert.equal(
      (await request("admin", "/syllabi?view=history&pageSize=1&page=2")).data
        .records[0].filename,
      "professor.pdf",
    );
    assert.equal(
      (await request("admin", "/syllabi?q=updated-professor")).data.total,
      1,
    );
    assert.equal((await request("admin", "/syllabi?q=missing")).data.total, 0);
    const detail = await request(
      "professor",
      "/syllabi/" + replacement.data.versionId,
    );
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(
      detail.data.syllabus.coverage_modules[0].title,
      "Introduction to Database",
    );
    assert.equal(
      (
        await request(
          "other_professor",
          "/syllabi/" + replacement.data.versionId,
        )
      ).status,
      404,
    );
    assert.equal(
      (await request("professor", "/syllabi/" + versionId)).status,
      404,
    );

    const stale = await request("super_admin", path, "PATCH", {
      ...activate,
      versionId,
    });
    assert.equal(stale.status, 409);
    assert.equal(mail.length, 3);
    const latestActivated = await request("super_admin", path, "PATCH", {
      action: "activate",
      versionId: replacement.data.versionId,
    });
    assert.equal(latestActivated.data.changed, true);
    assert.equal(latestActivated.data.notification, "sent");
    assert.equal(latestActivated.data.status, "active");
    assert.doesNotMatch(mail[3].text, /approved|rejected/);
    assert.equal((await request("professor", "/syllabi?status=inactive")).data.total, 0);
    assert.equal((await request("professor", "/active")).data.courses.length, 1);
    const correctedUpload = await request("professor", "/uploads", "POST", syllabus("corrected-professor.pdf"));
    const corrected = await request("professor", "", "POST", {
      ...review, uploadId: correctedUpload.data.uploadId, catalogId, reviewed: true,
    });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.data));
    assert.equal((await request("super_admin", "/syllabi?view=activation&status=inactive")).data.total, 1);
    assert.equal(
      (
        await request("super_admin", path, "PATCH", {
          ...activate,
          versionId: corrected.data.versionId,
        })
      ).data.notification,
      "sent",
    );
    assert.equal(
      (await request("professor", "/active")).data.courses.length,
      1,
    );
    assert.equal(mail.length, 5);
    assert.equal(mail[4].to.address, "professor@example.test");
    assert.match(mail[4].text, /corrected-professor\.pdf/);
    // Reactivation uses the same direct action without a separate decision.
    await request("super_admin", path, "PATCH", { action: "deactivate" });
    const reactivated = await request("super_admin", path, "PATCH", activate);
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.data));
    assert.equal(reactivated.data.status, "active");

    // Existing statuses from the older workflow remain usable without migrating data.
    for (const legacyStatus of ["draft", "rejected"]) {
      await db.execute("UPDATE course_catalog SET status=? WHERE catalog_id=?", [legacyStatus, catalogId]);
      const legacyList = await request("super_admin", "/syllabi?status=inactive");
      assert.equal(legacyList.data.total, 1);
      assert.equal(legacyList.data.summary.inactive, 1);
      assert.equal(legacyList.data.records[0].status, "inactive");
      const catalogList = await request("super_admin", "?status=inactive");
      assert.equal(catalogList.data.records[0].status, "inactive");
      assert.equal((await request("professor", "/active")).data.courses.length, 0);
      const restored = await request("super_admin", path, "PATCH", activate);
      assert.equal(restored.status, 200, JSON.stringify(restored.data));
      assert.equal(restored.data.status, "active");
      assert.equal((await request("professor", "/active")).data.courses.length, 1);
    }
  },
);
