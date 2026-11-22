import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { PGlite } from "@electric-sql/pglite";
import { createDatabase, db } from "../../src/database/postgres.js";
import {
  createAcademicWorkflow,
  object,
  array,
  string,
} from "../../src/services/rag/academicWorkflow.js";
import {
  extractSyllabus,
  coverageHeadings,
} from "../../src/services/catalog/syllabusExtraction.js";
import { generateReviewedMainQuiz } from "../../src/services/quizzes/mainQuizGeneration.js";
import {
  startMainQuiz,
  submitMainQuiz,
  mainQuizStatus,
  mainQuizAnalysis,
  savedLessonChunks,
} from "../../src/services/quizzes/mainQuizService.js";
import { migrateApplication } from "../../src/migrations/applicationMigration.js";
import {
  mainQuizFromHistory,
  validateMainSettings,
  gradeMainQuiz,
} from "../../src/services/quizzes/mainQuizAdaptive.js";
import { migrateAcademicWorkflows } from "../../src/migrations/academicWorkflows.js";
import {
  belongsToModule,
  lessonModuleScope,
  selectedLessonSources,
} from "../../src/services/rag/lessonModuleScope.js";
import { generateFromDocuments } from "../../src/services/rag/lessonRagService.js";
import {
  enqueueJob,
  claimJob,
  runClaimedJob,
  loadJob,
} from "../../src/services/rag/lessonJobService.js";
import {
  removePrivateFile,
  drainFileDeletions,
} from "../../src/services/rag/sourceLifecycleService.js";
import { extractText } from "../../src/services/rag/extractText.js";
import {
  makePdf,
  makePpt,
  makePptx,
  makeDocx,
} from "../helpers/fixtureBuilders.js";

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  });
}

async function testDatabase(t) {
  const engine = new PGlite();
  await engine.exec(
    "CREATE SCHEMA puffybrain; SET search_path=puffybrain,public",
  );
  const query = (...args) => engine.query(...args);
  const original = { ...db };
  Object.assign(
    db,
    createDatabase({ query, connect: async () => ({ query, release() {} }) }),
  );
  t.after(async () => {
    Object.assign(db, original);
    await engine.close();
  });
  setEnv(t, "SUPER_ADMIN_PASSWORD", "");
  await migrateApplication();
}

for (const [workflow, variable] of [
  ["syllabus", "SYLLABUS_AI_PRIMARY"],
  ["organize", "ORGANIZE_MODULE_AI_PRIMARY"],
  ["main", "MAIN_QUIZ_AI_PRIMARY"],
]) {
  test(
    workflow +
      " independently selects primary, falls back on unusable output, and reserves time",
    async (t) => {
      const request = { schema: object({ items: array(string) }), data: {} };
      for (const [order, primary, second] of [
        [null, "openai", "gemini"],
        ["gemini", "gemini", "openai"],
      ]) {
        setEnv(t, variable, order);
        const calls = [];
        const session = createAcademicWorkflow(workflow, {
          deadlineAt: Date.now() + 30_000,
          send: {
            [primary]: async (r) => {
              calls.push(primary);
              assert.ok(r.deadlineAt < session.deadline - 1000);
              return { items: "invalid" };
            },
            [second]: async (r) => {
              calls.push(second);
              assert.ok(r.timeoutMs > 0);
              return { items: ["ok"] };
            },
          },
        });
        await session.call("generation", request);
        await session.call("review", request);
        assert.deepEqual(calls, [primary, second, second]);
        assert.throws(
          () =>
            createAcademicWorkflow(workflow, {
              deadlineAt: Date.now() - 1,
            }).left(),
          { code: "GENERATION_TIMEOUT" },
        );
      }
    },
  );
}

test("provider availability errors trigger the secondary and two unavailable providers end the operation", async (t) => {
  setEnv(t, "MAIN_QUIZ_AI_PRIMARY", "openai");
  const request = { data: {}, schema: object({ items: array(string) }) };
  for (const code of [
    "PROVIDER_BILLING",
    "PROVIDER_RATE_LIMIT",
    "PROVIDER_REQUEST_TIMEOUT",
    "PROVIDER_NETWORK",
    "PROVIDER_UNAVAILABLE",
  ]) {
    const calls = [];
    const failed = async () => {
      calls.push("openai");
      throw Object.assign(new Error("Fixture"), { code });
    };
    const session = createAcademicWorkflow("main", {
      send: {
        openai: failed,
        gemini: async () => {
          calls.push("gemini");
          return { items: ["ok"] };
        },
      },
    });
    await session.call("generation", request);
    assert.deepEqual(calls, ["openai", "gemini"]);
    const outage = createAcademicWorkflow("main", {
      send: { openai: failed, gemini: failed },
    });
    await assert.rejects(outage.call("generation", request), {
      statusCode: 503,
      code: "ACADEMIC_PROVIDERS_UNAVAILABLE",
    });
  }
});

test("real CvSU PDF retains ordered Roman modules, lettered topics, source references, N/A and outcomes; only the rejected summary is repaired", async (t) => {
  setEnv(t, "SYLLABUS_AI_PRIMARY", "openai");
  const pdf = makePdf(
    [
      "Cavite State University",
      "COURSE SYLLABUS",
      "2nd Semester, AY 2025-2026",
      "Course Code: DCIT 24",
      "Course Title: Databases",
      "Credit Units: 3",
      "Course Description: Introduction to data.",
      "Pre-requisites: None",
      "Course Outcomes",
      "Explain data organization.",
      "COURSE COVERAGE",
      "II. Introduction to Database",
      "Description: Data sources and approaches.",
      "A. File Systems",
      "B. Database Approach",
      "III. Database Environment",
      "A. Database Languages",
      "B. DBMS Functions",
      "References & Supplementary Materials",
      "Required Textbook/Workbook: N/A",
      "Electronic References",
      "https://example.edu/catalog/db",
      "Revision History",
    ].join("\n"),
  );
  const generated = [],
    reviewed = [],
    fieldDrafts = [];
  const send = async ({ data, schema }) => {
    if (data.fields) {
      if (schema.properties.verdicts)
        return {
          verdicts: data.fields.map((f) => ({
            id: f.id,
            supported: true,
            reason: "Matches source.",
          })),
        };
      fieldDrafts.push(data.fields.map((f) => f.label));
      return {
        items: data.fields.map((f) => ({
          id: f.id,
          entries:
            f.label === "Electronic References" && fieldDrafts.length === 1
              ? ["https://invented.example"]
              : f.values,
        })),
      };
    }
    if (schema.properties.verdicts) {
      reviewed.push(data.items.map((s) => s.id));
      return {
        verdicts: data.items.map((s) => ({
          id: s.id,
          supported: s.id === 1 || reviewed.length > 1,
          reason: "Remove the unsupported topic.",
        })),
      };
    }
    generated.push(data.modules.map((s) => s.id));
    if (generated.length > 1)
      assert.match(data.modules[0].rejection, /unsupported/);
    return {
      items: data.modules.map((m) => ({
        id: m.id,
        topics: m.topics,
        objectives: [],
        description:
          "Expected coverage includes " + m.topics.join(" and ") + ".",
      })),
    };
  };
  const result = await extractSyllabus(pdf, {
    workflowOptions: { send: { openai: send, gemini: send } },
  });
  assert.deepEqual(generated, [[1, 2], [2]]);
  assert.deepEqual(reviewed, generated);
  assert.deepEqual(fieldDrafts[1], ["Electronic References"]);
  assert.deepEqual(
    result.coverage_modules.map((m) => m.topics),
    [
      ["File Systems", "Database Approach"],
      ["Database Languages", "DBMS Functions"],
    ],
  );
  assert.equal(result.coverage_modules[1].context_kind, "topic_based_summary");
  assert.equal(
    result.coverage_modules[0].syllabus_description,
    "Data sources and approaches.",
  );
  assert.equal(result.code, "DCIT 24");
  assert.equal(result.title, "Databases");
  assert.deepEqual(result.course_outcomes, ["Explain data organization."]);
  assert.deepEqual(
    result.references.map((g) => g.entries[0].text),
    ["N/A", "https://example.edu/catalog/db"],
  );
  assert.equal(result.references[1].entries[0].source_page, 1);
  await assert.rejects(
    extractSyllabus(
      makePdf(
        "Another university\nCOURSE SYLLABUS\nCourse Code: DCIT 24\nCourse Title: Databases",
      ),
    ),
    { code: "INVALID_SYLLABUS" },
  );
});

test("positioned outcome cells stay with the correct module and assessment text is excluded", () => {
  const item = (str, x, y, width = 60) => ({
    str,
    width,
    transform: [10, 0, 0, 10, x, y],
  });
  const modules = coverageHeadings(
    [
      {
        num: 3,
        width: 840,
        height: 595,
        items: [
          item("COURSE COVERAGE", 360, 540),
          item("Intended Learning", 100, 500),
          item("Topic", 282, 500, 27),
          item("Teaching and", 393, 500),
          item("II. Tables", 230, 430),
          item("Identify a column.", 100, 430),
          item("A. Columns", 240, 410),
          item("Assessment task", 550, 410),
          item("III. Keys", 230, 360),
          item("Explain key constraints.", 100, 360),
          item("A. Foreign Keys", 240, 340),
        ],
      },
    ],
    true,
  );
  assert.deepEqual(
    modules.map((m) => m.objective_lines),
    [["Identify a column."], ["Explain key constraints."]],
  );
  assert.deepEqual(
    modules.map((m) => m.topics),
    [["Columns"], ["Foreign Keys"]],
  );
  const sameTitle = coverageHeadings(
    [
      {
        num: 1,
        width: 500,
        height: 800,
        items: [
          item("COURSE COVERAGE", 20, 700),
          item("II. Models", 20, 670),
          item("A. First example", 20, 650),
          item("III. Models", 20, 610),
          item("A. Second example", 20, 590),
        ],
      },
    ],
    true,
  );
  assert.deepEqual(
    sameTitle.map((m) => m.topics),
    [["First example"], ["Second example"]],
  );
});

test("all five instructional formats supply text independently of syllabus recognition", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "academic-formats-"),
  );
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const phrase = "Cells store one attribute value.";
  for (const [ext, bytes] of [
    ["txt", phrase],
    ["pdf", makePdf(phrase)],
    ["docx", makeDocx([phrase])],
    ["pptx", makePptx([phrase])],
    ["ppt", makePpt([phrase])],
  ]) {
    const name = "lesson." + ext,
      file = path.join(directory, name);
    await fs.writeFile(file, bytes);
    assert.ok(
      (await extractText({ originalname: name, path: file })).text.includes(
        phrase,
      ),
      name,
    );
  }
  const empty = path.join(directory, "empty.txt");
  await fs.writeFile(empty, "");
  await assert.rejects(
    extractText({ originalname: "empty.txt", path: empty }),
    { statusCode: 422 },
  );
});

const settings = {
  questionCount: 20,
  multipleChoiceCount: 10,
  identificationCount: 5,
  trueFalseCount: 5,
  passingPercentage: 70,
  topics: ["Tables"],
  learningObjectives: "Interpret table structure.",
  lessonTitle: "Data models",
};
const assignment = (i) => ({
  topic: "Tables",
  type: i < 10 ? "multiple_choice" : i < 15 ? "identification" : "true_false",
  thinking_skill: i % 2 ? "HOTS" : "LOTS",
  cognitive_level: i % 2 ? "Analyze" : "Remember",
  learning_objective: settings.learningObjectives,
});

test("Main Quiz retains 18 approvals, repairs only two fixed TOS slots, independently checks Gemini replacements", async (t) => {
  setEnv(t, "MAIN_QUIZ_AI_PRIMARY", "openai");
  const blueprint = {
    slots: Array.from({ length: 20 }, (_, i) => assignment(i)),
  };
  const chunks = [
    {
      chunk_id: 71,
      document_id: 2,
      chunk_text:
        "Rows hold records and columns hold attributes. Keys distinguish records.",
      source_filename: "Approved tables lesson",
    },
  ];
  const draftCalls = [],
    reviewCalls = [],
    revisions = new Map();
  function provider(name) {
    return async ({ schema, data }) => {
      const ids = data.items.map((s) => s.id);
      if (schema.properties.verdicts) {
        reviewCalls.push([name, ids]);
        return {
          verdicts: data.items.map((s) => ({
            id: s.id,
            supported: s.id < 19 || name === "gemini",
            reason: "The explanation lacks support in the cited sentence.",
          })),
        };
      }
      draftCalls.push([name, ids]);
      return {
        items: data.items.map((s) => {
          if (s.rejection) assert.match(s.rejection, /lacks support/);
          assert.equal(s.evidence[0].filename, "Approved tables lesson");
          const n = (revisions.get(s.id) || 0) + 1;
          revisions.set(s.id, n);
          const choices =
            s.type === "multiple_choice"
              ? ["Rows", "Pages", "Files", "Books"]
              : s.type === "true_false"
                ? ["True", "False"]
                : [];
          return {
            ...s,
            question: `Interpret relation ${s.id} variant ${n}?`,
            options: choices,
            correct_answer: choices[0] || "Rows",
            explanation: "Rows hold records.",
            evidence_ids: [s.evidence[0].evidence_id],
          };
        }),
      };
    };
  }
  const result = await generateReviewedMainQuiz(
    settings,
    blueprint,
    chunks,
    ["An earlier Practice item?"],
    { send: { openai: provider("openai"), gemini: provider("gemini") } },
  );
  assert.equal(result.length, 20);
  assert.ok(result.every((q) => q.grounding.model_review_passed));
  assert.ok(
    result.slice(0, 18).every((q) => q.question.endsWith("variant 1?")),
  );
  assert.deepEqual(draftCalls.at(-1), ["gemini", [19, 20]]);
  assert.deepEqual(reviewCalls, draftCalls);
  assert.deepEqual(
    result.map((q) => [
      q.topic,
      q.type,
      q.cognitive_level,
      q.learning_objective,
    ]),
    blueprint.slots.map((q) => [
      q.topic,
      q.type,
      q.cognitive_level,
      q.learning_objective,
    ]),
  );
  assert.equal(
    gradeMainQuiz(
      result,
      result.map((q) => q.correct_answer),
      70,
    ).requiredCorrect,
    14,
  );
});

test("duplicates, absent lesson evidence and incomplete review never become approved questions", async () => {
  const slot = assignment(0),
    chunks = [
      {
        chunk_id: 3,
        document_id: 1,
        chunk_text: "Columns describe the attributes of a relation.",
      },
    ];
  for (const defect of ["duplicate", "evidence", "verdict"]) {
    const send = async ({ data, schema }) =>
      schema.properties.verdicts
        ? { verdicts: [] }
        : {
            items: [
              {
                ...slot,
                id: 1,
                question: "Which field describes an attribute?",
                options: ["A", "B", "C", "D"],
                correct_answer: "A",
                explanation: "Columns describe attributes.",
                evidence_ids: [
                  defect === "evidence"
                    ? "elsewhere"
                    : data.items[0].evidence[0].evidence_id,
                ],
              },
            ],
          };
    await assert.rejects(
      generateReviewedMainQuiz(
        settings,
        { slots: [slot] },
        chunks,
        defect === "duplicate" ? ["Which field describes an attribute?"] : [],
        { send: { openai: send, gemini: send } },
      ),
      { code: "ACADEMIC_VALIDATION_FAILED" },
    );
  }
});

test("personalization keeps professor TOS, considers repeated scored difficulties, and permits baseline", () => {
  const fixed = Array.from({ length: 20 }, (_, i) => assignment(i));
  const config = { ...settings, tosSlots: fixed };
  const answer = {
    topic: "Tables",
    cognitive_level: "Remember",
    concept: "Keys",
    isCorrect: false,
    question: "Earlier item",
  };
  const attempt = (id, rows) => ({
    attempts_id: id,
    total: rows.length,
    answers_json: rows,
  });
  const history = [
    attempt(3, [{ ...answer, isSelfAssessed: true }]),
    attempt(2, [answer]),
    attempt(1, [{ ...answer, question: "Another item" }]),
  ];
  const adaptive = mainQuizFromHistory(config, history);
  assert.equal(adaptive.practiceAttemptId, 2);
  assert.equal(adaptive.blueprint.slots[0].focus, "Keys");
  assert.deepEqual(
    adaptive.blueprint.slots.map((s) => s.type),
    fixed.map((s) => s.type),
  );
  assert.equal(
    mainQuizFromHistory(config, history.slice(0, 2)).blueprint.slots[0].focus,
    undefined,
  );
  assert.equal(mainQuizFromHistory(config, []).blueprint.mode, "baseline");
  assert.throws(
    () =>
      validateMainSettings({
        question_count: 1,
        identification_count: 1,
        multiple_choice_count: 0,
        true_false_count: 0,
        tos_slots: [assignment(0)],
      }),
    /TOS/,
  );
});

test("a cleared professor page contributes no evidence, while historical saved quotations remain readable", () => {
  const quote = "A saved quotation about relationships.";
  const page = { moduleId: "a", source_chunks: [{ quote }] };
  assert.deepEqual(
    savedLessonChunks(
      [
        { ...page, content: "" },
        { ...page, moduleId: "b" },
      ],
      "a",
    ),
    [],
  );
  assert.equal(savedLessonChunks([page], "a")[0].chunk_text, quote);
  assert.equal(
    savedLessonChunks(
      [{ ...page, content: "My edited lesson about rows." }],
      "a",
    )[0].chunk_text,
    "My edited lesson about rows.",
  );
});

test("a real PostgreSQL student start uses only this module's Practice, serves a private snapshot, scores once and respects a closed schedule", async (t) => {
  await testDatabase(t);
  setEnv(t, "OPENAI_API_KEY", "offline-fixture");
  setEnv(t, "MAIN_QUIZ_AI_PRIMARY", "openai");
  const [userRow] = await db.execute(
    "INSERT INTO users(name,email,password,role,is_verified) VALUES('Student','main@example.test','fake','student',1)",
  );
  const user = { role: "student", userId: userRow.insertId };
  const page = {
    moduleId: "this",
    moduleIndex: 0,
    moduleTitle: "Data models",
    topic: "Tables",
    content: "Rows hold records and columns hold attributes.",
    mainQuizSettings: { enabled: true },
  };
  const [course] = await db.execute(
    "INSERT INTO courses(title,code,summary,subject,lesson_pages) VALUES('Data','DBTEST','','Data',?)",
    [
      JSON.stringify([
        page,
        {
          ...page,
          moduleId: "another",
          content: "Other module content is private.",
        },
      ]),
    ],
  );
  const courseId = course.insertId,
    body = { course_id: courseId, module_id: "this" };
  await db.execute(
    "INSERT INTO course_enrollments(course_id,user_id,status) VALUES(?,?,'approved')",
    [courseId, user.userId],
  );
  const config = {
    ...settings,
    questionCount: 1,
    multipleChoiceCount: 0,
    identificationCount: 1,
    trueFalseCount: 0,
    moduleIndex: 0,
    tosSlots: [{ ...assignment(0), type: "identification" }],
  };
  await db.execute(
    "INSERT INTO main_quiz_configs(course_id,module_id,config_json) VALUES(?,?,?)",
    [courseId, "this", JSON.stringify(config)],
  );
  const lastPractice = new Map();
  async function practice(moduleId, question, concept) {
    const answers = [
      {
        question,
        concept,
        topic: "Tables",
        cognitive_level: "Remember",
        isCorrect: false,
      },
    ];
    const [attempt] = await db.execute(
      "INSERT INTO quiz_attempts(user_id,course_id,total,quiz_mode) VALUES(?,?,1,'qna')",
      [user.userId, courseId],
    );
    await db.execute(
      "INSERT INTO quiz_attempt_details(attempts_id,assessment_type,module_index,answers_json) VALUES(?,'practice',0,?)",
      [attempt.insertId, JSON.stringify(answers)],
    );
    const [history] = await db.execute(
      "INSERT INTO module_practice_attempts(user_id,course_id,module_id,previous_attempt_id,questions_json,result_json) VALUES(?,?,?,?,'[]',?)",
      [
        user.userId,
        courseId,
        moduleId,
        lastPractice.get(moduleId) || 0,
        JSON.stringify({ answers }),
      ],
    );
    lastPractice.set(moduleId, history.insertId);
    return attempt.insertId;
  }
  await practice("this", "Which concept identifies one row?", "Records");
  const latest = await practice(
    "this",
    "How are attributes stored?",
    "Records",
  );
  await practice(
    "another",
    "An unrelated previously answered question?",
    "Wrong module",
  );
  let calls = 0;
  t.mock.method(axios, "post", async (url, request) => {
    assert.match(url, /api\.openai\.com/);
    const data = JSON.parse(request.messages[1].content);
    assert.doesNotMatch(
      JSON.stringify(data),
      /Wrong module|unrelated previously|Other module content/,
    );
    const slot = data.items[0];
    let output;
    if (request.response_format.json_schema.schema.properties.verdicts) {
      output = {
        verdicts: [
          {
            id: slot.id,
            supported: true,
            reason: "The page supports this answer.",
          },
        ],
      };
    } else {
      assert.equal(slot.focus, "Records");
      assert.equal(slot.type, "identification");
      assert.equal(data.previous_questions.length, 2);
      output = {
        items: [
          {
            ...slot,
            question: "What do table rows hold?",
            concept: "Records",
            options: [],
            correct_answer: "Records",
            explanation: "Rows hold records.",
            evidence_ids: [slot.evidence[0].evidence_id],
          },
        ],
      };
    }
    calls++;
    return {
      data: {
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(output) },
          },
        ],
      },
    };
  });
  const quiz = await startMainQuiz(user, body);
  assert.equal(calls, 2);
  assert.equal((await startMainQuiz(user, body)).quizId, quiz.quizId);
  assert.equal(quiz.questions[0].correct_answer, undefined);
  assert.equal(quiz.questions[0].grounding, undefined);
  assert.equal(quiz.questions[0].learning_objective, undefined);
  const [[snapshot]] = await db.execute(
    "SELECT practice_attempt_id FROM personalized_main_quizzes WHERE quiz_id=?",
    [quiz.quizId],
  );
  assert.equal(snapshot.practice_attempt_id, latest);
  const submitted = await submitMainQuiz(user, {
    quiz_id: quiz.quizId,
    answers: ["Records"],
  });
  assert.equal(submitted.score, 1);
  const [report] = await mainQuizAnalysis({ role: "admin" }, courseId, "this");
  assert.equal(report.result.score, 1);
  assert.equal(report.practiceAttemptId, latest);
  await assert.rejects(
    submitMainQuiz(user, { quiz_id: quiz.quizId, answers: [""] }),
    /already been submitted/,
  );
  await db.execute("UPDATE main_quiz_configs SET revision=revision+1");
  assert.deepEqual(await mainQuizStatus(user, courseId, "this"), {
    taken: true,
  });
  await assert.rejects(startMainQuiz(user, body), /already been submitted/);
  await assert.rejects(
    submitMainQuiz(user, { quiz_id: quiz.quizId, answers: [""] }),
    { statusCode: 409 },
  );
  const [[resultCount]] = await db.execute(
    "SELECT count(*)::int AS count FROM main_quiz_results",
  );
  assert.equal(resultCount.count, 1);
  await db.execute("UPDATE courses SET lesson_pages=? WHERE course_id=?", [
    JSON.stringify([
      {
        ...page,
        mainQuizSettings: { enabled: true, lockAt: "2000-01-01T00:00:00Z" },
      },
    ]),
    courseId,
  ]);
  await assert.rejects(startMainQuiz(user, body), /currently locked/);
  assert.equal(calls, 2);
});

test("the queued organizer combines a new handout with a saved source and retains seven approved pages while repairing the eighth", async (t) => {
  await testDatabase(t);
  setEnv(t, "OPENAI_API_KEY", "offline-fixture");
  setEnv(t, "ORGANIZE_MODULE_AI_PRIMARY", "openai");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-queue-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const topics = [
    "Rows",
    "Columns",
    "Tables",
    "Keys",
    "Records",
    "Attributes",
    "Constraints",
    "Relations",
  ];
  const facts = [
    "Rows represent individual records.",
    "Columns hold attribute values.",
    "Tables contain rows and columns.",
    "Keys distinguish individual records.",
    "Records describe individual entities.",
    "Attributes describe properties of entities.",
    "Constraints restrict allowed database values.",
    "Relations consist of tuples with shared attributes.",
  ];
  const objective = "Describe relational terminology.";
  const [professor] = await db.execute(
    "INSERT INTO users(name,email,password,role,verification_status) VALUES('Professor','organize@example.test','fake','professor','approved')",
  );
  const [course] = await db.execute(
    "INSERT INTO courses(title,code,summary,subject,professor_id,content_modules) VALUES('DB','ORGTEST','','Data',?,?)",
    [
      professor.insertId,
      JSON.stringify([
        {
          id: "this",
          title: "Databases",
          topics,
          learningObjectives: objective,
          studentPublished: false,
        },
      ]),
    ],
  );
  const courseId = course.insertId;
  const [saved] = await db.execute(
    "INSERT INTO lesson_source_documents(course_id,module_key,filename,storage_path,mime_type,file_size_bytes,content_hash,chunk_count,processing_status) VALUES(?,'this','Notes.txt','fixture','text/plain',32,?,1,'ready')",
    [courseId, "0".repeat(64)],
  );
  await db.execute(
    "INSERT INTO lesson_source_chunks(document_id,chunk_order,source_start,source_end,chunk_text,embedding,embedding_model,embedding_dimensions) VALUES(?,0,0,?,?,?,'previous-model',2)",
    [saved.insertId, facts[0].length, facts[0], "[1,0]"],
  );
  const file = {
    originalname: "New-handout.txt",
    mimetype: "text/plain",
    path: path.join(temporary, "handout.txt"),
    size: 0,
  };
  await fs.writeFile(file.path, facts.slice(1).join("\n"));
  file.size = (await fs.stat(file.path)).size;
  const scope = await lessonModuleScope(courseId, "this", null);
  const savedIds = await selectedLessonSources(
    courseId,
    scope,
    [saved.insertId],
    [file],
  );
  const drafts = [],
    reviews = [];
  t.mock.method(axios, "post", async (url, request) => {
    if (url.endsWith("/embeddings"))
      return {
        data: {
          data: request.input.map((_, index) => ({
            index,
            embedding: Array(768).fill(0.1),
          })),
        },
      };
    assert.match(url, /api\.openai\.com/);
    const fields = request.response_format.json_schema.schema.properties,
      data = JSON.parse(request.messages[1].content);
    let output;
    if (fields.topics) {
      assert.deepEqual(
        new Set(data.evidence.map((e) => e.filename)),
        new Set(["Notes.txt", "New-handout.txt"]),
      );
      output = {
        module_title: "Databases",
        subject: "Data",
        description: "Relational terms",
        learning_objectives: objective,
        excluded_chunk_ids: [],
        topics: topics.map((topic, i) => ({
          title: topic,
          syllabus_topic: topic,
          learning_objective: objective,
          key_points: [
            {
              text: facts[i],
              evidence_id: data.evidence.find((e) => e.quote.includes(facts[i]))
                .evidence_id,
            },
          ],
        })),
      };
    } else if (fields.statements) {
      const {
        title,
        key_points: [point],
      } = data.topic;
      drafts.push(title);
      if (drafts.filter((x) => x === title).length > 1)
        assert.match(data.correction, /Revise the explanation/);
      output = {
        title,
        statements: [
          {
            text: point.text,
            point_ids: [point.id],
            evidence_ids: [
              data.evidence.find((e) => e.quote.includes(point.text))
                .evidence_id,
            ],
          },
        ],
      };
    } else {
      const topic = data.syllabus_topic;
      reviews.push(topic);
      const approved =
        topic !== "Relations" || reviews.filter((x) => x === topic).length > 1;
      output = {
        verdicts: [
          {
            statement_index: 0,
            supported: approved,
            covered_point_ids: approved ? [data.key_points[0].id] : [],
            reason: approved
              ? "Supported."
              : "Revise the explanation from the supplied passage.",
          },
        ],
      };
    }
    return {
      data: {
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(output) },
          },
        ],
      },
    };
  });
  try {
    const { jobId } = await enqueueJob({
      type: "upload",
      courseId,
      requesterId: professor.insertId,
      files: [file],
      savedIds,
      moduleKey: "this",
      generationContext: scope.context,
    });
    const claimed = await claimJob();
    assert.equal(claimed.job_id, jobId);
    await runClaimedJob(claimed);
    const result = await loadJob(jobId);
    assert.equal(result.status, "completed", result.error_message);
    assert.deepEqual(
      result.result.lesson_pages.map((p) => p.syllabus_topic),
      topics,
    );
    assert.deepEqual(result.result.source_coverage.missing_topics, []);
    assert.deepEqual(
      new Set(result.result.source_coverage.consulted_sources),
      new Set(["Notes.txt", "New-handout.txt"]),
    );
    assert.deepEqual(drafts.sort(), [...topics, "Relations"].sort());
    assert.deepEqual(reviews.sort(), drafts);
    const [[unchanged]] = await db.execute(
      "SELECT content_modules FROM courses WHERE course_id=?",
      [courseId],
    );
    const modules =
      typeof unchanged.content_modules === "string"
        ? JSON.parse(unchanged.content_modules)
        : unchanged.content_modules;
    assert.equal(modules[0].studentPublished, false);
    assert.equal(modules[0].lessonPages, undefined);
  } finally {
    await drainFileDeletions();
    const [newFiles] = await db.execute(
      "SELECT storage_path FROM lesson_source_documents WHERE course_id=? AND filename='New-handout.txt'",
      [courseId],
    );
    for (const item of newFiles) await removePrivateFile(item.storage_path);
  }
});

test("PostgreSQL migration is repeatable; pinned context, scoped saved sources, retained pages and coverage survive a job retry", async (t) => {
  const engine = new PGlite();
  const query = (...args) => engine.query(...args);
  const adapter = createDatabase({
    query,
    connect: async () => ({ query, release() {} }),
  });
  const original = { ...db };
  Object.assign(db, adapter);
  t.after(async () => {
    Object.assign(db, original);
    await engine.close();
  });
  await engine.exec(`CREATE TABLE syllabus_uploads(upload_id int);
    CREATE TABLE syllabus_versions(version_id int,catalog_id int,coverage_modules jsonb);
    CREATE TABLE courses(course_id int,catalog_id int,syllabus_version_id int,content_modules jsonb,lesson_pages jsonb);
    CREATE TABLE lesson_source_documents(document_id int,course_id int,lesson_id int,filename text,processing_status text,file_size_bytes int);
    CREATE TABLE lesson_source_chunks(chunk_id int,document_id int,chunk_order int,chunk_text text,embedding_model text,embedding_dimensions int);
    INSERT INTO syllabus_versions VALUES(2,8,'[{"title":"Tables","description":"Scope","topics":["Rows","Keys"],"learning_objectives":"Explain rows."}]');
    INSERT INTO courses VALUES(1,8,2,'[{"id":"a","title":"Edited title","catalogCoverageTitle":"Tables"},{"id":"b","title":"Other"}]','[{"moduleId":"a","source_document_id":3}]');
    INSERT INTO lesson_source_documents VALUES(1,1,NULL,'notes.txt','ready',128),(2,1,NULL,'other.txt','ready',128),(3,1,NULL,'legacy.txt','ready',128),(4,2,NULL,'foreign.txt','ready',128);
    INSERT INTO lesson_source_chunks VALUES(7,1,0,'Rows contain records in a table.','old-model',3);`);
  await migrateAcademicWorkflows(db);
  await migrateAcademicWorkflows(db);
  await engine.exec(`UPDATE lesson_source_documents SET module_key='a' WHERE document_id IN (1,4);
    UPDATE lesson_source_documents SET module_key='b' WHERE document_id=2;
    UPDATE syllabus_versions SET academic_context='{"references":[{"category":"Textbook","entries":[{"text":"Listed book","source_page":4}]}]}'`);
  const scope = await lessonModuleScope(1, "a", null);
  assert.deepEqual(scope.context.topics, ["Rows", "Keys"]);
  assert.equal(scope.context.syllabus_context, "Scope");
  assert.equal(scope.context.syllabus_version_id, 2);
  assert.deepEqual(await selectedLessonSources(1, scope, [1, 3], []), [
    "1",
    "3",
  ]);
  for (const id of [2, 4])
    await assert.rejects(selectedLessonSources(1, scope, [id], []), {
      statusCode: 409,
    });
  await assert.rejects(
    selectedLessonSources(1, scope, [1], Array(10).fill({ size: 1 })),
    { statusCode: 400 },
  );
  await assert.rejects(
    selectedLessonSources(1, scope, [1], [{ size: 50 * 1024 * 1024 }]),
    { statusCode: 400 },
  );
  assert.equal(
    belongsToModule({ document_id: 3, lesson_id: null }, scope),
    true,
  );
  let drafts = 0,
    reviews = 0;
  const send = async ({ data, schema }) => {
    if (schema.properties.topics)
      return {
        module_title: "Tables",
        subject: "Databases",
        description: "Rows",
        learning_objectives: "Explain rows.",
        excluded_chunk_ids: [],
        topics: [
          {
            title: "Working with rows",
            syllabus_topic: "Rows",
            learning_objective: "Explain rows.",
            key_points: [
              {
                text: "Rows contain records.",
                evidence_id: data.evidence[0].evidence_id,
              },
            ],
          },
        ],
      };
    if (schema.properties.statements) {
      drafts++;
      return {
        title: "Rows",
        statements: [
          {
            text: "Rows contain records in a table.",
            point_ids: [data.topic.key_points[0].id],
            evidence_ids: [data.evidence[0].evidence_id],
          },
        ],
      };
    }
    reviews++;
    return {
      verdicts: [
        {
          statement_index: 0,
          supported: true,
          covered_point_ids: [data.key_points[0].id],
          reason: "Supported by the source.",
        },
      ],
    };
  };
  const state = {
    moduleKey: "a",
    session: createAcademicWorkflow("organize", {
      send: { openai: send, gemini: send },
    }),
    pageCheckpoint: {},
  };
  const checkpoint = [];
  for (let i = 0; i < 2; i++) {
    const organized = await generateFromDocuments(
      [1],
      async () => {},
      checkpoint,
      scope.context,
      state,
    );
    assert.deepEqual(organized.source_coverage.missing_topics, ["Keys"]);
    assert.deepEqual(organized.source_coverage.consulted_sources, [
      "notes.txt",
    ]);
    assert.equal(
      organized.source_coverage.syllabus_references[0].entries[0].text,
      "Listed book",
    );
    assert.equal(organized.lesson_pages[0].syllabus_topic, "Rows");
  }
  assert.deepEqual([drafts, reviews], [1, 1]);
  await assert.rejects(
    generateFromDocuments([1, 2], async () => {}, [], scope.context, state),
    { statusCode: 403 },
  );
});
