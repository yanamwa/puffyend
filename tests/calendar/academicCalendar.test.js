import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mysql from "mysql2/promise";
import {
  calendarDetails,
  calendarFile,
} from "../../src/services/calendar/academicCalendarRules.js";
import { migrateAcademicCalendar } from "../../src/migrations/academicCalendarMigration.js";
import { createAcademicCalendarRouter } from "../../src/routes/academicCalendarRoutes.js";
import { db as defaultPool } from "../../src/db.js";
const fields = {
  title: "CvSU Academic Calendar",
  academic_year: "2026-2027",
  published: false,
  events: [],
};
test("calendar validates consecutive years and real event dates", () => {
  assert.equal(calendarDetails(fields).published, false);
  for (const academic_year of ["2026", "2026-2028", "year"])
    assert.throws(() => calendarDetails({ ...fields, academic_year }));
  for (const events of [
    [null],
    [{ title: "Exam", start_date: "2026-02-30" }],
    [{ title: "Exam", start_date: "2026-10-20", end_date: "2026-10-19" }],
  ])
    assert.throws(() => calendarDetails({ ...fields, events }));
  assert.equal(
    calendarDetails({
      ...fields,
      events: [{ title: "Holiday", start_date: "2026-10-18", end_date: "" }],
    }).events[0].end_date,
    "2026-10-18",
  );
});
test("upload checks signatures and extension", () => {
  const file = {
    originalname: "calendar.pdf",
    buffer: Buffer.from("%PDF-1.4 test"),
  };
  assert.equal(calendarFile(file).mime_type, "application/pdf");
  assert.throws(() =>
    calendarFile({ ...file, buffer: Buffer.from("<script>bad</script>") }),
  );
  assert.throws(() => calendarFile({ ...file, originalname: "calendar.html" }));
});
test(
  "calendar lifecycle persists files, restricts publishing to admins, and hides drafts",
  { timeout: 60000 },
  async () => {
    const schema = "puffy_calendar_test_" + process.pid;
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || "127.0.0.1",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
    });
    let server;
    try {
      await connection.query("CREATE DATABASE ??", [schema]);
      await connection.query("USE ??", [schema]);
      await migrateAcademicCalendar(connection);
      await migrateAcademicCalendar(connection);
      const app = express();
      const auth = (req, res, next) => {
        const role = req.headers["x-test-role"];
        if (!role) return res.sendStatus(401);
        req.user = { role, userId: 1 };
        next();
      };
      app.use(
        "/calendars",
        createAcademicCalendarRouter(connection, auth, async () => ({
          title: "CvSU Academic Calendar",
          academic_year: "2026-2027",
          events: [
            {
              title: "Midterms",
              description: "Examinations",
              start_date: "2026-10-05",
              end_date: "2026-10-10",
            },
          ],
          undated: ["Graduation day TBA"],
        })),
      );
      server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      const base = `http://127.0.0.1:${server.address().port}/calendars`;
      const send = (path, role, method = "GET", body) =>
        fetch(base + path, {
          method,
          headers: role ? { "x-test-role": role } : {},
          body,
        });
      const form = (overrides = {}, includeFile = true) => {
        const body = new FormData();
        const values = { ...fields, ...overrides };
        for (const key of ["title", "academic_year", "published"])
          body.append(key, values[key]);
        body.append("events", JSON.stringify(values.events));
        if (includeFile)
          body.append(
            "file",
            new Blob(["%PDF-1.4 test"], { type: "application/pdf" }),
            "calendar.pdf",
          );
        return body;
      };
      assert.equal((await send("", null)).status, 401);
      for (const role of ["student", "professor"])
        assert.equal((await send("", role, "POST", form())).status, 403);
      const created = await send("", "admin", "POST", form());
      assert.equal(created.status, 200, await created.clone().text());
      const id = (await created.json()).calendar_id;
      assert.equal(
        (await send("/extract", "student", "POST", form())).status,
        403,
      );
      const imported = await send(`/${id}/extract`, "super_admin", "POST");
      assert.equal(imported.status, 200);
      assert.equal((await imported.json()).events[0].title, "Midterms");
      const pendingCalendar = (await (await send("", "admin")).json())
        .records[0];
      assert.equal(
        pendingCalendar.events.length,
        0,
        "extraction never publishes or saves before review",
      );

      assert.equal(
        (await (await send("", "student")).json()).records.length,
        0,
      );
      assert.equal((await send(`/${id}/file`, "student")).status, 404);
      assert.equal(
        (await (await send("", "super_admin")).json()).records.length,
        1,
      );
      assert.equal((await send("", "super_admin", "POST", form())).status, 409);
      const events = [
        {
          title: "Examinations",
          description: "Bring your student ID.\nCheck your room assignment.",
          start_date: "2026-10-20",
          end_date: "2026-10-23",
        },
      ];
      assert.equal(
        (
          await send(
            `/${id}`,
            "super_admin",
            "PUT",
            form({ published: true, events }, false),
          )
        ).status,
        200,
      );
      const published = (await (await send("", "student")).json()).records[0];
      assert.equal(published.events[0].title, "Examinations");
      assert.equal(published.events[0].description, events[0].description);
      assert.equal(published.published, true);
      assert.equal(published.document, undefined);
      const pdf = await send(`/${id}/file`, "student");
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      assert.equal(await pdf.text(), "%PDF-1.4 test");
      assert.equal(
        (await send(`/${id}`, "student", "PUT", form())).status,
        403,
      );
      assert.equal(
        (
          await send(
            `/${id}`,
            "admin",
            "PUT",
            form({ published: false }, false),
          )
        ).status,
        200,
      );
      assert.equal((await send(`/${id}/file`, "student")).status, 404);
      const bad = form({ academic_year: "2027-2028" }, false);
      bad.append(
        "file",
        new Blob(["not a pdf"], { type: "application/pdf" }),
        "bad.pdf",
      );
      assert.equal((await send("", "admin", "POST", bad)).status, 400);
      const eventOnly = await send(
        "",
        "admin",
        "POST",
        form({ academic_year: "2027-2028", published: true, events }, false),
      );
      assert.equal(eventOnly.status, 200, await eventOnly.clone().text());
      const eventOnlyId = (await eventOnly.json()).calendar_id;
      assert.equal((await send(`/${eventOnlyId}/file`, "student")).status, 404);
      const studentRecords = (await (await send("", "student")).json()).records;
      assert.equal(
        studentRecords.find((record) => record.calendar_id === eventOnlyId)
          .events[0].description,
        events[0].description,
      );
      const multiple = form({ academic_year: "2028-2029", published: true });
      multiple.append("file", new Blob(["%PDF-1.4 second page"], { type: "application/pdf" }), "page2.pdf");
      const multiSaved = await send("", "admin", "POST", multiple);
      assert.equal(multiSaved.status, 200, await multiSaved.clone().text());
      const multiId = (await multiSaved.json()).calendar_id;
      const savedList = (await (await send("", "student")).json()).records;
      assert.equal(savedList.find((row) => row.calendar_id === multiId).documents.length, 2);
      assert.equal(await (await send(`/${multiId}/file?index=1`, "student")).text(), "%PDF-1.4 second page");
      const multiImported = await send(`/${multiId}/extract`, "super_admin", "POST");
      assert.equal(multiImported.status, 200);
      assert.equal((await multiImported.json()).events.length, 1, "same activities across documents are merged");
      const multiDirect = form();
      multiDirect.append("file", new Blob(["%PDF-1.4 another page"], { type: "application/pdf" }), "another.pdf");
      const multiExtracted = await send("/extract", "admin", "POST", multiDirect);
      assert.equal(multiExtracted.status, 200);
      assert.equal((await multiExtracted.json()).events.length, 1);
      await send(`/${multiId}`, "admin", "PUT", form({ academic_year: "2028-2029", published: false }, false));
      assert.equal((await send(`/${multiId}/file?index=1`, "student")).status, 404);
      assert.equal((await send(`/${multiId}/file?index=1`, "admin")).status, 200);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await connection.query("DROP DATABASE IF EXISTS ??", [schema]);
      await connection.end();
      await defaultPool.end();
    }
  },
);

test("academic calendar accepts the JPE extension for JPEG images", () => {
  assert.equal(
    calendarFile({
      originalname: "calendar.jpe",
      buffer: Buffer.from([255, 216, 255, 224]),
    }).mime_type,
    "image/jpeg",
  );
  assert.throws(() =>
    calendarFile({
      originalname: "calendar.jpe",
      buffer: Buffer.from("invalid image"),
    }),
  );
});
