import { extractAcademicCalendar } from "../services/academicCalendarExtraction.js";
import express from "express";
import multer from "multer";
import { db } from "../db.js";
import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import {
  calendarDetails,
  calendarFile,
} from "../services/academicCalendarRules.js";
const fields =
  "calendar_id,title,academic_year,events,published,filename,mime_type,updated_at";
const isAdmin = (req) => ["admin", "super_admin"].includes(req.user.role);
const present = (row) => ({
  ...row,
  published: !!row.published,
  events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
});
export function createAcademicCalendarRouter(
  database = db,
  authenticate = authenticateUser,
  extract = extractAcademicCalendar,
) {
  const router = express.Router();
  const admin = requireRole("admin", "super_admin");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 5,
      fields: 4,
      fieldSize: 600000,
    },
  });
  const run = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  router.use(authenticate);
  router.get(
    "/",
    run(async (req, res) => {
      const [records] = await database.query(
        `SELECT ${fields} FROM academic_calendars ${isAdmin(req) ? "" : "WHERE published=1"} ORDER BY academic_year DESC,calendar_id DESC`,
      );
      res.json({
        success: true,
        records: await Promise.all(
          records.map(async (row) => {
            const [extra] = await database.execute(
              "SELECT file_index,filename,mime_type FROM academic_calendar_files WHERE calendar_id=? ORDER BY file_index",
              [row.calendar_id],
            );
            return {
              ...present(row),
              documents: [
                ...(row.filename
                  ? [
                      {
                        file_index: 0,
                        filename: row.filename,
                        mime_type: row.mime_type,
                      },
                    ]
                  : []),
                ...extra,
              ],
            };
          }),
        ),
      });
    }),
  );
  router.get(
    "/:id/file",
    run(async (req, res) => {
      const fileIndex = Number(req.query.index || 0);
      if (!Number.isInteger(fileIndex) || fileIndex < 0)
        return res
          .status(400)
          .json({ success: false, message: "Invalid calendar document." });
      const sql =
        fileIndex === 0
          ? `SELECT filename,mime_type,document FROM academic_calendars WHERE calendar_id=? ${isAdmin(req) ? "" : "AND published=1"}`
          : `SELECT f.filename,f.mime_type,f.document FROM academic_calendar_files f JOIN academic_calendars c ON c.calendar_id=f.calendar_id WHERE f.calendar_id=? AND f.file_index=? ${isAdmin(req) ? "" : "AND c.published=1"}`;
      const [[record]] = await database.execute(
        sql,
        fileIndex ? [req.params.id, fileIndex] : [req.params.id],
      );
      if (!record || !record.mime_type)
        return res
          .status(404)
          .json({ success: false, message: "Calendar not found." });
      res.set("Content-Type", record.mime_type);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "private, no-store");
      res.set(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      );
      res.send(record.document);
    }),
  );
  const extractFiles = async (files, year) => {
    const results = await Promise.allSettled(
      files.map((file) => extract(file, year)),
    );
    const events = [],
      undated = [],
      seen = new Set();
    let inferredYear = year;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        undated.push(`${files[index].filename}: ${result.reason.message}`);
        return;
      }
      const data = result.value;
      inferredYear ||= data.academic_year;
      undated.push(...data.undated);
      if (!data.events.length)
        undated.push(`${files[index].filename}: no dated activities found.`);
      for (const event of data.events) {
        const key = [
          event.title.trim().toLowerCase().replace(/\s+/g, " "),
          event.start_date,
          event.end_date || event.start_date,
          (event.description || "").trim().toLowerCase().replace(/\s+/g, " "),
        ].join("|");
        if (!seen.has(key)) {
          seen.add(key);
          events.push(event);
        }
      }
    });
    if (
      !events.length &&
      results.every((result) => result.status === "rejected")
    )
      throw Object.assign(new Error(undated.join(" ")), { statusCode: 502 });
    return {
      title: "CvSU Academic Calendar",
      academic_year: inferredYear,
      events: events.sort((a, b) => a.start_date.localeCompare(b.start_date)),
      undated,
    };
  };
  router.post(
    "/extract",
    admin,
    upload.array("file", 5),
    run(async (req, res) => {
      const files = (req.files || []).map(calendarFile);
      if (!files.length) calendarFile(null);
      const result = await extractFiles(
        files,
        String(req.body.academic_year || ""),
      );
      res.json({ success: true, ...result });
    }),
  );
  router.post(
    "/:id/extract",
    admin,
    run(async (req, res) => {
      const [[record]] = await database.execute(
        "SELECT filename,mime_type,document,academic_year FROM academic_calendars WHERE calendar_id=?",
        [req.params.id],
      );
      if (!record || !record.mime_type)
        return res.status(404).json({
          success: false,
          message: "Attach a calendar image or PDF first.",
        });
      const [extra] = await database.execute(
        "SELECT filename,mime_type,document FROM academic_calendar_files WHERE calendar_id=? ORDER BY file_index",
        [req.params.id],
      );
      const result = await extractFiles(
        [record, ...extra],
        record.academic_year,
      );
      res.json({ success: true, ...result });
    }),
  );
  const save = run(async (req, res) => {
    const details = calendarDetails(req.body);
    const files = (req.files || []).map(calendarFile);
    let file = files[0] || null;
    const values = [
      details.title,
      details.academic_year,
      JSON.stringify(details.events),
      details.published,
      req.user.userId,
    ];
    const connection = database.getConnection
      ? await database.getConnection()
      : database;
    let id = req.params.id;
    try {
      await connection.beginTransaction();
      if (id) {
        const [[existing]] = await connection.execute(
          "SELECT calendar_id FROM academic_calendars WHERE calendar_id=?",
          [id],
        );
        if (!existing)
          throw Object.assign(new Error("Calendar not found."), {
            statusCode: 404,
          });
        const fileSql = file ? ",filename=?,mime_type=?,document=?" : "";
        if (file) values.push(file.filename, file.mime_type, file.document);
        await connection.execute(
          `UPDATE academic_calendars SET title=?,academic_year=?,events=?,published=?,updated_by=?,updated_at=CURRENT_TIMESTAMP${fileSql} WHERE calendar_id=?`,
          [...values, id],
        );
      } else {
        if (!file && !details.events.length)
          throw Object.assign(
            new Error("Add an event or attach an official calendar document."),
            { statusCode: 400 },
          );
        if (!file)
          file = { filename: "", mime_type: "", document: Buffer.alloc(0) };
        const [result] = await connection.execute(
          "INSERT INTO academic_calendars (title,academic_year,events,published,updated_by,filename,mime_type,document) VALUES (?,?,?,?,?,?,?,?)",
          [...values, file.filename, file.mime_type, file.document],
        );
        id = result.insertId;
      }
      if (files.length) {
        await connection.execute(
          "DELETE FROM academic_calendar_files WHERE calendar_id=?",
          [id],
        );
        for (let index = 1; index < files.length; index++) {
          const item = files[index];
          await connection.execute(
            "INSERT INTO academic_calendar_files (calendar_id,file_index,filename,mime_type,document) VALUES (?,?,?,?,?)",
            [id, index, item.filename, item.mime_type, item.document],
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      if (connection !== database) connection.release();
    }
    res.json({ success: true, calendar_id: Number(id) });
  });
  router.post("/", admin, upload.array("file", 5), save);
  router.put("/:id", admin, upload.array("file", 5), save);
  router.use((error, req, res, next) => {
    const duplicate = error.code === "ER_DUP_ENTRY";
    res
      .status(
        duplicate
          ? 409
          : error instanceof multer.MulterError
            ? 400
            : error.statusCode || 500,
      )
      .json({
        success: false,
        message: duplicate
          ? "An academic calendar for this year already exists. Edit that calendar instead."
          : error.code === "LIMIT_FILE_SIZE"
            ? "Choose a file no larger than 10 MB."
            : error.statusCode || error instanceof multer.MulterError
              ? error.message
              : "Could not save the academic calendar.",
      });
  });
  return router;
}
export default createAcademicCalendarRouter();
