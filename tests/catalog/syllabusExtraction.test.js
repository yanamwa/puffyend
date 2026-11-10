import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSyllabus,
  validateCoverageModules,
} from "../../src/services/catalog/catalogRules.js";
import { coverageHeadings } from "../../src/services/catalog/syllabusExtraction.js";
import {
  buildSyllabusIndex,
  retrieveSyllabusExcerpts,
} from "../../src/services/catalog/syllabusRetrieval.js";

test("table labels without colons, split labels, wrapped descriptions and semester header autofill", () => {
  const result = parseSyllabus(
    "COURSE SYLLABUS\n2nd Semester, AY 2024-2025\nCourse\nCode GNED 08 Course Title Understanding the Self Type Lecture ____\nLaboratory __ Credit Units 3\nCourse\nDescription\nA course about identity and\npersonal development.\nPre-\nrequisites None Course Schedule: BSIT-2A",
  );
  assert.deepEqual(result, {
    code: "GNED 08",
    title: "Understanding the Self",
    description: "A course about identity and personal development.",
    units: "3",
    programs: ["BSIT"],
    academic_year: "2024-2025",
    semester: "2nd Semester",
  });
});

function syllabusIndex(pages) {
  let text = "";
  const positions = pages.map(([page, content]) => {
    const start = text.length;
    text += content;
    const end = text.length;
    text += "\n\n";
    return { page, start, end };
  });
  return buildSyllabusIndex({ text, positions });
}

test("retrieval finds a wrapped module title and prefers its reviewed source page", () => {
  const index = syllabusIndex([
    [2, "The Self from Various Perspectives\nOverview of course coverage"],
    [
      4,
      "The Self from Various\nPerspectives\nPsychological and philosophical views of the self",
    ],
    [5, "Assessment instructions and grading"],
  ]);
  const excerpts = retrieveSyllabusExcerpts(index, {
    title: "The Self from Various Perspectives",
    source_page: 4,
  });
  assert.deepEqual(
    excerpts.map(({ page }) => page),
    [4, 2],
  );
  assert.match(excerpts[0].text, /Psychological and philosophical/);
});

test("retrieval prioritizes the matching section when a page contains several module headings", () => {
  const index = syllabusIndex([
    [
      5,
      [
        "Communication Process and Its Components\nThe sender encodes the message.",
        "Communication channels include verbal and written media. ".repeat(30),
        "Evaluating Messages and/or Images\nReaders examine whether claims are credible.",
      ].join("\n\n"),
    ],
  ]);
  const excerpts = retrieveSyllabusExcerpts(index, {
    title: "Evaluating Messages and/or Images",
    source_page: 5,
  });
  assert.equal(excerpts[0].page, 5);
  assert.match(excerpts[0].text, /Readers examine/);
  assert.doesNotMatch(excerpts[0].text, /The sender encodes/);
});

test("retrieval follows a heading that continues across two pages", () => {
  const index = syllabusIndex([
    [5, "II. Local and Global Communication\nIII. Evaluating Messages and/or"],
    [6, "Images\n1. What is the message?"],
  ]);
  const excerpts = retrieveSyllabusExcerpts(index, {
    title: "Evaluating Messages and/or Images",
    source_page: 5,
  });
  assert.deepEqual(
    excerpts.map(({ page }) => page),
    [5, 6],
  );
  assert.match(excerpts[1].text, /What is the message/);
});

test("retrieval can use reviewed topics, limits output, and ignores irrelevant source pages", () => {
  const pageText = "Visual credibility and verification of claims. ".repeat(
    150,
  );
  const index = syllabusIndex([
    [4, "Course grading and class attendance"],
    [8, pageText],
  ]);
  const excerpts = retrieveSyllabusExcerpts(index, {
    title: "Evaluating Media",
    topics: ["Visual credibility"],
    source_page: 4,
  });
  assert.equal(excerpts.length, 3);
  assert.ok(
    excerpts.every(({ page, text }) => page === 8 && text.length <= 1000),
  );
  assert.deepEqual(
    retrieveSyllabusExcerpts(index, {
      title: "Introduction to Mathematics",
      source_page: 4,
    }),
    [],
  );
  assert.deepEqual(retrieveSyllabusExcerpts([], { title: "Mathematics" }), []);
});
const item = (str, x, y, width = 60) => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
});
test("Topic geometry detects main headings, joins wrapped titles and excludes ILO/assessment columns", () => {
  const result = coverageHeadings([
    {
      num: 3,
      width: 842,
      items: [
        item("COURSE COVERAGE", 369, 179, 103),
        item("Topic", 282, 139, 27),
        item("Teaching and", 393, 150),
        item("I.", 225, 98, 6),
        item("Orientation", 256, 98),
        item("1.", 238, 86, 6),
        item("Course Orientation", 256, 86),
        item("Guided Discussion", 383, 98),
        item("I. Assessment trap", 650, 98),
      ],
    },
    {
      num: 4,
      width: 842,
      items: [
        item("1. Understand content", 114, 284),
        item("II.", 225, 284, 8),
        item("The Self from Various", 246, 284, 110),
        item("Perspectives", 246, 273),
        item("1. Philosophy", 214, 261),
        item("c. Not a Roman heading", 236, 239),
        item("Individual presentation", 383, 284),
      ],
    },
    {
      num: 7,
      width: 842,
      items: [
        item("III.", 225, 204, 9),
        item("Unpacking the Self", 239, 204, 100),
        item("1. Physical Self", 214, 182),
      ],
    },
    {
      num: 11,
      width: 842,
      items: [
        item("IV.", 208, 410, 10),
        item("Managing and Caring for the", 230, 410, 130),
        item("Self", 230, 399),
        item("1. Learning", 214, 387),
      ],
    },
    {
      num: 14,
      width: 842,
      items: [
        item("COURSE REQUIREMENTS", 350, 550, 140),
        item("V. Do not include", 225, 500),
      ],
    },
  ]);
  assert.deepEqual(result, [
    { title: "The Self from Various Perspectives", source_page: 4 },
    { title: "Unpacking the Self", source_page: 7 },
    { title: "Managing and Caring for the Self", source_page: 11 },
  ]);
});
test("missing Topic header does not invent module titles; coverage edits are validated", () => {
  assert.deepEqual(
    coverageHeadings([
      {
        num: 1,
        width: 842,
        items: [item("I. An unrelated heading", 225, 100)],
      },
    ]),
    [],
  );
  assert.deepEqual(
    validateCoverageModules([{ title: " Edited title ", source_page: 3 }]),
    [{ title: "Edited title", source_page: 3 }],
  );
  assert.throws(
    () => validateCoverageModules([{ title: "" }]),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => validateCoverageModules([{ title: "A", source_page: -1 }]),
    (error) => error.statusCode === 400,
  );
});

test("Lesson and Module labels may be separate lines; orientation and institutional goals are excluded", () => {
  const result = coverageHeadings([
    {
      num: 4,
      width: 841,
      items: [
        item("COURSE COVERAGE", 350, 473, 114),
        item("Topic", 238, 441, 29),
        item("Teaching and", 327, 441, 71),
        item("I. Orientation", 199, 380),
        item("C. College and", 199, 320),
        item("Department Goals", 199, 307),
        item("and Objectives", 199, 294),
      ],
    },
    {
      num: 5,
      width: 841,
      items: [
        item("Lesson 1:", 199, 449),
        item("Communication", 199, 436),
        item("Process and Its", 199, 423),
        item("Components", 199, 410),
        item("1. The", 199, 385),
        item("Interactive discussion", 330, 449),
        item("Module 2:", 199, 200),
        item("Local and Global", 199, 187),
        item("Communication", 199, 174),
        item("1. Subtopic", 199, 148),
        item("Lesson 3:", 199, 75),
        item("Evaluating Messages and/or", 199, 62),
      ],
    },
    {
      num: 6,
      width: 841,
      items: [
        item("Images", 199, 550),
        item("1. What is the message?", 199, 525),
      ],
    },
  ]);
  assert.deepEqual(result, [
    { title: "Communication Process and Its Components", source_page: 5 },
    { title: "Local and Global Communication", source_page: 5 },
    { title: "Evaluating Messages and/or Images", source_page: 5 },
  ]);
});
