import crypto from "node:crypto";

const bad = (message) => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};
export async function resolveClassCatalog(connection, body) {
  const id = Number(body.catalogId ?? body.catalog_id);
  if (!Number.isSafeInteger(id) || id <= 0)
    bad("Select an active course from the Course Catalog.");
  const [[course]] = await connection.execute(
    "SELECT * FROM course_catalog WHERE catalog_id=? FOR UPDATE",
    [id],
  );
  if (!course || course.status !== "active" || course.archived_at)
    bad("This catalog course is no longer available. Select an active course.");
  const versionId = body.syllabusVersionId ?? body.syllabus_version_id ?? null;
  if (versionId !== null && versionId !== "") {
    if (!Number.isSafeInteger(Number(versionId)) || Number(versionId) <= 0)
      bad("Invalid syllabus version.");
    const [[version]] = await connection.execute(
      "SELECT version_id FROM syllabus_versions WHERE version_id=? AND catalog_id=?",
      [versionId, id],
    );
    if (!version)
      bad("The selected syllabus version does not belong to this course.");
  }
  return {
    course,
    versionId: versionId ? Number(versionId) : null,
    joinCode: "PB-" + crypto.randomBytes(6).toString("hex").toUpperCase(),
  };
}
export function classPeriod(body) {
  const result = {};
  for (const [key, max] of Object.entries({
    class_name: 255,
    academic_year: 30,
    semester: 30,
    program: 10,
    year_level: 50,
    section_name: 50,
  })) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = String(body[camel] ?? body[key] ?? "").trim();
    if (value.length > max) bad(`${key.replaceAll("_", " ")} is too long.`);
    result[key] = value || null;
  }
  if (result.program && !["BSIT", "BSCS"].includes(result.program))
    bad("Choose BSIT or BSCS.");
  return result;
}
