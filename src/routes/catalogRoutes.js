import { getCourseById } from "../controllers/courseController.js";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { sendCatalogCourseStatusEmail } from "../utils/mailer.js";
import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import {
  extractSyllabus,
  INVALID_SYLLABUS,
} from "../services/catalog/syllabusExtraction.js";
import {
  syllabusDirectory as directory,
  syllabusFilePath as filePath,
} from "../services/catalog/syllabusStorage.js";
import {
  catalogDetails,
  normalizeCatalogCode,
  validateCoverageModules,
} from "../services/catalog/catalogRules.js";
import { getRequestIp } from "../services/system/auditLogService.js";

const router = express.Router();
const admin = requireRole("admin", "super_admin");
const uploadSyllabus = requireRole("admin", "professor");
const manageCatalogStatus = requireRole("super_admin");
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
const programs = (value) =>
  Array.isArray(value) ? value : JSON.parse(value || "[]");
const present = (row) => {
  const { normalized_code, available_normalized_code, ...rest } = row;
  return { ...rest, status: row.status === "active" ? "active" : "inactive", programs: programs(row.programs) };
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

async function analyzeFile(data) {
  const suggestions = await extractSyllabus(data);
  const extractionMessage = suggestions.coverage_modules.length
    ? ""
    : "Course Coverage headings were not detected. You can add them from the PDF before saving.";
  return { cvsuSyllabusValidated: true, suggestions, extractionMessage };
}
router.post(
  "/uploads/:id/extract",
  authenticateUser,
  uploadSyllabus,
  run(async (req, res) => {
    const [[row]] = await db.execute(
      "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? AND expires_at>NOW()",
      [req.params.id, actor(req)],
    );
    if (!row) fail("Upload expired or not found.", 404);
    const data = await analyzeFile(await fs.readFile(filePath(row.storage_name)));
    const [matches] = await db.execute(
      "SELECT * FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL",
      [normalizeCatalogCode(data.suggestions.code)],
    );
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
      "SELECT * FROM course_catalog WHERE status='active' AND archived_at IS NULL AND (code ILIKE ? OR title ILIKE ?) ORDER BY code",
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
// Syllabus activation controls availability in the course catalog.
const syllabusAccess = requireRole("professor", "admin", "super_admin");
const syllabusRecordsSql = `
  SELECT v.version_id,v.catalog_id,v.filename,v.academic_year,v.semester,
         v.uploaded_at,v.uploaded_by,c.code,c.title,c.description,c.units,
         c.programs,c.status,c.archived_at,c.reviewed_at,
         COALESCE(u.display_name,u.name,u.email,'Unavailable') AS uploader,
         COALESCE(reviewer.display_name,reviewer.name,reviewer.email) AS reviewer
  FROM syllabus_versions v
  JOIN course_catalog c ON c.catalog_id=v.catalog_id
  LEFT JOIN users u ON u.userId=v.uploaded_by
  LEFT JOIN users reviewer ON reviewer.userId=c.reviewed_by
`;
router.get(
  "/syllabi",
  syllabusAccess,
  run(async (req, res) => {
    const { page, size } = windowFor(req);
    const history = req.query.view === "history";
    const conditions = [];
    const values = [];
    const professor = req.user.role === "professor";
    if (professor) {
      conditions.push("v.uploaded_by=?");
      values.push(actor(req));
    }
    const latestSubmission = "v.version_id=(SELECT MAX(latest.version_id) FROM syllabus_versions latest WHERE latest.catalog_id=v.catalog_id)";
    const visibleWhere = " WHERE " + [...conditions, latestSubmission].join(" AND ");
    const [[summary]] = await db.execute(
      `SELECT COUNT(DISTINCT c.catalog_id) FILTER (WHERE c.archived_at IS NULL) AS total,
              COUNT(DISTINCT c.catalog_id) FILTER (WHERE c.archived_at IS NULL AND c.status='active') AS active,
              COUNT(DISTINCT c.catalog_id) FILTER (WHERE c.archived_at IS NULL AND c.status<>'active') AS inactive
       FROM syllabus_versions v
       JOIN course_catalog c ON c.catalog_id=v.catalog_id ${visibleWhere}`,
      values,
    );
    if (!history) {
      conditions.push("c.archived_at IS NULL");
      conditions.push(latestSubmission);
    }
    if (["active", "inactive"].includes(req.query.status)) {
      conditions.push((req.query.status === "active" ? "c.status='active'" : "c.status<>'active'") + " AND c.archived_at IS NULL");
    } else if (history && req.query.status === "archived") {
      conditions.push("c.archived_at IS NOT NULL");
    }
    if (req.query.q) {
      conditions.push("(c.code ILIKE ? OR c.title ILIKE ? OR v.filename ILIKE ? OR COALESCE(u.display_name,u.name,u.email,'') ILIKE ?)");
      values.push(...Array(4).fill("%" + String(req.query.q).slice(0, 255) + "%"));
    }
    if (["BSIT", "BSCS"].includes(req.query.program)) {
      conditions.push("c.programs::jsonb @> ?::jsonb");
      values.push(JSON.stringify(req.query.program));
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const [[count]] = await db.execute(
      "SELECT COUNT(*) AS total FROM (" + syllabusRecordsSql + where + ") records",
      values,
    );
    const [records] = await db.query(
      syllabusRecordsSql + where + " ORDER BY v.uploaded_at DESC,v.version_id DESC LIMIT ? OFFSET ?",
      [...values, size, (page - 1) * size],
    );
    res.json({
      success: true,
      records: records.map(present),
      total: Number(count.total),
      summary,
      page,
    });
  }),
);
router.get(
  "/syllabi/:id",
  syllabusAccess,
  run(async (req, res) => {
    const [[record]] = await db.execute(
      syllabusRecordsSql + " WHERE v.version_id=?" +
        (req.user.role === "professor" ? " AND v.uploaded_by=?" : ""),
      req.user.role === "professor" ? [req.params.id, actor(req)] : [req.params.id],
    );
    if (!record) fail("Syllabus not found.", 404);
    const [[version]] = await db.execute(
      "SELECT coverage_modules FROM syllabus_versions WHERE version_id=?",
      [record.version_id],
    );
    res.json({ success: true, syllabus: { ...present(record), coverage_modules: version.coverage_modules } });
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
      Number(version.uploaded_by) !== Number(actor(req)) &&
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
      `SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE status='active' AND archived_at IS NULL) AS active,COUNT(*) FILTER (WHERE status<>'active' AND archived_at IS NULL) AS inactive,(SELECT COUNT(*) FROM courses WHERE professor_id IS NOT NULL OR COALESCE(professor_email,'') <> '') AS classes FROM course_catalog`,
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
      "(c.title ILIKE ? OR c.code ILIKE ? OR c.catalog_code ILIKE ? OR c.class_name ILIKE ? OR c.professor_name ILIKE ? OR u.name ILIKE ?)",
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
    `SELECT c.course_id,c.catalog_id,c.catalog_code,c.title,c.code,c.class_name,c.program,c.year_level,c.section_name,c.academic_year,c.semester,c.status,c.archived,c.created_at,COALESCE(u.display_name,u.name,c.professor_name,c.professor_email) AS professor,(SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id=c.course_id AND e.status='approved' AND e.archived=0) AS student_count,
      ARRAY(
        SELECT DISTINCT
          CASE
            WHEN profile.section ~ '^[1-4][A-F]$' THEN profile.section
            WHEN profile.section ~ '^[A-F]$' AND profile.year_number IS NOT NULL
              THEN profile.year_number || profile.section
            ELSE profile.section
          END AS section
        FROM course_enrollments enrollment
        JOIN users student ON student.userId = enrollment.user_id
        CROSS JOIN LATERAL (
          SELECT
            REGEXP_REPLACE(UPPER(TRIM(student.section_name)), '[[:space:]-]+', '', 'g') AS section,
            SUBSTRING(TRIM(student.year_level) FROM '^[1-4]') AS year_number
        ) profile
        WHERE enrollment.course_id = c.course_id
          AND enrollment.status = 'approved'
          AND enrollment.archived = 0
          AND profile.section ~ '^([1-4])?[A-F]$'
        ORDER BY section
) AS enrolled_sections,

COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object(
      'program', s.program,
      'year_level', s.year_level,
      'section_name', s.section_name,
      'student_count', s.student_count
    )
    ORDER BY s.program, s.year_level, s.section_name
  )
  FROM (
    SELECT
      su.course AS program,
      su.year_level AS year_level,
      su.section_name AS section_name,
      COUNT(*) AS student_count
    FROM course_enrollments e
    LEFT JOIN users su ON su.userId = e.user_id
    WHERE e.course_id = c.course_id
      AND e.status = 'approved'
      AND e.archived = 0
    GROUP BY
      su.course,
      su.year_level,
      su.section_name
  ) s
), '[]'::jsonb) AS enrollment_sections
      FROM courses c LEFT JOIN users u ON u.userId=c.professor_id ${where} ORDER BY c.course_id DESC LIMIT ? OFFSET ?`,
    [...values, size, (page - 1) * size],
  );
  res.json({ success: true, records, total: Number(count.total), page });
}
router.get("/classes", admin, run(catalogClasses));
router.get("/classes/:id", admin, run(getCourseById));
router.post(
  "/uploads",
  uploadSyllabus,
  (req, res, next) =>
    upload.single("file")(req, res, (error) =>
      error ? next(Object.assign(error, { statusCode: 400 })) : next(),
    ),
  run(async (req, res) => {
    if (!req.file || req.file.buffer.subarray(0, 5).toString() !== "%PDF-")
      fail("Choose a valid PDF file (maximum 15 MB).");
    const data = await analyzeFile(req.file.buffer);
    const [matches] = await db.execute(
      "SELECT * FROM course_catalog WHERE normalized_code=? AND archived_at IS NULL",
      [normalizeCatalogCode(data.suggestions.code)],
    );
    await cleanupSyllabusUploads();
    const storageName = crypto.randomBytes(18).toString("hex") + ".pdf",
      uploadId = crypto.randomUUID();
    const filename = path
      .basename(req.file.originalname.replace(/\\/g, "/"))
      .slice(0, 255);
    await fs.writeFile(filePath(storageName), req.file.buffer, { flag: "wx" });
    try {
      await db.execute(
        "INSERT INTO syllabus_uploads (upload_id,uploader_id,filename,storage_name,file_size,expires_at) VALUES (?,?,?,?,?,(NOW() + INTERVAL '24 hour'))",
        [uploadId, actor(req), filename, storageName, req.file.size],
      );
    } catch (error) {
      await fs.unlink(filePath(storageName));
      throw error;
    }
    res.status(201).json({
      success: true,
      uploadId,
      filename,
      ...data,
      matches: matches.map(present),
    });
  }),
);
router.get(
  "/uploads/:id/pdf",
  uploadSyllabus,
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
  uploadSyllabus,
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
      conditions.push("(code ILIKE ? OR title ILIKE ?)");
      values.push(
        ...Array(2).fill("%" + String(req.query.q).slice(0, 255) + "%"),
      );
    }
    if (["active", "inactive"].includes(req.query.status)) {
      conditions.push(req.query.status === "active" ? "status='active'" : "status<>'active'");
    }
    if (["BSIT", "BSCS"].includes(req.query.program)) {
      conditions.push("programs::jsonb @> ?::jsonb");
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
  uploadSyllabus,
  run(async (req, res) => {
    if (req.body.activate === true || req.body.restoreArchived === true) {
      fail("Syllabus uploads cannot change a catalog course's status.", 403);
    }
    const result = await transaction(async (connection) => {
      if (!req.body.uploadId) fail("Upload a syllabus PDF before saving.");
      const [[file]] = await connection.execute(
        "SELECT * FROM syllabus_uploads WHERE upload_id=? AND uploader_id=? AND expires_at>NOW() FOR UPDATE",
        [req.body.uploadId, actor(req)],
      );
      if (!file) fail("Upload expired or already saved. Upload the PDF again.");
      const syllabus = await extractSyllabus(
        await fs.readFile(filePath(file.storage_name)),
        { includeCoverage: false },
      );
      const academicYear = syllabus.academic_year || null;
      const semester = syllabus.semester || null;
      let course,
        creating = !req.body.catalogId;
      if (creating) {
        const details = catalogDetails(syllabus);
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
          "INSERT INTO course_catalog (code,normalized_code,title,description,units,programs,status) VALUES (?,?,?,?,?,?,'inactive')",
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
          status: "inactive",
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
        if (course.normalized_code !== normalizeCatalogCode(syllabus.code)) {
          fail(`The PDF is for ${syllabus.code}. Upload a syllabus for ${course.code}.`);
        }
        if (course.archived_at)
          fail("This course is archived. Submit the syllabus as a new catalog course.");
      }
      if (course.status === "active" && req.body.reviewed !== true)
        fail("Confirm that you reviewed the extracted information before saving a version to an active course.");
      const coverageModules = validateCoverageModules(
        req.body.coverage_modules,
      );
      const [version] = await connection.execute(
        "INSERT INTO syllabus_versions (catalog_id,academic_year,semester,filename,storage_name,file_size,uploaded_by,coverage_modules) VALUES (?,?,?,?,?,?,?,?)",
        [
          course.catalog_id,
          academicYear,
          semester,
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
          academic_year: academicYear,
          semester,
          filename: file.filename,
        },
      );
      if (!creating) {
        await connection.execute(
          "UPDATE course_catalog SET status='inactive',reviewed_by=NULL,reviewed_at=NULL,updated_at=NOW() WHERE catalog_id=?",
          [course.catalog_id],
        );
        await audit(connection, req, "Uploaded syllabus awaiting activation", course.catalog_id, {
          versionId: version.insertId,
          status: { before: course.status, after: "inactive" },
        });
      }
      return { catalogId: course.catalog_id, versionId: version.insertId, generationQueued: false };
    });
    res.status(201).json({ success: true, ...result });
  }),
);
router.patch(
  "/:id",
  manageCatalogStatus,
  run(async (req, res) => {
    const { action } = req.body;
    if (action !== "activate" && action !== "deactivate")
      fail("Choose Activate or Deactivate.");
    const activating = action === "activate";
    const status = activating ? "active" : "inactive";

    const change = await transaction(async (connection) => {
      const [[course]] = await connection.execute(
        "SELECT * FROM course_catalog WHERE catalog_id=? FOR UPDATE",
        [req.params.id],
      );
      if (!course) fail("Course not found.", 404);
      if (course.archived_at) fail("This catalog course is archived.", 409);

      const [[version]] = await connection.execute(
        `SELECT v.version_id,v.filename,v.uploaded_by,u.email,
                COALESCE(u.display_name,u.name) AS uploader_name
         FROM syllabus_versions v
         LEFT JOIN users u ON u.userId=v.uploaded_by
           AND u.role IN ('admin','professor')
         WHERE v.catalog_id=?
         ORDER BY v.version_id DESC LIMIT 1`,
        [course.catalog_id],
      );
      if (activating && !version) fail("Upload a syllabus before activation.");
      if (req.body.versionId != null && Number(req.body.versionId) !== Number(version?.version_id))
        fail("A newer syllabus was submitted. Refresh and review the latest upload.", 409);
      if (course.status === status) return null;

      await connection.execute(
        "UPDATE course_catalog SET status=?,reviewed_by=?,reviewed_at=NOW(),updated_at=NOW() WHERE catalog_id=?",
        [status, actor(req), course.catalog_id],
      );
      if (activating) {
        await connection.execute(
          `INSERT INTO catalog_lesson_jobs (version_id)
           SELECT version_id FROM syllabus_versions
           WHERE catalog_id=? AND coverage_modules IS NOT NULL
             AND coverage_modules <> '[]'
           ON CONFLICT (version_id) DO UPDATE
             SET status='queued',error_message=NULL,updated_at=NOW()
             WHERE catalog_lesson_jobs.status='failed'`,
          [course.catalog_id],
        );
      }
      await audit(
        connection,
        req,
        activating ? "Activated catalog course" : "Deactivated catalog course",
        course.catalog_id,
        { status: { before: course.status, after: status }, versionId: version?.version_id },
      );
      return { course, version };
    });

    let notification = "not_needed";
    if (change) {
      const { course, version } = change;
      notification = "unavailable";
      if (version?.email?.trim()) {
        try {
          await sendCatalogCourseStatusEmail({
            email: version.email,
            name: version.uploader_name,
            code: course.code,
            title: course.title,
            syllabusFilename: version.filename,
            status,
          });
          notification = "sent";
        } catch (error) {
          notification = "failed";
          console.error(`Catalog status email failed for syllabus version ${version.version_id}:`, error);
        }
      }
    }
    res.json({ success: true, status, changed: Boolean(change), notification });
  }),
);
router.use((error, _req, res, _next) => {
  if (error.code === "23505")
    return res.status(409).json({
      success: false,
      message:
        "This course code already exists. Select the existing course to attach a syllabus version.",
    });
  res.status(error.statusCode || 500).json({
    success: false,
    code: error.code === INVALID_SYLLABUS ? error.code : undefined,
    message: error.statusCode
      ? error.message
      : "Course catalog request failed.",
    matches: error.matches,
  });
  if (!error.statusCode) console.error("Course catalog error:", error);
});
export default router;
