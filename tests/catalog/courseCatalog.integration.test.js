// Uses an isolated, disposable schema. Copies table definitions only; never copies application data.
import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import express from "express";
import fs from "node:fs/promises";
dotenv.config({ quiet: true });

function pdf(lines) {
  const content =
    "BT /F1 11 Tf 30 750 Td " +
    lines
      .map(
        (line, i) =>
          (i ? "0 -18 Td " : "") +
          "(" +
          line.replace(/[()\\]/g, "\\$&") +
          ") Tj",
      )
      .join("\n") +
    " ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let data = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data +=
    `xref\n0 6\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
test(
  "catalog lifecycle, authorization, versions and existing professor classes",
  { timeout: 120000 },
  async (t) => {
    const schema = "puffy_catalog_test_" + process.pid,
      source = process.env.DB_NAME || "puffybrain";
    const bootstrap = await mysql.createConnection({
      host: process.env.DB_HOST || "127.0.0.1",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
    });
    let db, server;
    const createdFiles = [];
    try {
      await bootstrap.query("CREATE DATABASE ??", [schema]);
      await bootstrap.query("USE ??", [schema]);
      await bootstrap.query("SET FOREIGN_KEY_CHECKS=0");
      for (const name of [
        "users",
        "courses",
        "learning_modules",
        "course_enrollments",
        "audit_logs",
        "notifications",
      ]) {
        const [[row]] = await bootstrap.query("SHOW CREATE TABLE ??.??", [
          source,
          name,
        ]);
        await bootstrap.query(row["Create Table"]);
      }
      await bootstrap.query("SET FOREIGN_KEY_CHECKS=1");
      process.env.DB_NAME = schema;
      ({ db } = await import("../../src/db.js"));
      const { migrateCourseCatalog } =
        await import("../../src/migrations/courseCatalogMigration.js");
      await migrateCourseCatalog(db);
      await migrateCourseCatalog(db);
      await db.query(
        "INSERT INTO users (userId,name,email,password,role,verification_status) VALUES (1,'Admin','admin@test.invalid','x','admin','approved'),(2,'Super','super@test.invalid','x','super_admin','approved'),(3,'Professor','prof@test.invalid','x','professor','approved'),(4,'Other Professor','other@test.invalid','x','professor','approved'),(5,'Student','student@test.invalid','x','student','approved')",
      );
      await db.query(
        "INSERT INTO courses (title,code,summary,subject,professor_id) VALUES ('Legacy Class','LEGACY-JOIN','Old summary','Legacy',3)",
      );
      const { default: catalog } =
        await import("../../src/routes/catalogRoutes.js");
      const { default: courseRoutes } =
        await import("../../src/routes/courseRoutes.js");
      const app = express();
      app.use(express.json());
      app.use("/api/catalog", catalog);
      app.use("/api", courseRoutes);
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const token = (id) =>
        jwt.sign({ userId: id }, process.env.JWT_SECRET || "puffybrain-secret");
      const request = async (path, { user = 1, method = "GET", body } = {}) => {
        const headers = user ? { Authorization: "Bearer " + token(user) } : {};
        if (body && !(body instanceof FormData))
          headers["Content-Type"] = "application/json";
        const response = await fetch(base + path, {
          method,
          headers,
          body:
            body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
        });
        const data = response.headers
          .get("content-type")
          ?.includes("application/json")
          ? await response.json()
          : await response.arrayBuffer();
        return { status: response.status, data };
      };
      const upload = async (
        bytes = pdf([
          "Course Code: GNED 08",
          "Course Title: Understanding the Self",
          "Course Description: Self awareness",
          "Credit Units: 3",
          "Programs: BSIT BSCS",
          "Academic Year: 2026-2027",
          "Semester: First",
        ]),
      ) => {
        const body = new FormData();
        body.append(
          "file",
          new Blob([bytes], { type: "application/pdf" }),
          "syllabus.pdf",
        );
        const result = await request("/catalog/uploads", {
          method: "POST",
          body,
        });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        return result.data;
      };
      let activeId, version1, version2, draftId, class1, blankUpload;
      await t.test(
        "Admin uploads readable text, reviews and activates; no activation without review",
        async () => {
          const file = await upload();
          assert.equal(file.suggestions.code, "GNED 08");
          assert.equal(file.suggestions.title, "Understanding the Self");
          assert.equal(
            (await request("/catalog/uploads/" + file.uploadId + "/pdf"))
              .status,
            200,
          );
          assert.equal(
            (
              await request("/catalog/uploads/" + file.uploadId + "/pdf", {
                user: 3,
              })
            ).status,
            403,
          );
          const reextracted = await request(
            "/catalog/uploads/" + file.uploadId + "/extract",
            { method: "POST" },
          );
          assert.equal(reextracted.status, 200);
          assert.equal(reextracted.data.suggestions.code, "GNED 08");
          assert.equal(
            (
              await request("/catalog/uploads/" + file.uploadId + "/extract", {
                user: 3,
                method: "POST",
              })
            ).status,
            403,
          );
          const body = {
            ...file.suggestions,
            coverage_modules: [
              { title: "Reviewed outline title", source_page: 1 },
            ],
            uploadId: file.uploadId,
            activate: true,
          };
          assert.equal(
            (await request("/catalog", { method: "POST", body })).status,
            400,
          );
          const result = await request("/catalog", {
            method: "POST",
            body: { ...body, reviewed: true },
          });
          assert.equal(result.status, 201, JSON.stringify(result.data));
          activeId = result.data.catalogId;
          version1 = result.data.versionId;
          const detail = await request("/catalog/" + activeId);
          const raw = detail.data.versions[0].coverage_modules;
          assert.deepEqual(typeof raw === "string" ? JSON.parse(raw) : raw, [
            { title: "Reviewed outline title", source_page: 1 },
          ]);
        },
      );
      await t.test("activation queues module lessons and worker saves reusable catalog drafts",async()=>{
        const [[job]] = await db.query("SELECT * FROM catalog_lesson_jobs WHERE version_id=?",[version1]);
        assert.equal(job.status,"queued");
        const {runCatalogLessons}=await import("../../src/services/catalog/catalogLessonGeneration.js");
        await runCatalogLessons(db,async request=>({
          description:"Generated draft",learning_objectives:"Understand the module",topics:[request.data.module_title],
          lesson_pages:[{title:"Introduction",content:"Draft explanation for professor review."}],
          quiz_items: Array.from({ length: 5 }, (_, i) => ({
            question: `Practice question ${i + 1}`,
            type: "multiple_choice",
            options: ["A", "B", "C", "D"],
            correct_answer: "A",
            explanation: "Explanation based on the draft lesson.",
          })),
        }));
        const detail = await request("/catalog/"+activeId);
        assert.equal(detail.data.versions[0].generation_status,"completed");
        const raw=detail.data.versions[0].coverage_modules;
        const modules=typeof raw === "string" ? JSON.parse(raw) : raw;
        assert.equal(modules[0].lesson_pages.length,1);
        assert.equal(modules[0].generated_draft,true);
      });
      await t.test(
        "draft does not appear in professor dropdown and rejects forged class creation",
        async () => {
          const file = await upload();
          const result = await request("/catalog", {
            method: "POST",
            body: {
              ...file.suggestions,
              code: "CS 101",
              uploadId: file.uploadId,
            },
          });
          assert.equal(result.status, 201);
          draftId = result.data.catalogId;
          const list = await request("/catalog/active", { user: 3 });
          assert.deepEqual(
            list.data.courses.map((c) => c.catalog_id),
            [activeId],
          );
          assert.equal(
            (
              await request("/courses", {
                user: 3,
                method: "POST",
                body: { catalogId: draftId, title: "Forged", status: "draft" },
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        "active catalog produces independent classes, official values and pinned syllabus",
        async () => {
          const body = {
            catalogId: activeId,
            syllabusVersionId: version1,
            title: "FORGED TITLE",
            code: "FORGED",
            status: "draft",
            academicYear: "2027-2028",
            semester: "Second",
            className: "IT 1A",
          };
          const first = await request("/courses", {
            user: 3,
            method: "POST",
            body,
          });
          assert.equal(first.status, 201, JSON.stringify(first.data));
          class1 = first.data.course;
          assert.equal(class1.title, "Understanding the Self");
          assert.equal(class1.catalogCode, "GNED 08");
          assert.equal(class1.syllabusVersionId, version1);
          assert.equal(class1.academicYear, "2027-2028");
          const second = await request("/courses", {
            user: 4,
            method: "POST",
            body,
          });
          assert.equal(second.status, 201);
          assert.notEqual(second.data.course.id, class1.id);
          assert.notEqual(second.data.course.code, class1.code);
          assert.equal(
            (
              await request("/courses", {
                user: 3,
                method: "POST",
                body: {
                  ...body,
                  catalogId: draftId,
                  syllabusVersionId: version1,
                },
              })
            ).status,
            400,
          );
        },
      );
      await t.test(
        "empty and populated modules survive save, edit, reload and intentional removal",
        async () => {
          const modules = [
            {
              id: "shell-one",
              title: "First coverage module",
              lessonPages: [],
              quizItems: [],
              mainQuizSettings: { enabled: false },
            },
            {
              id: "shell-two",
              title: "Second coverage module",
              lessonPages: [],
              quizItems: [],
              mainQuizSettings: { enabled: false },
            },
          ];
          const created = await request("/courses", {
            user: 3,
            method: "POST",
            body: {
              catalogId: activeId,
              syllabusVersionId: version1,
              status: "draft",
              contentModules: modules,
            },
          });
          assert.equal(created.status, 201, JSON.stringify(created.data));
          const id = created.data.course.id;
          let loaded = (await request("/courses/" + id, { user: 3 })).data
            .course;
          assert.deepEqual(
            loaded.contentModules.map((m) => m.title),
            ["First coverage module", "Second coverage module"],
          );
          loaded.contentModules[0].title = "Edited title";
          loaded.contentModules[1].lessonPages = [
            {
              id: "page-one",
              title: "Saved lesson",
              content: "Professor content",
            },
          ];
          let updated = await request("/courses/" + id, {
            user: 3,
            method: "PUT",
            body: loaded,
          });
          assert.equal(updated.status, 200, JSON.stringify(updated.data));
          loaded = (await request("/courses/" + id, { user: 3 })).data.course;
          assert.equal(loaded.contentModules.length, 2);
          assert.equal(loaded.contentModules[0].title, "Edited title");
          assert.equal(
            loaded.contentModules[1].lessonPages[0].content,
            "Professor content",
          );
          loaded.contentModules = loaded.contentModules.slice(0, 1);
          loaded.lessonPages = [];
          loaded.lessonContent = "[]";
          loaded.lesson_content = "[]";
          updated = await request("/courses/" + id, {
            user: 3,
            method: "PUT",
            body: loaded,
          });
          assert.equal(updated.status, 200);
          loaded = (await request("/courses/" + id, { user: 3 })).data.course;
          assert.deepEqual(
            loaded.contentModules.map((m) => m.title),
            ["Edited title"],
          );
        },
      );
      await t.test(
        "unreadable PDF retains preview and permits honest manual completion",
        async () => {
          blankUpload = await upload(pdf([]));
          assert.match(blankUpload.extractionMessage, /unsuccessful/);
          assert.equal(blankUpload.suggestions.code, "");
          assert.equal(blankUpload.suggestions.title, "");
          assert.equal(
            (await request("/catalog/uploads/" + blankUpload.uploadId + "/pdf"))
              .status,
            200,
          );
          assert.equal(
            (
              await request("/catalog", {
                method: "POST",
                body: {
                  code: "MATH 1",
                  title: "Manual title",
                  uploadId: blankUpload.uploadId,
                },
              })
            ).status,
            201,
          );
        },
      );
      await t.test(
        "duplicate detection is normalized, explicit attachment appends version and leaves class pinned",
        async () => {
          const file = await upload();
          assert.equal(file.matches[0].catalog_id, activeId);
          const duplicate = await request("/catalog", {
            method: "POST",
            body: {
              ...file.suggestions,
              code: "gned08",
              uploadId: file.uploadId,
            },
          });
          assert.equal(duplicate.status, 409);
          assert.equal(duplicate.data.matches[0].catalog_id, activeId);
          const appended = await request("/catalog", {
            method: "POST",
            body: {
              catalogId: activeId,
              uploadId: file.uploadId,
              academic_year: "2028-2029",
              semester: "First",
              reviewed: true,
            },
          });
          assert.equal(appended.status, 201);
          version2 = appended.data.versionId;
          const detail = await request("/catalog/" + activeId);
          assert.equal(detail.data.versions.length, 2);
          const [[row]] = await db.query(
            "SELECT syllabus_version_id FROM courses WHERE course_id=?",
            [class1.id],
          );
          assert.equal(row.syllabus_version_id, version1);
        },
      );
      await t.test(
        "archival archives professor classes, notifies owners and preserves content",
        async () => {
          await db.query(
            "INSERT INTO course_enrollments (course_id,user_id,status) VALUES (?,5,'approved')",
            [class1.id],
          );
          await db.query(
            "INSERT INTO learning_modules (course_id,title,description,subject) VALUES (?,'Saved module','Text','Subject')",
            [class1.id],
          );
          assert.equal(
            (
              await request("/catalog/" + activeId, {
                method: "PATCH",
                body: { action: "archive" },
              })
            ).status,
            200,
          );
          assert.equal(
            (await request("/catalog/active", { user: 3 })).data.courses.length,
            0,
          );
          const [[archivedClass]] = await db.query("SELECT archived FROM courses WHERE course_id=?", [class1.id]);
          assert.equal(archivedClass.archived, 1);
          const [notices] = await db.query("SELECT * FROM notifications WHERE course_id=? AND type='course_archived'", [class1.id]);
          assert.equal(notices.length, 1);
          assert.equal(notices[0].recipient_user_id, 3);
          const [[catalogCourse]] = await db.query("SELECT code FROM course_catalog WHERE catalog_id=?", [activeId]);
          assert.ok(notices[0].message.includes(`The ${catalogCourse.code} course was archived by the admin.`));
          assert.ok(!notices[0].message.includes(class1.code));
          await request("/catalog/" + activeId, {method: "PATCH", body: {action: "archive"}});
          const [[noticeCount]] = await db.query("SELECT COUNT(*) AS total FROM notifications WHERE course_id=? AND type='course_archived'", [class1.id]);
          assert.equal(noticeCount.total, 1);
          const { reconcileArchivedCatalogClasses } = await import("../../src/services/catalog/catalogArchive.js");
          await db.query("UPDATE courses SET archived=0 WHERE course_id=?", [class1.id]);
          await reconcileArchivedCatalogClasses(db);
          await reconcileArchivedCatalogClasses(db);
          const [[reconciled]] = await db.query("SELECT archived FROM courses WHERE course_id=?", [class1.id]);
          assert.equal(reconciled.archived, 1);
          const [[reconciledNotices]] = await db.query("SELECT COUNT(*) AS total FROM notifications WHERE course_id=? AND type='course_archived'", [class1.id]);
          assert.equal(reconciledNotices.total, 2);
          assert.equal((await request("/courses/" + class1.id + "/archive", {user: 3, method: "PATCH", body: {archived: false}})).status, 409);
          assert.equal(
            (
              await request("/courses", {
                user: 3,
                method: "POST",
                body: { catalogId: activeId, title: "X" },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request("/catalog/versions/" + version1 + "/pdf", {
                user: 3,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/catalog/versions/" + version2 + "/pdf", {
                user: 3,
              })
            ).status,
            403,
          );
          const updated = await request("/courses/" + class1.id, {
            user: 3,
            method: "PUT",
            body: {
              ...class1,
              title: "Tampered",
              className: "Updated section",
            },
          });
          assert.equal(updated.status, 200, JSON.stringify(updated.data));
          assert.equal(updated.data.course.title, "Understanding the Self");
          const [[count]] = await db.query(
            "SELECT COUNT(*) AS count FROM learning_modules WHERE course_id=?",
            [class1.id],
          );
          assert.equal(Number(count.count), 1);
          const linked = await request(
            "/catalog/classes?catalogId=" + activeId,
          );
          assert.equal(
            linked.data.records.find((r) => r.course_id === class1.id)
              .student_count,
            1,
          );
        },
      );
      await t.test(
        "restore retains active and draft state independently",
        async () => {
          for (const [id, status] of [
            [activeId, "active"],
            [draftId, "draft"],
          ]) {
            await request("/catalog/" + id, {
              method: "PATCH",
              body: { action: "archive" },
            });
            assert.equal(
              (
                await request("/catalog/" + id, {
                  method: "PATCH",
                  body: { action: "restore" },
                })
              ).status,
              200,
            );
            assert.equal(
              (await request("/catalog/" + id)).data.course.status,
              status,
            );
          }
        },
      );
      await t.test("archived code is excluded from lookup and upload matches and can be reused", async () => {
        const patch = (id, action) => request("/catalog/" + id, { method: "PATCH", body: { action } });
        assert.equal((await patch(activeId, "archive")).status, 200);
        const matches = await request("/catalog?normalizedCode=GNED08");
        assert.equal(matches.data.records.length, 0);
        const file = await upload();
        assert.equal(file.matches.length, 0);
        const result = await request("/catalog", { method: "POST", body: {
          ...file.suggestions, uploadId: file.uploadId,
        } });
        assert.equal(result.status, 201, JSON.stringify(result.data));
        assert.notEqual(result.data.catalogId, activeId);
        const restore = await patch(activeId, "restore");
        assert.equal(restore.status, 409);
        assert.match(restore.data.message, /Cannot restore/);
        assert.equal((await patch(result.data.catalogId, "archive")).status, 200);
        assert.equal((await patch(activeId, "restore")).status, 200);
      });
      await t.test("restoring with a syllabus is reviewed and atomic and keeps the original course", async () => {
        await request("/catalog/" + activeId, {method:"PATCH",body:{action:"archive"}});
        const file = await upload();
        const body = {catalogId:activeId, uploadId:file.uploadId, restoreArchived:true};
        assert.equal((await request("/catalog", {method:"POST",body})).status,400);
        assert.equal((await request("/catalog", {method:"POST",body:{...body, reviewed:true, uploadId:"missing"}})).status,400);
        let detail = await request("/catalog/" + activeId);
        assert.ok(detail.data.course.archived_at);
        const count = detail.data.versions.length;
        const saved = await request("/catalog", {method:"POST",body:{...body,reviewed:true}});
        assert.equal(saved.status,201,JSON.stringify(saved.data));
        assert.equal(saved.data.catalogId,activeId);
        detail = await request("/catalog/" + activeId);
        assert.equal(detail.data.course.archived_at,null);
        assert.equal(detail.data.versions.length,count+1);
      });
      await t.test(
        "Admin cannot read full activity; Super Admin can; PDFs and mutations require authorization",
        async () => {
          assert.equal((await request("/catalog/activity")).status, 403);
          const history = await request("/catalog/activity", { user: 2 });
          assert.equal(history.status, 200);
          assert.ok(history.data.total >= 10);
          assert.equal((await request("/catalog", { user: 3 })).status, 403);
          assert.equal(
            (
              await request("/catalog/versions/" + version1 + "/pdf", {
                user: 5,
              })
            ).status,
            403,
          );
          assert.equal(
            (await request("/catalog/summary", { user: null })).status,
            401,
          );
        },
      );
      await t.test(
        "existing unlinked classes safely load through authorized Admin view",
        async () => {
          const list = await request("/catalog/classes");
          const legacy = list.data.records.find(
            (r) => r.code === "LEGACY-JOIN",
          );
          assert.ok(legacy);
          assert.equal(legacy.catalog_id, null);
          const detail = await request("/catalog/classes/" + legacy.course_id);
          assert.equal(detail.status, 200);
          assert.equal(detail.data.course.catalogId, null);
          assert.equal(
            (await request("/catalog/classes/" + legacy.course_id, { user: 3 }))
              .status,
            403,
          );
        },
      );
      await t.test(
        "invalid PDF signatures are rejected; temporary upload can be discarded",
        async () => {
          const body = new FormData();
          body.append(
            "file",
            new Blob(["not pdf"], { type: "application/pdf" }),
            "fake.pdf",
          );
          assert.equal(
            (await request("/catalog/uploads", { method: "POST", body }))
              .status,
            400,
          );
          const file = await upload();
          assert.equal(
            (
              await request("/catalog/uploads/" + file.uploadId, {
                method: "DELETE",
              })
            ).status,
            200,
          );
          assert.equal(
            (await request("/catalog/uploads/" + file.uploadId + "/pdf"))
              .status,
            404,
          );
        },
      );
      const [files] = await db.query(
        "SELECT storage_name FROM syllabus_versions UNION SELECT storage_name FROM syllabus_uploads",
      );
      createdFiles.push(...files.map((row) => row.storage_name));
    } finally {
      if (db) {
        const [files] = await db
          .query(
            "SELECT storage_name FROM syllabus_versions UNION SELECT storage_name FROM syllabus_uploads",
          )
          .catch(() => [[]]);
        createdFiles.push(...files.map((row) => row.storage_name));
        await db.end();
      }
      if (server) await new Promise((resolve) => server.close(resolve));
      for (const name of new Set(createdFiles))
        await fs
          .unlink(new URL("../../src/private/syllabi/" + name, import.meta.url))
          .catch(() => {});
      await bootstrap.query("DROP DATABASE IF EXISTS ??", [schema]);
      await bootstrap.end();
    }
  },
);
