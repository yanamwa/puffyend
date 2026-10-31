import crypto from "node:crypto";
export function parseModuleList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export function mergeModuleContent(stored, derived) {
  const byId = new Map(
    derived.map((module) => [String(module.id || module.module_id), module]),
  );
  const result = stored.map((module) => {
    const content = byId.get(String(module.id || module.module_id));
    if (!content) return module;
    byId.delete(String(module.id || module.module_id));
    return {
      ...module,
      lessonPages: content.lessonPages,
      lesson_pages: content.lessonPages,
      quizItems: content.quizItems,
      quiz_items: content.quizItems,
    };
  });
  return [...result, ...byId.values()];
}
export async function recoverCatalogModuleShells(db) {
  const [rows] =
    await db.query(`SELECT c.course_id,c.modules,v.coverage_modules FROM courses c JOIN syllabus_versions v ON v.version_id=c.syllabus_version_id AND v.catalog_id=c.catalog_id
    WHERE c.content_modules IS NULL AND c.modules>0 AND COALESCE(c.lesson_pages::text,'[]') IN ('[]','') AND COALESCE(c.quiz_items::text,'[]') IN ('[]','')
    AND NOT EXISTS (SELECT 1 FROM learning_modules m WHERE m.course_id=c.course_id)`);
  let recovered = 0;
  for (const row of rows) {
    const outline = parseModuleList(row.coverage_modules);
    // Only restore exact pinned outlines when the previously saved count agrees.
    if (
      outline.length !== Number(row.modules) ||
      outline.some((module) => !String(module.title || "").trim())
    )
      continue;
    const modules = outline.map((module) => ({
      id: crypto.randomUUID(),
      title: module.title,
      catalogCoverageTitle: module.title,
      description: "",
      learningObjectives: "",
      lessonPages: [],
      quizItems: [],
      mainQuizSettings: { enabled: false, unlockAt: "", lockAt: "" },
    }));
    const [result] = await db.execute(
      "UPDATE courses SET content_modules=? WHERE course_id=? AND content_modules IS NULL AND modules=?",
      [JSON.stringify(modules), row.course_id, row.modules],
    );
    recovered += result.affectedRows;
  }
  return recovered;
}
