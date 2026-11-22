import { db } from "../../db.js";
import { parseModuleList } from "../courses/courseModulePersistence.js";
import { requestError } from "./courseAccessService.js";
import { generationContext } from "./generationContext.js";

export function moduleKeyFor(value, lessonId) {
  if (value == null || value === "")
    return lessonId == null ? null : String(lessonId);
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 100 ||
    (lessonId != null && String(lessonId) !== value)
  )
    throw requestError("Choose a valid module in this course.", 400);
  return value.trim();
}

export async function lessonModuleScope(courseId, key, input) {
  const requested = generationContext(input) || {};
  const [[row]] = await db.execute(
    `SELECT c.content_modules,c.lesson_pages,c.syllabus_version_id,v.coverage_modules,v.academic_context
     FROM courses c LEFT JOIN syllabus_versions v ON v.version_id=c.syllabus_version_id AND v.catalog_id=c.catalog_id
     WHERE c.course_id=?`,
    [courseId],
  );
  if (!row) throw requestError("Course not found.", 404);
  const modules = parseModuleList(row.content_modules);
  const stored = modules.find(
    (m) => String(m.id ?? m.module_id ?? m.lesson_id) === key,
  );
  const pinnedTitle =
    stored?.catalogCoverageTitle || stored?.title || requested.module_title;
  const coverage = parseModuleList(row.coverage_modules);
  const sameVersion =
    stored?.catalogSyllabusVersionId == null ||
    String(stored.catalogSyllabusVersionId) === String(row.syllabus_version_id);
  const syllabus =
    key &&
    sameVersion &&
    ((Number.isInteger(stored?.syllabusModuleIndex) &&
      coverage.find(
        (m) => m.syllabus_module_index === stored.syllabusModuleIndex,
      )) ||
      coverage.find((m) => m.title === pinnedTitle));
  const modulePages = modules.flatMap((m) =>
    parseModuleList(m.lessonPages || m.lesson_pages).map((page) => ({
      ...page,
      moduleId: m.id ?? m.module_id ?? m.lesson_id,
    })),
  );
  const legacyIds = new Set(),
    otherIds = new Set();
  for (const page of [...parseModuleList(row.lesson_pages), ...modulePages]) {
    const ids = [
      page.source_document_id,
      ...(page.source_document_ids || []),
      ...(page.source_chunks || []).map((s) => s.document_id),
      ...(page.statements || []).flatMap((s) =>
        (s.citations || []).map((c) => c.document_id),
      ),
    ];
    const dest =
      String(page.moduleId ?? page.module_id) === key ? legacyIds : otherIds;
    for (const id of ids.filter(Boolean)) dest.add(String(id));
  }
  for (const id of otherIds) legacyIds.delete(id);
  return {
    key,
    legacyIds,
    otherIds,
    context: {
      ...requested,
      module_key: key,
      module_title: requested.module_title || stored?.title || "",
      topics: syllabus?.topics?.length
        ? syllabus.topics
        : requested.topics?.length
          ? requested.topics
          : stored?.topics || [],
      learning_objectives: [
        syllabus?.learning_objectives,
        requested.learning_objectives || stored?.learningObjectives,
      ]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join("\n"),
      syllabus_context: syllabus?.description || "",
      syllabus_version_id: row.syllabus_version_id,
      syllabus_references: syllabus
        ? row.academic_context?.references || []
        : [],
    },
  };
}

export function belongsToModule(doc, scope) {
  if (doc.module_key != null) return doc.module_key === scope.key;
  if (doc.lesson_id != null) return String(doc.lesson_id) === scope.key;
  const id = String(doc.document_id);
  return scope.key == null ? !scope.otherIds.has(id) : scope.legacyIds.has(id);
}

export async function selectedLessonSources(courseId, scope, raw, files) {
  let ids;
  try {
    ids = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch {
    throw requestError("Invalid saved source selection.", 400);
  }
  if (
    !Array.isArray(ids) ||
    ids.length + files.length > 10 ||
    ids.some((id) => !/^\d+$/.test(String(id)))
  )
    throw requestError("Select up to 10 instructional files.", 400);
  ids = [...new Set(ids.map(String))];
  const [rows] = ids.length
    ? await db.execute(
        "SELECT document_id,lesson_id,module_key,processing_status,file_size_bytes FROM lesson_source_documents WHERE course_id=? AND document_id IN (SELECT value::bigint FROM jsonb_array_elements_text(?::jsonb))",
        [courseId, ids],
      )
    : [[]];
  if (
    rows.length !== ids.length ||
    rows.some(
      (doc) =>
        !belongsToModule(doc, scope) || doc.processing_status !== "ready",
    )
  )
    throw requestError(
      "Choose ready source documents belonging to this module.",
      409,
    );
  const sizes = [
    ...rows.map((d) => Number(d.file_size_bytes)),
    ...files.map((f) => f.size),
  ];
  if (sizes.some((size) => size > 25 * 1024 * 1024))
    throw requestError(
      "Each instructional file must be 25 MB or smaller.",
      400,
    );
  if (sizes.reduce((a, b) => a + b, 0) > 50 * 1024 * 1024)
    throw requestError("The selected materials exceed 50 MB total.", 400);
  return ids;
}
