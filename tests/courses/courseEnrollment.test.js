import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/controllers/courseController.js", import.meta.url),
  "utf8",
);
function handlerSource(name, nextName) {
  return source
    .slice(
      source.indexOf(`export async function ${name}(`),
      source.indexOf(`export async function ${nextName}(`),
    )
    .replace("export ", "");
}

function harness({
  existing = null,
  found = true,
  emailFails = false,
  insertFails = false,
} = {}) {
  const queries = [];
  const emails = [];
  const notifications = [];
  const course = {
    id: 42,
    title: "Understanding the Self",
    code: "PB-SELF",
    professor_id: 11,
  };
  let enrollment = existing;
  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    cleanText: (value) => String(value || "").trim(),
    getCourseIdColumn: async () => "id",
    getCourseId: (row) => row.id,
    wantsCourseSummary: (req) => req.query?.summaryOnly === "true",
    getCourseSelect: () => "c.*",
    getCourseLearningModules: async (ids) => {
      assert.deepEqual(Array.from(ids), [42]);
      return new Map([["42", [{ title: "Module" }]]]);
    },
    rowToCourse: (row, modules) => ({ ...row, modules }),
    db: {
      execute: async (sql, args) => {
        queries.push({ sql, args: Array.from(args) });
        if (/FROM courses c/.test(sql)) return [found ? [course] : []];
        if (/FROM users/.test(sql)) {
          return [
            [
              args[0] === 11
                ? {
                    userId: 11,
                    display_name: "Assigned Professor",
                    email: "professor@example.test",
                  }
                : {
                    userId: 7,
                    display_name: "Student",
                    email: "student@example.test",
                  },
            ],
          ];
        }
        if (/SELECT \*/.test(sql) && /FROM course_enrollments/.test(sql)) {
          return [enrollment ? [enrollment] : []];
        }
        if (/INSERT INTO course_enrollments/.test(sql)) {
          if (insertFails) throw new Error("Database unavailable");
          enrollment = { enrollment_id: 23, status: "pending", archived: 0 };
          return [{ insertId: 23 }];
        }
        if (/UPDATE course_enrollments/.test(sql)) {
          enrollment = { ...enrollment, status: "pending", archived: 0 };
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
    sendEnrollmentRequestEmail: async (...args) => {
      emails.push(args);
      if (emailFails) throw new Error("Email unavailable");
    },
    createNotification: async (notification) =>
      notifications.push(notification),
    logAuditFromRequest: async () => {},
  });
  vm.runInContext(
    handlerSource("enrollCourse", "getCourseEnrollments") +
      handlerSource("joinCourseByCode", "getLearningModules") +
      ";this.handlers = { enrollCourse, joinCourseByCode };",
    context,
  );

  async function run({
    lookup = false,
    user = { userId: 7 },
    body = {},
    query = {},
  } = {}) {
    const response = {
      code: 200,
      status(code) {
        this.code = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
    };
    await context.handlers[lookup ? "joinCourseByCode" : "enrollCourse"](
      { user, body: { courseCode: " pb-self ", ...body }, query },
      response,
    );
    return response;
  }

  return { run, queries, emails, notifications };
}

test("a new code request stays pending and notifies the assigned professor", async () => {
  const h = harness();
  const response = await h.run({ body: { userId: 999, professorId: 999 } });
  assert.equal(response.code, 201);
  assert.equal(response.body.pending, true);
  assert.equal(response.body.enrolled, false);
  assert.equal(response.body.enrollmentId, 23);
  assert.deepEqual(h.queries[0].args, ["PB-SELF", "PB-SELF"]);
  const insert = h.queries.find(({ sql }) =>
    /INSERT INTO course_enrollments/.test(sql),
  );
  assert.deepEqual(insert.args, [42, 7]);
  assert.match(insert.sql, /'pending', NULL, 0/);
  assert.deepEqual(h.emails, [
    [
      "professor@example.test",
      "Assigned Professor",
      "Student",
      "Understanding the Self",
    ],
  ]);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].recipientUserId, 11);
  assert.equal(h.notifications[0].courseId, 42);
  assert.equal(h.notifications[0].enrollmentId, 23);
  assert.equal(h.notifications[0].type, "enrollment_request");
});

test("repeated requests report pending without inserting or notifying twice", async () => {
  const h = harness();
  await h.run();
  const response = await h.run();
  assert.equal(response.code, 409);
  assert.equal(response.body.status, "pending");
  assert.match(response.body.message, /already pending approval/);
  assert.equal(h.queries.filter(({ sql }) => /INSERT/.test(sql)).length, 1);
  assert.equal(h.emails.length, 1);
  assert.equal(h.notifications.length, 1);
});

test("approved students are told they are already enrolled without a new request", async () => {
  const h = harness({
    existing: { enrollment_id: 18, status: "approved", archived: 0 },
  });
  const response = await h.run();
  assert.equal(response.code, 409);
  assert.equal(response.body.status, "approved");
  assert.equal(
    response.body.message,
    "You are already enrolled in this course.",
  );
  assert.equal(
    h.queries.some(({ sql }) => /INSERT|UPDATE/.test(sql)),
    false,
  );
  assert.equal(h.emails.length, 0);
  assert.equal(h.notifications.length, 0);
});

test("declined and archived requests reuse their enrollment ID when notifying", async () => {
  for (const existing of [
    { enrollment_id: 18, status: "declined", archived: 0 },
    { enrollment_id: 19, status: "approved", archived: 1 },
  ]) {
    const h = harness({ existing });
    const response = await h.run();
    assert.equal(response.code, 201);
    assert.equal(response.body.pending, true);
    assert.equal(response.body.enrollmentId, existing.enrollment_id);
    assert.equal(h.notifications[0].enrollmentId, existing.enrollment_id);
    assert.deepEqual(h.queries.find(({ sql }) => /UPDATE/.test(sql)).args, [
      existing.enrollment_id,
    ]);
    assert.equal(
      h.queries.some(({ sql }) => /INSERT/.test(sql)),
      false,
    );
  }
});

test("email failure preserves the request and the in-app professor notification", async () => {
  const h = harness({ emailFails: true });
  const response = await h.run();
  assert.equal(response.code, 201);
  assert.equal(response.body.pending, true);
  assert.equal(response.body.emailSent, false);
  assert.equal(h.notifications.length, 1);
  assert.match(response.body.message, /Waiting for professor approval/);
});

test("invalid codes and database failures never claim enrollment or send notifications", async () => {
  for (const options of [{ found: false }, { insertFails: true }]) {
    const h = harness(options);
    const response = await h.run();
    assert.equal(response.code, options.found === false ? 404 : 500);
    assert.equal(response.body.success, false);
    assert.equal(h.emails.length, 0);
    assert.equal(h.notifications.length, 0);
  }
});

test("enrollment requires an authenticated account and a code or ID", async () => {
  const h = harness();
  assert.equal((await h.run({ user: null, body: { userId: 999 } })).code, 401);
  assert.equal((await h.run({ body: { courseCode: " " } })).code, 400);
  assert.equal(h.queries.length, 0);
});

test("code lookup is read-only and supports summary and full-course results", async () => {
  for (const summaryOnly of ["true", "false"]) {
    const h = harness();
    const response = await h.run({ lookup: true, query: { summaryOnly } });
    assert.equal(response.code, 200);
    assert.equal(response.body.course.id, 42);
    assert.equal(
      response.body.course.modules.length,
      summaryOnly === "true" ? 0 : 1,
    );
    assert.equal(h.queries.length, 1);
    assert.equal(h.emails.length, 0);
    assert.equal(h.notifications.length, 0);
  }
});
