import test from "node:test";
import assert from "node:assert/strict";
import { syllabusFilePath } from "../../src/services/catalog/syllabusStorage.js";
import {
  generateCatalogModule,
  runCatalogLessons,
} from "../../src/services/catalog/catalogLessonGeneration.js";

const storageName = `${"a".repeat(36)}.pdf`;

test("module lessons use reviewed title, remain marked as drafts and reject empty AI output", async () => {
  const module = { title: "Introduction to Programming", source_page: 4 };
  const result = await generateCatalogModule(
    { code: "DCIT24A", title: "Programming", description: "Basics" },
    module,
    async (request) => {
      assert.equal(request.data.module_title, module.title);
      return {
        description: "Introduction",
        learning_objectives: "Explain variables",
        topics: ["Variables"],
        lesson_pages: [
          { title: "Variables", content: "A variable stores a value." },
        ],
        quiz_items: Array.from({ length: 5 }, (_, i) => ({
          question: `Question ${i + 1}`,
          type: "multiple_choice",
          options: ["A", "B", "C", "D"],
          correct_answer: "A",
          explanation: "Explanation",
        })),
      };
    },
  );
  assert.equal(result.generated_draft, true);
  assert.equal(result.title, module.title);
  assert.equal(module.lesson_pages, undefined);
  assert.equal(result.lesson_pages.length, 1);
  assert.equal(result.quiz_items.length, 5);
  await assert.rejects(
    generateCatalogModule({}, module, async () => ({ lesson_pages: [] })),
    /incomplete/,
  );
});

function moduleDraft() {
  return {
    description: "Introduction",
    learning_objectives: "Explain variables",
    topics: ["Variables"],
    lesson_pages: [
      { title: "Variables", content: "A variable stores a value." },
    ],
    quiz_items: Array.from({ length: 5 }, (_, index) => ({
      question: `Question ${index + 1}`,
      type: "multiple_choice",
      options: ["Value", "Loop", "Function", "Class"],
      correct_answer: "Value",
      explanation: "A variable stores a value.",
    })),
  };
}

for (const defect of ["question", "options", "labels"]) {
  test(`catalog quiz repairs duplicate ${defect} before returning a draft`, async () => {
    let calls = 0;
    const result = await generateCatalogModule(
      {},
      { title: "Variables" },
      async (request) => {
        calls++;
        const draft = moduleDraft();
        if (calls === 1) {
          if (defect === "question")
            draft.quiz_items[1].question = " QUESTION 1? ";
          else
            draft.quiz_items[0].options =
              defect === "labels"
                ? ["A. Value", " B) value ", "Function", "Class"]
                : ["Value", "Value", "Function", "Class"];
          draft.quiz_items[0].correct_answer = draft.quiz_items[0].options[0];
        } else {
          assert.match(
            request.data.correction,
            /Duplicate quiz question|four distinct nonempty options/,
          );
          assert.equal(request.data.previous_quiz_items.length, 5);
        }
        return draft;
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.quiz_items.length, 5);
    assert.equal(
      new Set(result.quiz_items.map((item) => item.question)).size,
      5,
    );
    assert.deepEqual(result.quiz_items[0].options, [
      "Value",
      "Loop",
      "Function",
      "Class",
    ]);
  });
}

test("catalog quiz stops after three duplicate drafts and propagates provider errors", async () => {
  let calls = 0;
  await assert.rejects(
    generateCatalogModule({}, {}, async () => {
      calls++;
      const draft = moduleDraft();
      draft.quiz_items[1] = draft.quiz_items[0];
      return draft;
    }),
    /after two repair attempts.*Duplicate quiz question/,
  );
  assert.equal(calls, 3);
  calls = 0;
  const unavailable = Object.assign(new Error("Unavailable"), {
    statusCode: 503,
  });
  await assert.rejects(
    generateCatalogModule({}, {}, async () => {
      calls++;
      throw unavailable;
    }),
    (error) => error === unavailable,
  );
  assert.equal(calls, 1);
});

test("catalog worker never persists an exhausted duplicate quiz", async () => {
  const writes = [];
  let transactions = 0,
    calls = 0;
  const connection = {
    query: async (sql) =>
      sql.includes("GET_LOCK")
        ? [[{ acquired: 1 }]]
        : sql.includes("RELEASE_LOCK")
          ? [[{ released: 1 }]]
          : [
              [
                {
                  version_id: 1,
                  storage_name: storageName,
                  coverage_modules: JSON.stringify([{ title: "Variables" }]),
                },
              ],
            ],
    execute: async (sql, args) => {
      writes.push({ sql, args });
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => {
      transactions++;
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  await runCatalogLessons(
    { getConnection: async () => connection },
    async ({ data }) => {
      assert.deepEqual(data.syllabus_excerpts, []);
      calls++;
      const draft = moduleDraft();
      draft.quiz_items[1] = draft.quiz_items[0];
      return draft;
    },
    async () => {
      throw Object.assign(new Error("No searchable text found."), {
        statusCode: 422,
      });
    },
  );
  assert.equal(calls, 3);
  assert.equal(transactions, 0);
  assert.ok(
    !writes.some((write) => write.sql.includes("UPDATE syllabus_versions")),
  );
  const failed = writes.find((write) => write.sql.includes("status='failed'"));
  assert.ok(failed);
  assert.match(failed.args[0], /Duplicate quiz question/);
});

test("catalog worker retrieves per-module PDF context once per version and keeps it during repair", async () => {
  const writes = [];
  let calls = 0,
    commits = 0,
    reads = 0;
  const variables = "Variables\nConstants, values and assignment expressions.";
  const recursion = "Recursion\nBase cases and recursive calls.";
  const connection = {
    query: async (sql) =>
      sql.includes("GET_LOCK")
        ? [[{ acquired: 1 }]]
        : sql.includes("RELEASE_LOCK")
          ? [[{ released: 1 }]]
          : [
              [
                {
                  version_id: 1,
                  storage_name: storageName,
                  coverage_modules: JSON.stringify([
                    { title: "Variables", source_page: 4 },
                    { title: "Recursion", source_page: 9 },
                  ]),
                },
              ],
            ],
    execute: async (sql, args) => {
      writes.push({ sql, args });
      return [{ affectedRows: 1 }];
    },
    beginTransaction: async () => {},
    commit: async () => {
      commits++;
    },
    rollback: async () => {},
    release: () => {},
  };
  await runCatalogLessons(
    { getConnection: async () => connection },
    async ({ data }) => {
      calls++;
      const expectedPage = data.module_title === "Variables" ? 4 : 9;
      assert.deepEqual(
        data.syllabus_excerpts.map(({ page }) => page),
        [expectedPage],
      );
      assert.match(
        data.syllabus_excerpts[0].text,
        expectedPage === 4 ? /assignment expressions/ : /Base cases/,
      );
      const draft = moduleDraft();
      if (calls === 1) draft.quiz_items[1] = draft.quiz_items[0];
      return draft;
    },
    async (file) => {
      reads++;
      assert.deepEqual(file, {
        originalname: storageName,
        path: syllabusFilePath(storageName),
      });
      return {
        text: `${variables}\n\n${recursion}`,
        positions: [
          { start: 0, end: variables.length, page: 4 },
          {
            start: variables.length + 2,
            end: variables.length + 2 + recursion.length,
            page: 9,
          },
        ],
      };
    },
  );
  assert.equal(calls, 3);
  assert.equal(commits, 2);
  assert.equal(reads, 1);
  const saved = JSON.parse(
    writes.findLast((write) => write.sql.includes("UPDATE syllabus_versions"))
      .args[0],
  );
  assert.equal(saved[0].quiz_items.length, 5);
  assert.equal(
    new Set(saved[0].quiz_items.map((item) => item.question)).size,
    5,
  );
  assert.equal(saved[0].source_page, 4);
  assert.equal(saved[0].generated_draft, true);
  assert.equal(saved[1].quiz_items.length, 5);
  assert.ok(writes.some((write) => write.sql.includes("status='completed'")));
});
