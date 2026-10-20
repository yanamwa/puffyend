import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSyllabus,
  validateCoverageModules,
} from "../src/services/catalogRules.js";
import { coverageHeadings } from "../src/services/syllabusExtraction.js";

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
