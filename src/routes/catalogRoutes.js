import { queueCatalogLessons } from "../services/catalog/catalogLessonGeneration.js";
import { archiveCatalogClasses } from "../services/catalog/catalogArchive.js";
import { getCourseById } from "../controllers/courseController.js";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { sendCatalogCourseArchivedEmail } from "../utils/mailer.js";
import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import { extractSyllabus } from "../services/catalog/syllabusExtraction.js";
import {
  syllabusDirectory as directory,
  syllabusFilePath as filePath,
} from "../services/catalog/syllabusStorage.js";
import { validateCoverageModules } from "../services/catalog/catalogRules.js";
import {
  catalogDetails,
  normalizeCatalogCode,
  parseSyllabus,
} from "../services/catalog/catalogRules.js";
import { getRequestIp } from "../services/system/auditLogService.js";

const router = express.Router();
const admin = requireRole("admin", "super_admin");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter(_req, file, cb) {
    if (
      path.extname(file.originalname).toLowerCase() !== ".pdf" ||
      file.mimetype !== "application/pdf"
    )
      return cb(
        Object.assign(new Error("Only PDF files are allowed."), {
          statusCode: 400,
        }),
      );
    cb(null, true);
  },
});
const run = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const actor = (req) => req.user.userId;
const actorRoleOf = (req) => {
  const role = String(req.user?.role || "admin")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return role === "superadmin" ? "super_admin" : role;
};
const programs = (value) =>
  Array.isArray(value) ? value : JSON.parse(value || "[]");
const present = (row) => {
  const { normalized_code, available_normalized_code, ...rest } = row;
  return { ...rest, programs: programs(row.programs) };
};
const windowFor = (req) => ({
  page: Math.max(1, parseInt(req.query.page) || 1),
  size: Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10)),
});
async function transaction(fn) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
async function audit(connection, req, action, target, changes) {
  // Use the existing audit table on the SAME connection, so the record and history commit together.
  await connection.execute(
    `INSERT INTO audit_logs (user_id,user_name,user_role,category,action,target,ip_address,status,details) VALUES (?,?,?,'Course Catalog',?,?,?,'Success',?)`,
    [
      actor(req),
      req.user.email,
      req.user.role,
      action,
      String(target),
      getRequestIp(req),
      JSON.stringify(changes),
    ],
  );
}
export async function cleanupSyllabusUploads() {
  // Keep rows until unlink succeeds, allowing retries after filesystem failures.
  const [rows] = await db.query(
    "SELECT upload_id,storage_name FROM syllabus_uploads WHERE expires_at < NOW()",
  );
  for (const row of rows) {
    await fs.unlink(filePath(row.storage_name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await db.execute(
      "DELETE FROM syllabus_uploads WHERE upload_id=? AND expires_at < NOW()",
      [row.upload_id],
    );
  }
  await fs.mkdir(directory, { recursive: true });
  // Recover files left by a process crash between filesystem write and DB insert.
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{36}\.pdf$/.test(name)) continue;
    const stat = await fs.stat(filePath(name));
    if (Date.now() - stat.mtimeMs < 86400000) continue;
    const [[row]] = await db.execute(
      "SELECT (SELECT COUNT(*) FROM syllabus_uploads WHERE storage_name=?) + (SELECT COUNT(*) FROM syllabus_versions WHERE storage_name=?) AS refs",
      [name, name],
    );
    if (!Number(row.refs)) await fs.unlink(filePath(name));
  }
}

async function analyzeFile(storageName) {
  let suggestions = { ...parseSyllabus(""), coverage_modules: [] },
    extractionMessage = "";
  try {
    suggestions = await extractSyllabus(filePath(storageName));
    const missing = [
      !suggestions.code && "course code",
      !suggestions.title && "course title",
      !suggestions.coverage_modules.length && "Course Coverage headings",
    ].filter(Boolean);
    if (missing.length)
      extractionMessage =
        "Could not detect " +
        missing.join(", ") +
        ". Review and complete these fields manually. No OCR was performed.";
    else
      extractionMessage =
        "Course details and Course Coverage headings were detected. Review them before saving.";
  } catch {
    extractionMessage =
      "Automatic extraction was unsuccessful. This PDF may be scanned or unreadable. Complete the fields manually. No OCR was performed.";
  }
  return { suggestions, extractionMessage };
}
router.post(
  "/uploads/:id/extract",
  authenticateUser,
  admin,
  run(async (req, res) => {
    const [[row]] = await db.execute(
      "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? AND expires_at>NOW()",
      [req.params.id, actor(req)],
    );
    if (!row) fail("Upload expired or not found.", 404);
    const data = await analyzeFile(row.storage_name);
    const [matches] = data.suggestions.code
      ? await db.execute(
          "SELECT * FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL",
          [normalizeCatalogCode(data.suggestions.code)],
        )
      : [[]];
    res.json({ success: true, ...data, matches: matches.map(present) });
  }),
);
router.use(authenticateUser);
router.get(
  "/active",
  requireRole("professor", "admin", "super_admin"),
  run(async (req, res) => {
    const q = String(req.query.q || "").slice(0, 255);
    const [rows] = await db.execute(
      "SELECT * FROM course_catalog WHERE status='active' AND archived_at IS NULL AND (code LIKE ? OR title LIKE ?) ORDER BY code",
      ["%" + q + "%", "%" + q + "%"],
    );
    const [versions] = await db.query(
      "SELECT v.version_id,v.catalog_id,v.academic_year,v.semester,v.filename,v.uploaded_at,v.coverage_modules,(SELECT status FROM catalog_lesson_jobs j WHERE j.version_id=v.version_id) AS generation_status FROM syllabus_versions v JOIN course_catalog c ON c.catalog_id=v.catalog_id WHERE c.status='active' AND c.archived_at IS NULL ORDER BY v.version_id DESC",
    );
    res.json({
      success: true,
      courses: rows.map((row) => ({
        ...present(row),
        versions: versions.filter((v) => v.catalog_id === row.catalog_id),
      })),
    });
  }),
);
router.get(
  "/versions/:id/pdf",
  requireRole("professor", "admin", "super_admin"),
  run(async (req, res) => {
    const [[version]] = await db.execute(
      "SELECT v.*,c.status,c.archived_at FROM syllabus_versions v JOIN course_catalog c ON c.catalog_id=v.catalog_id WHERE v.version_id=?",
      [req.params.id],
    );
    if (!version) fail("Syllabus not found.", 404);
    if (
      req.user.role === "professor" &&
      (version.status !== "active" || version.archived_at)
    ) {
      const [[linked]] = await db.execute(
        "SELECT course_id FROM courses WHERE syllabus_version_id=? AND professor_id=? LIMIT 1",
        [version.version_id, actor(req)],
      );
      if (!linked) fail("You cannot access this syllabus.", 403);
    }
    res.set({
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition":
        "inline; filename*=UTF-8''" + encodeURIComponent(version.filename),
    });
    res.sendFile(filePath(version.storage_name));
  }),
);
router.get(
  "/summary",
  admin,
  run(async (_req, res) => {
    const [[summary]] = await db.query(
      `SELECT COUNT(*) AS total,COALESCE(SUM(status='active' AND archived_at IS NULL),0) AS active,COALESCE(SUM(status='draft' AND archived_at IS NULL),0) AS draft,(SELECT COUNT(*) FROM courses WHERE professor_id IS NOT NULL OR COALESCE(professor_email,'') <> '') AS classes FROM course_catalog`,
    );
    res.json({ success: true, summary });
  }),
);
router.get(
  "/activity",
  requireRole("super_admin"),
  run(async (req, res) => {
    const { page, size } = windowFor(req);
    const [[count]] = await db.query(
      "SELECT COUNT(*) AS total FROM audit_logs WHERE category='Course Catalog'",
    );
    const [records] = await db.query(
      "SELECT * FROM audit_logs WHERE category='Course Catalog' ORDER BY audit_id DESC LIMIT ? OFFSET ?",
      [size, (page - 1) * size],
    );
    res.json({ success: true, records, total: Number(count.total), page });
  }),
);
export async function catalogClasses(req, res) {
  const { page, size } = windowFor(req),
    conditions = [
      "(c.professor_id IS NOT NULL OR COALESCE(c.professor_email,'') <> '')",
    ],
    values = [];
  if (req.query.catalogId) {
    conditions.push("c.catalog_id=?");
    values.push(req.query.catalogId);
  }
  if (req.query.q) {
    conditions.push(
      "(c.title LIKE ? OR c.code LIKE ? OR c.catalog_code LIKE ? OR c.class_name LIKE ? OR c.professor_name LIKE ? OR u.name LIKE ?)",
    );
    values.push(
      ...Array(6).fill("%" + String(req.query.q).slice(0, 255) + "%"),
    );
  }
  if (["draft", "published", "archived"].includes(req.query.status)) {
    conditions.push(
      req.query.status === "archived"
        ? "c.archived=1"
        : "c.archived=0 AND c.status=?",
    );
    if (req.query.status !== "archived") values.push(req.query.status);
  }
  const where = " WHERE " + conditions.join(" AND ");
  const [[count]] = await db.execute(
    "SELECT COUNT(*) AS total FROM courses c LEFT JOIN users u ON u.userId=c.professor_id" +
      where,
    values,
  );
  const [records] = await db.query(
    `SELECT c.course_id,c.catalog_id,c.catalog_code,c.title,c.code,c.class_name,c.program,c.year_level,c.section_name,c.academic_year,c.semester,c.status,c.archived,COALESCE(u.display_name,u.name,c.professor_name,c.professor_email) AS professor,(SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id=c.course_id AND e.status='approved' AND e.archived=0) AS student_count FROM courses c LEFT JOIN users u ON u.userId=c.professor_id ${where} ORDER BY c.course_id DESC LIMIT ? OFFSET ?`,
    [...values, size, (page - 1) * size],
  );
  res.json({ success: true, records, total: Number(count.total), page });
}
router.get("/classes", admin, run(catalogClasses));
router.get("/classes/:id", admin, run(getCourseById));
router.post(
  "/uploads",
  admin,
  (req, res, next) =>
    upload.single("file")(req, res, (error) =>
      error ? next(Object.assign(error, { statusCode: 400 })) : next(),
    ),
  run(async (req, res) => {
    if (!req.file || req.file.buffer.subarray(0, 5).toString() !== "%PDF-")
      fail("Choose a valid PDF file (maximum 15 MB).");
    await cleanupSyllabusUploads();
    const storageName = crypto.randomBytes(18).toString("hex") + ".pdf",
      uploadId = crypto.randomUUID();
    const filename = path
      .basename(req.file.originalname.replace(/\\/g, "/"))
      .slice(0, 255);
    await fs.writeFile(filePath(storageName), req.file.buffer, { flag: "wx" });
    try {
      await db.execute(
        "INSERT INTO syllabus_uploads (upload_id,uploader_id,filename,storage_name,file_size,expires_at) VALUES (?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 24 HOUR))",
        [uploadId, actor(req), filename, storageName, req.file.size],
      );
    } catch (error) {
      await fs.unlink(filePath(storageName));
      throw error;
    }
    const { suggestions, extractionMessage } = await analyzeFile(storageName);
    const [matches] = suggestions.code
      ? await db.execute(
          "SELECT * FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL",
          [normalizeCatalogCode(suggestions.code)],
        )
      : [[]];
    res.status(201).json({
      success: true,
      uploadId,
      filename,
      suggestions,
      extractionMessage,
      matches: matches.map(present),
    });
  }),
);
router.get(
  "/uploads/:id/pdf",
  admin,
  run(async (req, res) => {
    const [[row]] = await db.execute(
      "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? AND expires_at>NOW()",
      [req.params.id, actor(req)],
    );
    if (!row) fail("Upload expired or not found.", 404);
    res
      .set({
        "Content-Type": "application/pdf",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .sendFile(filePath(row.storage_name));
  }),
);
router.delete(
  "/uploads/:id",
  admin,
  run(async (req, res) => {
    await transaction(async (connection) => {
      const [[row]] = await connection.execute(
        "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? FOR UPDATE",
        [req.params.id, actor(req)],
      );
      if (row) {
        await fs.unlink(filePath(row.storage_name)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
        await connection.execute(
          "DELETE FROM syllabus_uploads WHERE upload_id=?",
          [row.upload_id],
        );
      }
    });
    res.json({ success: true });
  }),
);
router.get(
  "/",
  admin,
  run(async (req, res) => {
    const { page, size } = windowFor(req),
      values = [],
      conditions =
        req.query.includeArchived === "1"
          ? ["1=1"]
          : [
              req.query.archived === "1"
                ? "archived_at IS NOT NULL"
                : "archived_at IS NULL",
            ];
    if (req.query.q) {
      conditions.push("(code LIKE ? OR title LIKE ?)");
      values.push(
        ...Array(2).fill("%" + String(req.query.q).slice(0, 255) + "%"),
      );
    }
    if (["active", "draft"].includes(req.query.status)) {
      conditions.push("status=?");
      values.push(req.query.status);
    }
    if (["BSIT", "BSCS"].includes(req.query.program)) {
      conditions.push("JSON_CONTAINS(programs, ?)");
      values.push(JSON.stringify(req.query.program));
    }
    if (req.query.normalizedCode) {
      conditions.push("normalized_code=?");
      values.push(normalizeCatalogCode(req.query.normalizedCode));
    }
    const where = " WHERE " + conditions.join(" AND ");
    const [[count]] = await db.execute(
      "SELECT COUNT(*) AS total FROM course_catalog" + where,
      values,
    );
    const [rows] = await db.query(
      "SELECT * FROM course_catalog" +
        where +
        " ORDER BY code,catalog_id LIMIT ? OFFSET ?",
      [...values, size, (page - 1) * size],
    );
    res.json({
      success: true,
      records: rows.map(present),
      total: Number(count.total),
      page,
    });
  }),
);
router.post("/versions/:id/retry-lessons", admin, run(async (req,res) => {
  const [result] = await db.execute("UPDATE catalog_lesson_jobs j JOIN syllabus_versions v ON v.version_id=j.version_id JOIN course_catalog c ON c.catalog_id=v.catalog_id SET j.status='queued',j.error_message=NULL WHERE j.version_id=? AND j.status='failed' AND c.status='active' AND c.archived_at IS NULL",[req.params.id]);
  if (!result.affectedRows) fail("No failed generation is available to retry.",409);
  res.json({success:true});
}));
router.get(
  "/:id",
  admin,
  run(async (req, res) => {
    const [[row]] = await db.execute(
      "SELECT * FROM course_catalog WHERE catalog_id=?",
      [req.params.id],
    );
    if (!row) fail("Catalog course not found.", 404);
    const [versions] = await db.execute(
      "SELECT v.version_id,v.catalog_id,v.academic_year,v.semester,v.filename,v.uploaded_at,v.coverage_modules,(SELECT status FROM catalog_lesson_jobs j WHERE j.version_id=v.version_id) AS generation_status,(SELECT error_message FROM catalog_lesson_jobs j WHERE j.version_id=v.version_id) AS generation_error,COALESCE(u.display_name,u.name,u.email) AS uploader FROM syllabus_versions v LEFT JOIN users u ON u.userId=v.uploaded_by WHERE v.catalog_id=? ORDER BY v.version_id DESC",
      [row.catalog_id],
    );
    res.json({ success: true, course: present(row), versions });
  }),
);
router.post(
  "/",
  admin,
  run(async (req, res) => {
    const result = await transaction(async (connection) => {
      let course,
        creating = !req.body.catalogId;
      if (creating) {
        const details = catalogDetails(req.body);
        const [matches] = await connection.execute(
          "SELECT * FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL",
          [details.normalizedCode],
        );
        if (matches.length) {
          const error = Object.assign(
            new Error(
              "This course already exists. Attach the PDF as a new syllabus version.",
            ),
            { statusCode: 409, matches: matches.map(present) },
          );
          throw error;
        }
        const [insert] = await connection.execute(
          "INSERT INTO course_catalog (code,normalized_code,title,description,units,programs) VALUES (?,?,?,?,?,?)",
          [
            details.code,
            details.normalizedCode,
            details.title,
            details.description,
            details.units,
            JSON.stringify(details.programs),
          ],
        );
        course = {
          catalog_id: insert.insertId,
          ...details,
          status: "draft",
          archived_at: null,
        };
        await audit(
          connection,
          req,
          "Created catalog course",
          course.catalog_id,
          details,
        );
      } else {
        [[course]] = await connection.execute(
          "SELECT * FROM course_catalog WHERE catalog_id=? FOR UPDATE",
          [req.body.catalogId],
        );
        if (!course) fail("Course not found.", 404);
        if (course.archived_at) {
          if (req.body.restoreArchived !== true)
            fail("Restore this course before uploading a syllabus.");
          if (req.body.reviewed !== true)
            fail("Review the archived course details before restoring and saving.");
          const [[conflict]] = await connection.execute(
            "SELECT catalog_id FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL AND catalog_id<>? LIMIT 1",
            [course.normalized_code, course.catalog_id],
          );
          if (conflict) fail("An unarchived course already uses this code. Select that course instead.", 409);
          await connection.execute("UPDATE course_catalog SET archived_at=NULL WHERE catalog_id=?", [course.catalog_id]);
          await audit(connection, req, "Restored catalog course", course.catalog_id, { archived_at: { before: course.archived_at, after: null } });
        }
      }
      if (!req.body.uploadId) fail("Upload a syllabus PDF before saving.");
      const [[file]] = await connection.execute(
        "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? AND expires_at>NOW() FOR UPDATE",
        [req.body.uploadId, actor(req)],
      );
      if (!file) fail("Upload expired or already saved. Upload the PDF again.");
      if (
        (req.body.activate === true || course.status === "active") &&
        req.body.reviewed !== true
      )
        fail(
          "Confirm that you reviewed the extracted information before activation.",
        );
      for (const key of ["academic_year", "semester"])
        if (String(req.body[key] || "").length > 30)
          fail("Syllabus period fields must be at most 30 characters.");
      const coverageModules = validateCoverageModules(
        req.body.coverage_modules,
      );
      const [version] = await connection.execute(
        "INSERT INTO syllabus_versions (catalog_id,academic_year,semester,filename,storage_name,file_size,uploaded_by,coverage_modules) VALUES (?,?,?,?,?,?,?,?)",
        [
          course.catalog_id,
          req.body.academic_year || null,
          req.body.semester || null,
          file.filename,
          file.storage_name,
          file.file_size,
          actor(req),
          JSON.stringify(coverageModules),
        ],
      );
      await connection.execute(
        "DELETE FROM syllabus_uploads WHERE upload_id=?",
        [file.upload_id],
      );
      await audit(
        connection,
        req,
        "Uploaded syllabus version",
        course.catalog_id,
        {
          versionId: version.insertId,
          coverage_modules: coverageModules,
          academic_year: req.body.academic_year || null,
          semester: req.body.semester || null,
          filename: file.filename,
        },
      );
      if (req.body.activate === true) {
        await connection.execute(
          "UPDATE course_catalog SET status='active',reviewed_by=?,reviewed_at=NOW() WHERE catalog_id=?",
          [actor(req), course.catalog_id],
        );
        await audit(
          connection,
          req,
          "Activated catalog course",
          course.catalog_id,
          { status: { before: course.status, after: "active" } },
        );
      }
      const generationQueued = (req.body.activate === true || course.status === "active") && coverageModules.length > 0;
      if (generationQueued) await queueCatalogLessons(connection, version.insertId);
      return { catalogId: course.catalog_id, versionId: version.insertId, generationQueued };
    });
    res.status(201).json({ success: true, ...result });
  }),
);
router.patch(
  "/:id",
  admin,
  run(async (req, res) => {
    let archivedClassCount = 0;
    let professorEmailNotifications = [];
    await transaction(async (connection) => {
      const [[course]] = await connection.execute(
        "SELECT * FROM course_catalog WHERE catalog_id=? FOR UPDATE",
        [req.params.id],
      );
      if (!course) fail("Course not found.", 404);
      const action = req.body.action;
      if (action === "archive" || action === "restore") {
        if (action === "restore") {
          const [[conflict]] = await connection.execute(
            "SELECT catalog_id FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL AND catalog_id<>? LIMIT 1",
            [course.normalized_code, course.catalog_id],
          );
          if (conflict) fail("Cannot restore this course because an unarchived course already uses its code. Archive that course first.", 409);
        }
        await connection.execute(
          `UPDATE course_catalog SET archived_at=${action === "archive" ? "NOW()" : "NULL"} WHERE catalog_id=?`,
          [course.catalog_id],
        );
        if (action === "archive") {
          const archiveResult = await archiveCatalogClasses(
            connection,
            course.catalog_id,
            actor(req),
            actorRoleOf(req),
          );
          archivedClassCount = archiveResult.archivedCount;
          professorEmailNotifications = archiveResult.emailNotifications;
        }
        await audit(
          connection,
          req,
          action === "archive"
            ? "Archived catalog course"
            : "Restored catalog course",
          course.catalog_id,
          {
            archived_at: {
              before: course.archived_at,
              after: action === "archive" ? "now" : null,
            },
            status: course.status,
          },
        );
        return;
      }
      if (course.archived_at)
        fail("Restore this course before making changes.");
      if (action === "activate") {
        if (req.body.reviewed !== true)
          fail("Explicit review confirmation is required.");
        const [[version]] = await connection.execute(
          "SELECT version_id,coverage_modules FROM syllabus_versions WHERE catalog_id=? ORDER BY version_id DESC LIMIT 1",
          [course.catalog_id],
        );
        if (!version) fail("Upload a syllabus before activation.");
        await connection.execute(
          "UPDATE course_catalog SET status='active',reviewed_by=?,reviewed_at=NOW() WHERE catalog_id=?",
          [actor(req), course.catalog_id],
        );
        await queueCatalogLessons(connection, version.version_id);
        await audit(
          connection,
          req,
          "Activated catalog course",
          course.catalog_id,
          { status: { before: course.status, after: "active" } },
        );
        return;
      }
      if (action !== "edit") fail("Unknown catalog action.");
      const details = catalogDetails(req.body),
        changes = {};
      for (const key of ["code", "title", "description", "units", "programs"]) {
        const before = key === "programs" ? programs(course[key]) : course[key];
        if (JSON.stringify(before) !== JSON.stringify(details[key]))
          changes[key] = { before, after: details[key] };
      }
      if (course.status === "active" && req.body.reviewed !== true)
        fail("Confirm review before updating an active course.");
      await connection.execute(
        "UPDATE course_catalog SET code=?,normalized_code=?,title=?,description=?,units=?,programs=?,reviewed_by=?,reviewed_at=? WHERE catalog_id=?",
        [
          details.code,
          details.normalizedCode,
          details.title,
          details.description,
          details.units,
          JSON.stringify(details.programs),
          req.body.reviewed ? actor(req) : null,
          req.body.reviewed ? new Date() : null,
          course.catalog_id,
        ],
      );
      await audit(
        connection,
        req,
        "Edited catalog details",
        course.catalog_id,
        changes,
      );
    });

    let emailNotificationsSent = 0;
    let emailNotificationsFailed = 0;
    if (req.body.action === "archive" && professorEmailNotifications.length) {
      const outcomes = await Promise.allSettled(
        professorEmailNotifications.map((notice) =>
          sendCatalogCourseArchivedEmail(notice),
        ),
      );
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          emailNotificationsSent += 1;
        } else {
          emailNotificationsFailed += 1;
          console.error(
            `Catalog archive email failed for ${professorEmailNotifications[index].email}:`,
            outcome.reason,
          );
        }
      });
    }

    res.json({
      success: true,
      ...(req.body.action === "archive"
        ? {
            archivedClassCount,
            emailNotificationsSent,
            emailNotificationsFailed,
          }
        : {}),
    });
  }),
);
router.use((error, _req, res, _next) => {
  if (error.code === "ER_DUP_ENTRY")
    return res.status(409).json({
      success: false,
      message:
        "This course code already exists. Select the existing course to attach a syllabus version.",
    });
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode
      ? error.message
      : "Course catalog request failed.",
    matches: error.matches,
  });
  if (!error.statusCode) console.error("Course catalog error:", error);
});
export default router;
