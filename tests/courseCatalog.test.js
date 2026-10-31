import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCatalogCode,
  parseSyllabus,
  catalogDetails,
} from "../src/services/catalogRules.js";

test("course codes normalize case and all whitespace without losing display value", () => {
  assert.equal(normalizeCatalogCode(" gNeD\t 08 "), "GNED08");
  assert.equal(
    catalogDetails({
      code: " gNeD  08 ",
      title: "Understanding the Self",
      programs: ["BSIT", "BSCS", "BSIT"],
    }).code,
    "gNeD 08",
  );
});
test("label extraction suggests only supported text and leaves missing values blank", () => {
  const result = parseSyllabus(
    "Course Code: GNED 08\nCourse Title: Understanding the Self\nCourse Description: Self awareness\nCredit Units: 3 units\nProgram: BSIT / BSCS\nAcademic Year: 2026-2027\nSemester: First",
  );
  assert.equal(result.code, "GNED 08");
  assert.equal(result.title, "Understanding the Self");
  assert.equal(result.units, "3");
  assert.deepEqual(result.programs, ["BSIT", "BSCS"]);
  assert.deepEqual(parseSyllabus(""), {
    code: "",
    title: "",
    description: "",
    units: "",
    programs: [],
    academic_year: "",
    semester: "",
  });
});
test("required fields, units and programs are validated", () => {
  for (const body of [
    { code: "", title: "A" },
    { code: "A", title: "" },
    { code: "A", title: "A", units: "abc" },
    { code: "A", title: "A", programs: ["INVALID"] },
  ])
    assert.throws(
      () => catalogDetails(body),
      (e) => e.statusCode === 400,
    );
});
