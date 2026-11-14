import { studentCourseContent } from "../services/courses/modulePublication.js";
import { mergeModuleContent } from "../services/courses/courseModulePersistence.js";
import { resolveClassCatalog, classPeriod } from "../services/catalog/classCatalogService.js";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { db } from "../db.js";
import { deleteWithSources } from "../services/rag/sourceLifecycleService.js";
import authenticateUser from "../middleware/authMiddleware.js";
import { assertCourseAccess, requestError } from "../services/rag/courseAccessService.js";

async function authenticateDeletion(req, res) {
  if (req.user) return true;
  let authenticated = false;
  await authenticateUser(req, res, () => {
    authenticated = true;
  });
  return authenticated;
}
import {
  sendEnrollmentAcceptedEmail,
  sendEnrollmentDeclinedEmail,
  sendEnrollmentRequestEmail,
  sendStudentUnenrolledEmail,
} from "../utils/mailer.js";
import { getSystemSettingsConfig } from "../services/system/systemSettingsService.js";
import { createNotification } from "../utils/notification.js";
import { logAuditFromRequest } from "../services/system/auditLogService.js";

import { JWT_SECRET } from "../config/security.js";

function cleanText(value) {
  return String(value || "").trim();
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function wantsCourseSummary(req) {
  return (
    isTruthy(req.query?.summaryOnly) ||
    isTruthy(req.query?.compact) ||
    isTruthy(req.body?.summaryOnly) ||
    isTruthy(req.body?.compact)
  );
}

function getCourseSelect(idColumn, summaryOnly = false) {
  if (!summaryOnly) return "c.*";

  return `c.${idColumn} AS course_pk,
         c.content_modules, c.catalog_id, c.catalog_code, c.syllabus_version_id, c.class_name,
         c.academic_year, c.semester, c.program, c.year_level, c.section_name,
         c.title,
         c.code,
         c.summary,
         c.subject,
         c.professor_id,
         c.course_name,
         c.description,
         c.course_code,
         c.learning_objectives,
         c.status,
         c.visibility,
         c.students,
         c.modules,
         c.quizzes,
         c.join_link,
         c.archived,
         c.archived_by_role,
         c.professor_name,
         c.professor_email,
         c.professor_department,
         c.professor_profile_image,
         c.created_at,
         c.updated_at`;
}

function generateCourseCode() {
  return `PB-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto
    .randomBytes(2)
    .toString("hex")
    .toUpperCase()}`;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.slice("Bearer ".length).trim();
}

function getTokenUser(req) {
  if (req.user) {
    return req.user;
  }

  const token = getBearerToken(req);

  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

function getRequestUserId(req) {

  const decoded = getTokenUser(req);

  return decoded?.id || decoded?.userId || decoded?.user_id || null;
}

function normalizeRole(role) {
  const value = cleanText(role)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (value === "instructor") return "professor";

  return value;
}

async function getRequestUserProfile(req) {
  const tokenUser = getTokenUser(req);

  if (!tokenUser) {
    return null;
  }

  const userId = tokenUser.id || tokenUser.userId || tokenUser.user_id;
  const email = cleanText(tokenUser.email).toLowerCase();

  try {
    let rows = [];

    if (userId) {
      [rows] = await db.execute(
        `SELECT userId, email, role, name, display_name,
                professor_department, profile_image
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [userId],
      );
    } else if (email) {
      [rows] = await db.execute(
        `SELECT userId, email, role, name, display_name,
                professor_department, profile_image
         FROM users
         WHERE LOWER(email) = ?
         LIMIT 1`,
        [email],
      );
    }

    if (rows.length) {
      const user = rows[0];

      return {
        ...tokenUser,
        id: user.userId,
        userId: user.userId,
        email: user.email,
        role: req.user?.role || user.role,
        name: user.name,
        displayName: user.display_name || user.name || "",
        display_name: user.display_name || user.name || "",
        professorDepartment: user.professor_department || "",
        professor_department: user.professor_department || "",
        profileImage: user.profile_image || "",
        profile_image: user.profile_image || "",
      };
    }
  } catch (error) {
    console.warn("Could not load authenticated course owner profile:", error);
  }

  return tokenUser;
}

function isProfessorUser(user) {
  return normalizeRole(user?.role) === "professor";
}

function getProfessorOwnerCondition(tableAlias, user) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const userId = user?.id || user?.userId || user?.user_id;
  const email = cleanText(user?.email).toLowerCase();
  const clauses = [];
  const params = [];

  if (userId) {
    clauses.push(`${prefix}professor_id = ?`);
    params.push(userId);
  }

  if (email) {
    clauses.push(`LOWER(${prefix}professor_email) = ?`);
    params.push(email);
  }

  return {
    sql: clauses.length ? `(${clauses.join(" OR ")})` : "0 = 1",
    params,
  };
}

function courseMatchesProfessorFields(course, fields) {
  const professorId = cleanText(fields.professorId || fields.professor_id);
  const professorEmail = cleanText(
    fields.professorEmail || fields.professor_email,
  ).toLowerCase();
  const courseProfessorId = cleanText(
    course?.professor_id || course?.professorId,
  );
  const courseProfessorEmail = cleanText(
    course?.professor_email || course?.professorEmail,
  ).toLowerCase();

  if (professorId && courseProfessorId && professorId === courseProfessorId) {
    return true;
  }

  if (
    professorEmail &&
    courseProfessorEmail &&
    professorEmail === courseProfessorEmail
  ) {
    return true;
  }

  return false;
}

async function applyAuthenticatedProfessorFields(req, fields) {
  const currentUser = await getRequestUserProfile(req);

  if (!isProfessorUser(currentUser)) {
    return fields;
  }

  const professorId =
    currentUser.id || currentUser.userId || currentUser.user_id || null;
  const professorName =
    cleanText(
      currentUser.displayName || currentUser.display_name || currentUser.name,
    ) ||
    fields.professorName ||
    "Professor";

  return {
    ...fields,
    professorId,
    professorName,
    professorEmail: cleanText(currentUser.email || fields.professorEmail),
    professorDepartment: cleanText(
      currentUser.professorDepartment ||
        currentUser.professor_department ||
        fields.professorDepartment,
    ),
    professorProfileImage: cleanText(
      currentUser.profileImage ||
        currentUser.profile_image ||
        fields.professorProfileImage,
    ),
  };
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;

  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toJsonList(value) {
  return JSON.stringify(Array.isArray(value) ? value : parseJsonList(value));
}

function readList(...values) {
  for (const value of values) {
    const parsed = parseJsonList(value);

    if (parsed.length) return parsed;
  }

  return [];
}

function getMainQuizSettings(module = {}) {
  const settings = module.mainQuizSettings || module.main_quiz_settings || {};
  const enabled =
    settings.enabled ??
    settings.isEnabled ??
    module.mainQuizEnabled ??
    module.main_quiz_enabled ??
    true;
  return {
    manualQuestions: module.mainQuizItems || settings.manualQuestions || [],
    enabled: ![false, 0, "0", "false"].includes(enabled),
    unlockAt:
      settings.unlockAt ||
      settings.unlock_at ||
      module.mainQuizUnlockAt ||
      module.main_quiz_unlock_at ||
      "",
    lockAt:
      settings.lockAt ||
      settings.lock_at ||
      module.mainQuizLockAt ||
      module.main_quiz_lock_at ||
      "",
  };
}

function normalizeContentModule(module, index) {
  const lessonPages = readList(
    module?.lessonPages,
    module?.lesson_pages,
    module?.lessonContent,
    module?.lesson_content,
    module?.lesson_contents,
  );

  const quizItems = readList(
    module?.quizItems,
    module?.quiz_items,
    module?.quizModule,
    module?.quiz_contents,
  );

  return {
    ...(module?.studentPublished !== undefined ? { studentPublished: module.studentPublished === true } : {}),
    id:
      module?.id ||
      module?.lesson_id ||
      module?.module_id ||
      `module-${index + 1}`,
    topics: Array.isArray(module?.topics) ? module.topics.map(t => cleanText(t)).filter(Boolean).slice(0, 100) : [],
    mainQuizSettings: getMainQuizSettings(module),
    lesson_id: module?.lesson_id || null,
    module_id: module?.module_id || module?.id || null,
    title: cleanText(module?.title) || `Module ${index + 1}`,
    description: cleanText(
      module?.description || module?.module_description || module?.summary,
    ),
    summary: cleanText(
      module?.description || module?.module_description || module?.summary,
    ),
    learningObjectives: cleanText(
      module?.learningObjectives || module?.learning_objectives,
    ),
    learning_objectives: cleanText(
      module?.learning_objectives || module?.learningObjectives,
    ),
    lessonPages,
    lesson_pages: lessonPages,
    quizItems,
    quiz_items: quizItems,
  };
}

function getPayloadContentModules(body) {
  const modules = readList(body.contentModules, body.content_modules);

  return modules
    .map(normalizeContentModule)
    .filter(
      (module) =>
        module.title ||
        module.description ||
        module.learningObjectives ||
        module.lessonPages.length ||
        module.quizItems.length,
    );
}

function getModuleMeta(module, index) {
  const moduleId =
    module.id || module.module_id || module.lesson_id || `module-${index + 1}`;

  return {
    topics: Array.isArray(module?.topics) ? module.topics.map(t => cleanText(t)).filter(Boolean).slice(0, 100) : [],
    mainQuizSettings: getMainQuizSettings(module),
    moduleId,
    module_id: moduleId,
    moduleTitle: module.title,
    module_title: module.title,
    moduleDescription: module.description || "",
    module_description: module.description || "",
    moduleLearningObjectives: module.learningObjectives || "",
    module_learning_objectives: module.learningObjectives || "",
    moduleIndex: index,
    module_index: index,
  };
}

function flattenModuleLessonPages(contentModules) {
  return contentModules.flatMap((module, moduleIndex) =>
    module.lessonPages.map((page, pageIndex) => ({
      ...page,
      ...getModuleMeta(module, moduleIndex),
      pageIndex,
      page_index: pageIndex,
    })),
  );
}

function flattenModuleQuizItems(contentModules) {
  return contentModules.flatMap((module, moduleIndex) =>
    module.quizItems.map((item) => ({
      ...item,
      ...getModuleMeta(module, moduleIndex),
    })),
  );
}

function getModuleKeyFromItem(item, fallbackIndex = 0) {
  const moduleIndex = Number(item?.moduleIndex ?? item?.module_index);

  if (Number.isInteger(moduleIndex)) return `index-${moduleIndex}`;

  const moduleId = item?.moduleId || item?.module_id;
  if (moduleId) return `id-${moduleId}`;

  const moduleTitle = cleanText(item?.moduleTitle || item?.module_title);
  if (moduleTitle) return `title-${moduleTitle.toLowerCase()}`;

  return "legacy-module";
}

function buildContentModulesFromFlatContent(
  lessonPages,
  quizItems,
  fallback = {},
) {
  const modules = new Map();

  const ensureModule = (item, fallbackIndex = 0) => {
    const key = getModuleKeyFromItem(item, fallbackIndex);
    if (!key) return null;

    if (!modules.has(key)) {
      const moduleIndex = Number(item?.moduleIndex ?? item?.module_index);
      const order = Number.isInteger(moduleIndex) ? moduleIndex : modules.size;
      const moduleId =
        item?.moduleId || item?.module_id || `module-${order + 1}`;
      const title =
        cleanText(item?.moduleTitle || item?.module_title) ||
        `Module ${order + 1}`;
      const description = cleanText(
        item?.moduleDescription || item?.module_description || fallback.summary,
      );
      const learningObjectives = cleanText(
        item?.moduleLearningObjectives ||
          item?.module_learning_objectives ||
          fallback.learningObjectives,
      );

      modules.set(key, {
        mainQuizSettings: getMainQuizSettings(item),
        id: moduleId,
        module_id: moduleId,
        title,
        description,
        summary: description,
        learningObjectives,
        learning_objectives: learningObjectives,
        lessonPages: [],
        lesson_pages: [],
        quizItems: [],
        quiz_items: [],
        order,
      });
    }

    return modules.get(key);
  };

  lessonPages.forEach((page, index) => {
    const module = ensureModule(page, index);
    if (!module) return;

    module.lessonPages.push(page);
    module.lesson_pages.push(page);
  });

  quizItems.forEach((item, index) => {
    const module = ensureModule(item, index);
    if (!module) return;

    module.quizItems.push(item);
    module.quiz_items.push(item);
  });

  return [...modules.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...module }) => module);
}

function buildCourseContentModules(
  learningModules,
  lessonPages,
  quizItems,
  fallback = {},
) {
  if (lessonPages.length || quizItems.length) {
    return buildContentModulesFromFlatContent(lessonPages, quizItems, fallback);
  }

  if (learningModules.length) {
    return learningModules.map((module, index) =>
      normalizeContentModule(
        {
          ...module,
          id: module.id || module.lesson_id,
          module_id: module.module_id || module.id || module.lesson_id,
          lessonPages: module.lessonPages,
          quizItems: module.quizItems,
        },
        index,
      ),
    );
  }

  return [];
}

function countContentModules(contentModules, lessonPages, quizItems) {
  if (contentModules.length) return contentModules.length;
  return buildContentModulesFromFlatContent(lessonPages, quizItems).length;
}

function normalizeStatus(status) {
  const value = cleanText(status).toLowerCase();
  return value === "publish" || value === "published" ? "published" : "draft";
}

function normalizeVisibility(visibility) {
  return cleanText(visibility).toLowerCase() === "public"
    ? "public"
    : "private";
}

function formatDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

let courseIdColumn;

async function getCourseIdColumn() {
  if (courseIdColumn) return courseIdColumn;

  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
       AND TABLE_NAME = 'courses'
       AND COLUMN_NAME IN ('course_id', 'id')`,
  );
  const columnNames = new Set(columns.map((column) => column.COLUMN_NAME));

  courseIdColumn = columnNames.has("course_id") ? "course_id" : "id";
  return courseIdColumn;
}

function getCourseId(row) {
  return row?.course_pk || row?.course_id || row?.id;
}

function rowToCourse(row, learningModules = []) {
  const courseId = getCourseId(row);
  const storedLessonPages = parseJsonList(row.lesson_pages);
  const storedQuizItems = parseJsonList(row.quiz_items);
  const derivedModules = buildCourseContentModules(
    learningModules,
    storedLessonPages,
    storedQuizItems,
    {
      summary: row.summary || row.description || "",
      learningObjectives: row.learning_objectives || "",
    },
  );
  const contentModules = row.content_modules == null
    ? derivedModules
    : mergeModuleContent(parseJsonList(row.content_modules).map(normalizeContentModule),derivedModules);
  const fallbackLessonPages = contentModules.flatMap(
    (module) => module.lessonPages || [],
  );
  const fallbackQuizItems = contentModules.flatMap(
    (module) => module.quizItems || [],
  );
  const lessonPages = storedLessonPages.length
    ? storedLessonPages
    : fallbackLessonPages;
  const quizItems = storedQuizItems.length
    ? storedQuizItems
    : fallbackQuizItems;
  const courseCode = row.course_code || row.code || "";
  const courseName = row.course_name || row.title || row.subject || courseCode;
  const summary = row.summary || row.description || "";
  const pageCount = lessonPages.length;
  const quizCount = quizItems.length || Number(row.quizzes || 0);
  const moduleCount = contentModules.length || Number(row.modules || 0);
  const archivedByRole = normalizeRole(
    row.archived_by_role || (row.catalog_archived_at ? "admin" : ""),
  );

  return {
    id: courseId,
    course_id: courseId,
    catalogId: row.catalog_id || null,
    catalogCode: row.catalog_code || "",
    syllabusVersionId: row.syllabus_version_id || null,
    className: row.class_name || "",
    academicYear: row.academic_year || "",
    semester: row.semester || "",
    program: row.program || "",
    yearLevel: row.year_level || "",
    sectionName: row.section_name || "",
    courseName,
    course_name: courseName,
    title: courseName,
    code: courseCode,
    courseCode,
    course_code: courseCode,
    description: summary,
    summary,
    subject: row.subject || courseName,
    learningObjectives: row.learning_objectives || "",
    learning_objectives: row.learning_objectives || "",
    status: normalizeStatus(row.status),
    visibility: normalizeVisibility(row.visibility),
    lessonPages,
    lessonContent: row.lesson_pages || JSON.stringify(lessonPages),
    lesson_content: row.lesson_pages || JSON.stringify(lessonPages),
    quizItems,
    quizModule: row.quiz_items || JSON.stringify(quizItems),
    quiz_contents: row.quiz_items || JSON.stringify(quizItems),
    hasQuiz: quizCount > 0,
    has_quiz: quizCount > 0,
    students: Number(row.students || 0),
    modules: moduleCount,
    moduleCount,
    module_count: moduleCount,
    lessonPageCount: pageCount,
    lesson_page_count: pageCount,
    quizzes: quizCount,
    contentModules,
    content_modules: contentModules,
    learningModules,
    learning_modules: learningModules,
    joinLink: row.join_link || "",
    join_link: row.join_link || "",
    archived: row.archived === 1 || row.archived === true,
    archivedByRole: archivedByRole || null,
    archived_by_role: archivedByRole || null,
    professorId: row.professor_id || null,
    professorDisplayName:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professor_display_name:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professorName:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professor_name:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professorEmail: row.professor_email || row.database_professor_email || "",
    professor_email: row.professor_email || row.database_professor_email || "",
    professorDepartment:
      row.professor_department || row.database_professor_department || "",
    professor_department:
      row.professor_department || row.database_professor_department || "",
    professorProfileImage:
      row.professor_profile_image || row.database_professor_profile_image || "",
    professor_profile_image:
      row.professor_profile_image || row.database_professor_profile_image || "",
    createdAt: formatDate(row.created_at),
    updatedAt: formatDate(row.updated_at || row.created_at),
  };
}

function rowToModule(row) {
  const courseId = getCourseId(row);
  const lessonPages = parseJsonList(row.lesson_contents);
  const quizItems = parseJsonList(row.quiz_contents);
  const courseCode = row.course_code || row.code || "";
  const courseName =
    row.course_name || row.course_subject || row.course_title || courseCode;
  const updatedAt = formatDate(row.updated_at || row.created_at);

  return {
    id: row.lesson_id,
    lesson_id: row.lesson_id,
    courseId,
    course_id: courseId,
    courseName,
    course_name: courseName,
    code: courseCode,
    courseCode,
    course_code: courseCode,
    title: row.title,
    summary: row.description || "",
    description: row.description || "",
    module_description: row.description || "",
    subject: row.subject || "",
    learningObjectives: row.learning_objectives || "",
    learning_objectives: row.learning_objectives || "",
    status: normalizeStatus(row.status),
    visibility: normalizeVisibility(row.course_visibility),
    lessonPages,
    lessonContent: row.lesson_contents || "[]",
    lesson_content: row.lesson_contents || "[]",
    quizItems,
    quizModule: row.quiz_contents || "[]",
    quiz_contents: row.quiz_contents || "[]",
    hasQuiz: row.has_quiz === 1 || quizItems.length > 0,
    has_quiz: row.has_quiz === 1 || quizItems.length > 0,
    students: Number(row.students || 0),
    modules: lessonPages.length,
    quizzes: quizItems.length,
    joinLink: row.join_link || "",
    join_link: row.join_link || "",
    archived: row.archived === 1 || row.archived === true,
    professorId: row.professor_id || null,
    professor_id: row.professor_id || null,
    professorDisplayName:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professor_display_name:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professorName:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professor_name:
      row.professor_name ||
      row.database_professor_display_name ||
      row.database_professor_name ||
      "",
    professorEmail: row.professor_email || row.database_professor_email || "",
    professor_email: row.professor_email || row.database_professor_email || "",
    professorDepartment:
      row.professor_department || row.database_professor_department || "",
    professor_department:
      row.professor_department || row.database_professor_department || "",
    professorProfileImage:
      row.professor_profile_image || row.database_professor_profile_image || "",
    professor_profile_image:
      row.professor_profile_image || row.database_professor_profile_image || "",
    createdAt: formatDate(row.created_at),
    updatedAt,
  };
}

function payloadToModuleFields(body) {
  const courseCode = cleanText(
    body.courseCode || body.course_code || body.code,
  ).toUpperCase();
  const courseName = cleanText(
    body.courseName ||
      body.course_name ||
      body.courseTitle ||
      body.subject ||
      courseCode,
  );
  const courseDescription = cleanText(
    body.courseDescription ||
      body.course_description ||
      body.courseSummary ||
      body.summary,
  );
  const lessonPages = Array.isArray(body.lessonPages)
    ? body.lessonPages
    : parseJsonList(body.lessonContent || body.lesson_content);
  const quizItems = Array.isArray(body.quizItems)
    ? body.quizItems
    : parseJsonList(body.quizModule || body.quiz_contents);

  return {
    courseId: body.courseId || body.course_id || null,
    courseCode,
    courseName,
    courseDescription,
    courseStatus: normalizeStatus(
      body.courseStatus || body.course_status || body.status,
    ),
    courseVisibility: normalizeVisibility(body.visibility),
    professorId: body.professorId || body.professor_id || null,
    professorName: cleanText(body.professorName || body.professor_name),
    professorEmail: cleanText(body.professorEmail || body.professor_email),
    professorDepartment: cleanText(
      body.professorDepartment || body.professor_department,
    ),
    professorProfileImage: cleanText(
      body.professorProfileImage || body.professor_profile_image,
    ),
    title: cleanText(body.title),
    description: cleanText(
      body.description || body.module_description || body.summary,
    ),
    subject: cleanText(body.subject || courseName),
    learningObjectives: cleanText(
      body.learningObjectives || body.learning_objectives,
    ),
    status: normalizeStatus(body.status),
    lessonPages,
    quizItems,
    archived:
      body.archived === true ||
      body.archived === 1 ||
      body.archived === "1" ||
      body.archived === "true",
  };
}

function payloadToCourseFields(body) {
  const contentModules = getPayloadContentModules(body);
  const courseCode =
    cleanText(body.courseCode || body.course_code || body.code).toUpperCase() ||
    generateCourseCode();
  const title = cleanText(
    body.title ||
      body.courseTitle ||
      body.course_title ||
      body.courseName ||
      body.course_name,
  );
  const summary = cleanText(
    body.summary ||
      body.description ||
      body.courseDescription ||
      body.course_description,
  );
  const providedLessonPages = readList(
    body.lessonPages,
    body.lessonContent,
    body.lesson_content,
    body.lesson_pages,
  );
  const providedQuizItems = readList(
    body.quizItems,
    body.quizModule,
    body.quiz_contents,
    body.quiz_items,
  );
  const lessonPages = providedLessonPages.length
    ? providedLessonPages
    : flattenModuleLessonPages(contentModules);
  const quizItems = providedQuizItems.length
    ? providedQuizItems
    : flattenModuleQuizItems(contentModules);
  const learningObjectives =
    cleanText(body.learningObjectives || body.learning_objectives) ||
    contentModules
      .map((module) => module.learningObjectives)
      .filter(Boolean)
      .join("\n\n");
  const countedModuleCount = countContentModules(
    contentModules,
    lessonPages,
    quizItems,
  );
  const moduleCount =
    countedModuleCount ||
    Number(body.moduleCount || body.module_count || body.modules) ||
    0;

  return {
    courseCode,
    title,
    summary,
    subject: cleanText(body.subject || title),
    learningObjectives,
    status: normalizeStatus(body.status),
    visibility: normalizeVisibility(body.visibility),
    professorId: body.professorId || body.professor_id || null,
    professorName: cleanText(body.professorName || body.professor_name),
    professorEmail: cleanText(body.professorEmail || body.professor_email),
    professorDepartment: cleanText(
      body.professorDepartment || body.professor_department,
    ),
    professorProfileImage: cleanText(
      body.professorProfileImage || body.professor_profile_image,
    ),
    contentModules,
    lessonPages,
    quizItems,
    moduleCount,
    lessonPageCount: lessonPages.length,
    students: Number(body.students || 0),
    archived:
      body.archived === true ||
      body.archived === 1 ||
      body.archived === "1" ||
      body.archived === "true",
  };
}

function validateModule(fields) {
  if (!fields.courseCode && !fields.courseId) {
    return "Course code is required.";
  }

  if (!fields.title || !fields.description || !fields.subject) {
    return "Module title, description, and subject are required.";
  }

  if (!fields.learningObjectives || fields.lessonPages.length === 0) {
    return "Learning objectives and at least one lesson page are required.";
  }

  return "";
}

function validateCourse(fields) {
  if (!fields.courseCode) return "Course code is required.";
  if (!fields.title) return "Course title is required.";
  if (fields.status !== "published") return "";
  if (!fields.summary || !fields.subject)
    return "Course description and subject are required to publish.";
  // Courses can be released progressively; empty modules are valid placeholders.
  if (fields.contentModules.some(module => !module.title))
    return "Each module needs a title before publishing.";
  return "";
}

function duplicateCourseCode(error) {
  return (
    error?.code === "23505" &&
    String(error?.message || "").includes("code")
  );
}

async function sendCourseWriteError(res, error, fallbackMessage) {
  if(error.statusCode) return res.status(error.statusCode).json({success:false,message:error.message});
  if (duplicateCourseCode(error)) {
    return res.status(409).json({
      success: false,
      message: "A course with that code already exists.",
    });
  }

  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
}

async function getOrCreateCourse(fields, user) {
  const idColumn = await getCourseIdColumn();

  if (fields.courseId) {
    const [rows] = await db.execute(
      `SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`,
      [fields.courseId],
    );

    if (rows.length > 0) {
      if ((fields.professorId || fields.professorEmail) && !courseMatchesProfessorFields(rows[0],fields))
        throw Object.assign(new Error("You cannot edit this course."),{statusCode:403});
      if (!canEditCourse(user, rows[0])) throw Object.assign(new Error("You cannot edit this course."), { statusCode: 403 });
      return rows[0];
    }
  }

  const [existing] = await db.execute(
    `SELECT *
     FROM courses
     WHERE course_code = ? OR code = ?
     LIMIT 1`,
    [fields.courseCode, fields.courseCode],
  );

  if (existing.length > 0) {
    if (!canEditCourse(user, existing[0])) throw Object.assign(new Error("You cannot edit this course."), { statusCode: 403 });
    if (
      (fields.professorId || fields.professorEmail) &&
      !courseMatchesProfessorFields(existing[0], fields)
    ) {
      const error = new Error("A course with that code already exists.");
      error.code = "23505";
      throw error;
    }

    if(existing[0].catalog_id) return existing[0];

    await db.execute(
      `UPDATE courses
       SET course_name = ?,
           title = ?,
           description = ?,
           summary = ?,
           subject = ?,
           status = ?,
           visibility = ?,
           professor_id = ?,
           professor_name = ?,
           professor_email = ?,
           professor_department = ?,
           professor_profile_image = ?,
           join_link = ?
       WHERE ${idColumn} = ?`,
      [
        fields.courseName,
        fields.courseName,
        fields.courseDescription,
        fields.courseDescription,
        fields.courseName,
        fields.courseStatus,
        fields.courseVisibility,
        fields.professorId,
        fields.professorName,
        fields.professorEmail,
        fields.professorDepartment,
        fields.professorProfileImage,
        `/student/join?courseCode=${encodeURIComponent(fields.courseCode)}`,
        getCourseId(existing[0]),
      ],
    );

    const [updated] = await db.execute(
      `SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`,
      [getCourseId(existing[0])],
    );
    return updated[0];
  }

  throw Object.assign(new Error("Create a class from an active catalog course before adding modules."),{statusCode:400});
}

async function getCourseLearningModules(courseIds) {
  if (!courseIds.length) return new Map();

  const placeholders = courseIds.map(() => "?").join(", ");
  const rows = await getModuleRows(
    `WHERE lm.course_id IN (${placeholders})`,
    courseIds,
  );
  const grouped = new Map();

  rows.forEach((row) => {
    const module = rowToModule(row);
    const key = String(module.courseId);

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(module);
  });

  return grouped;
}

async function getModuleRows(where = "", params = []) {
  const idColumn = await getCourseIdColumn();

  const [rows] = await db.execute(
    `SELECT
       lm.*,
       c.${idColumn} AS course_pk,
       c.course_name,
       c.course_code,
       c.title AS course_title,
       c.code,
       c.subject AS course_subject,
       c.visibility AS course_visibility,
       c.join_link,
       c.archived,
       c.students,
       c.professor_id,
       c.professor_name,
       c.professor_email,
       c.professor_department,
       c.professor_profile_image,
       u.display_name AS database_professor_display_name,
       u.name AS database_professor_name,
       u.email AS database_professor_email,
       u.professor_department AS database_professor_department,
       u.profile_image AS database_professor_profile_image
     FROM learning_modules lm
     INNER JOIN courses c ON c.${idColumn} = lm.course_id
     LEFT JOIN users u ON u.userId = c.professor_id
     ${where}
     ORDER BY lm.updated_at DESC, lm.lesson_id DESC`,
    params,
  );

  return rows;
}

export async function getCourses(req, res) {
  try {
    const idColumn = await getCourseIdColumn();
    const currentUser = await getRequestUserProfile(req);
    const includeArchived =
      req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const publicOnly = req.query.public === "1" || req.query.public === "true";
    const publishedOnly =
      req.query.published === "1" || req.query.published === "true";
    const summaryOnly = wantsCourseSummary(req);
    const where = [];
    const params = [];

    if (!includeArchived) where.push("c.archived = 0");
    if (publicOnly) {
      where.push("c.visibility = ?");
      params.push("public");
    }
    if (publishedOnly) {
      where.push("c.status = ?");
      params.push("published");
    }
    if (isProfessorUser(currentUser) && !publicOnly) {
      const owner = getProfessorOwnerCondition("c", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const courseSelect = getCourseSelect(idColumn, summaryOnly);

    const [courseRows] = await db.execute(
      `SELECT
         ${courseSelect},
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image,
         cc.archived_at AS catalog_archived_at
       FROM courses c
       LEFT JOIN users u ON u.userId = c.professor_id
       LEFT JOIN course_catalog cc ON cc.catalog_id = c.catalog_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.updated_at DESC, c.${idColumn} DESC`,
      params,
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(courseRows.map(getCourseId));

    const enrollmentByCourseId = new Map();
    const requestUserId = getRequestUserId(req);
    const courseIds = [...new Set(courseRows.map(getCourseId).filter(Boolean))];

    if (requestUserId && courseIds.length) {
      const placeholders = courseIds.map(() => "?").join(", ");
      const [enrollmentRows] = await db.execute(
        `SELECT enrollment_id, course_id, status, approved_at
         FROM course_enrollments
         WHERE user_id = ?
           AND course_id IN (${placeholders})
           AND archived = 0
           AND status IN ('pending', 'approved')`,
        [requestUserId, ...courseIds],
      );

      enrollmentRows.forEach((enrollment) => {
        enrollmentByCourseId.set(String(enrollment.course_id), enrollment);
      });
    }

    const courses = courseRows.map((courseRow) => {
      const courseId = getCourseId(courseRow);
      const course = rowToCourse(
        courseRow,
        modulesByCourse.get(String(courseId)) || [],
      );
      const enrollment = enrollmentByCourseId.get(String(courseId));

      if (!enrollment) {
        return course;
      }

      return {
        ...course,
        enrollmentId: enrollment.enrollment_id,
        enrollmentStatus: enrollment.status,
        enrollment_status: enrollment.status,
        enrollmentRequested: enrollment.status === "pending",
        enrollment_requested: enrollment.status === "pending",
        requestedEnrollment: enrollment.status === "pending",
        requested_enrollment: enrollment.status === "pending",
        approvedAt: enrollment.approved_at,
      };
    });

    return res.json({
      success: true,
      courses: currentUser && ["professor", "admin", "super_admin", "superadmin"].includes(normalizeRole(currentUser.role)) ? courses : courses.map(studentCourseContent),
    });
  } catch (error) {
    console.error("Get courses error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch courses.",
    });
  }
}

export async function getEnrolledCourses(req, res) {
  const userId = getRequestUserId(req);

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Student account is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    const includeArchived = isTruthy(req.query.includeArchived);
    const archivedOnly =
      isTruthy(req.query.archived) || isTruthy(req.query.archivedOnly);

    const summaryOnly = wantsCourseSummary(req);
    const courseSelect = getCourseSelect(idColumn, summaryOnly);

    const where = ["ce.user_id = ?", "ce.status = 'approved'"];

    const params = [userId];

    if (archivedOnly) {
      where.push("(ce.archived = 1 OR c.archived = 1)");
    } else if (!includeArchived) {
      where.push("ce.archived = 0");
      where.push("c.archived = 0");
    }

    const [courseRows] = await db.execute(
      `SELECT
         ${courseSelect},
         ce.enrollment_id,
         ce.status AS enrollment_status,
         ce.approved_at,
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

       LEFT JOIN users u
         ON u.userId = c.professor_id

       WHERE ${where.join(" AND ")}

       ORDER BY
         ce.created_at DESC,
         c.updated_at DESC,
         c.${idColumn} DESC`,
      params,
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(courseRows.map(getCourseId));

    const courses = courseRows.map((course) => ({
      ...rowToCourse(
        course,
        modulesByCourse.get(String(getCourseId(course))) || [],
      ),

      enrollmentId: course.enrollment_id,
      enrollmentStatus: course.enrollment_status,
      approvedAt: course.approved_at,
    }));

    return res.json({
      success: true,
      courses: courses.map(studentCourseContent),
    });
  } catch (error) {
    console.error("Get enrolled courses error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch enrolled courses.",
    });
  }
}

export async function getArchivedCourses(req, res) {
  const userId = getRequestUserId(req);

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Student account is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    const summaryOnly = wantsCourseSummary(req);
    const courseSelect = getCourseSelect(idColumn, summaryOnly);

    const [courseRows] = await db.execute(
      `SELECT
         ${courseSelect},
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image
       FROM course_enrollments ce
       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id
       LEFT JOIN users u
         ON u.userId = c.professor_id
       WHERE ce.user_id = ?
         AND (ce.archived = 1 OR c.archived = 1)
       ORDER BY ce.created_at DESC,
                c.updated_at DESC,
                c.${idColumn} DESC`,
      [userId],
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(courseRows.map(getCourseId));

    const courses = courseRows.map((course) =>
      rowToCourse(
        course,
        modulesByCourse.get(String(getCourseId(course))) || [],
      ),
    );

    return res.json({
      success: true,
      courses,
    });
  } catch (error) {
    console.error("Get archived courses error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch archived courses.",
    });
  }
}

async function notifyEnrollmentApproved(
  settings,
  { email, studentName, courseName, notification },
) {
  if (settings.enrollmentSystemNotification) {
    try {
      await createNotification({
        ...notification,
        title: "Enrollment Approved",
        message: `Your enrollment in ${courseName} has been approved.`,
        target: "student",
        type: "enrollment_approved",
      });
    } catch (error) {
      console.error("Failed to create approval notification:", error);
    }
  }

  if (settings.enrollmentAcceptedEmail && email) {
    try {
      await sendEnrollmentAcceptedEmail(email, studentName, courseName);
    } catch (error) {
      console.error("Failed to send enrollment approval email:", error);
    }
  }
}

async function enrollWithoutApproval(idColumn, courseId, userId, courseCode) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[course]] = await connection.execute(
      `SELECT ${idColumn} FROM courses
       WHERE ${idColumn} = ? AND archived = 0 AND status = 'published'
         AND (visibility = 'public' OR (? <> '' AND (UPPER(course_code) = ? OR UPPER(code) = ?)))
       FOR UPDATE`,
      [courseId, courseCode, courseCode, courseCode],
    );
    if (!course) {
      throw Object.assign(new Error("Course not found or unavailable for enrollment."), {
        statusCode: 404,
      });
    }

    const [[existing]] = await connection.execute(
      `SELECT enrollment_id, status, archived FROM course_enrollments
       WHERE course_id = ? AND user_id = ? FOR UPDATE`,
      [courseId, userId],
    );
    if (existing?.status === "approved" && !existing.archived) {
      await connection.commit();
      return null;
    }

    let enrollmentId = existing?.enrollment_id;
    if (existing) {
      await connection.execute(
        `UPDATE course_enrollments
         SET status = 'approved', archived = 0, approved_at = NOW(), rejection_reason = NULL
         WHERE enrollment_id = ?`,
        [enrollmentId],
      );
    } else {
      const [result] = await connection.execute(
        `INSERT INTO course_enrollments (course_id, user_id, status, approved_at, archived)
         VALUES (?, ?, 'approved', NOW(), 0)`,
        [courseId, userId],
      );
      enrollmentId = result.insertId;
    }

    await connection.execute(
      `UPDATE courses SET students = (
         SELECT COUNT(*) FROM course_enrollments
         WHERE course_id = ? AND status = 'approved' AND archived = 0
       ) WHERE ${idColumn} = ?`,
      [courseId, courseId],
    );
    await connection.commit();
    return enrollmentId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function enrollCourse(req, res) {
  const userId = req.user?.userId || req.user?.id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Student account is required.",
    });
  }

  const courseId = cleanText(
    req.body?.courseId ||
      req.body?.course_id ||
      req.body?.id ||
      req.query?.courseId ||
      req.query?.course_id ||
      req.query?.id,
  );

  const courseCode = cleanText(
    req.body?.courseCode ||
      req.body?.course_code ||
      req.body?.code ||
      req.query?.courseCode ||
      req.query?.course_code ||
      req.query?.code,
  ).toUpperCase();

  if (!courseId && !courseCode) {
    return res.status(400).json({
      success: false,
      message: "Course ID or course code is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();

    const conditions = ["c.archived = 0", "c.status = 'published'"];

    const params = [];

    if (courseId) {
      conditions.push(`c.${idColumn} = ?`);
      params.push(courseId);
    } else {
      conditions.push("(c.course_code = ? OR c.code = ?)");
      params.push(courseCode, courseCode);
    }

    // Get selected course
    const [rows] = await db.execute(
      `SELECT c.*
       FROM courses c
       WHERE ${conditions.join(" AND ")}
       LIMIT 1`,
      params,
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or unavailable for enrollment.",
      });
    }

    const selectedCourse = rows[0];
    const selectedCourseId = getCourseId(selectedCourse);

    // Get student
    const [studentRows] = await db.execute(
      `SELECT
         userId,
         name,
         display_name,
         email
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [userId],
    );

    const student = studentRows[0];

    const studentName = student?.display_name || student?.name || "A student";
    const courseName =
      selectedCourse.course_name || selectedCourse.title || "your course";
    const settings = await getSystemSettingsConfig();

    if (!settings.enrollmentApproval) {
      const enrollmentId = await enrollWithoutApproval(
        idColumn, selectedCourseId, userId, courseCode,
      );
      if (!enrollmentId) {
        return res.status(409).json({
          success: false,
          status: "approved",
          message: "You are already enrolled in this course.",
        });
      }

      await notifyEnrollmentApproved(settings, {
        email: student?.email,
        studentName,
        courseName,
        notification: {
          recipientUserId: userId,
          courseId: selectedCourseId,
          enrollmentId,
        },
      });
      await logAuditFromRequest(req, {
        category: "Enrollment Management",
        action: "Enrolled in Course",
        target: courseName,
        status: "Success",
        details: `${studentName} enrolled in "${courseName}" without requiring approval.`,
      });

      return res.status(201).json({
        success: true,
        status: "approved",
        pending: false,
        enrolled: true,
        enrollmentId,
        message: `You are now enrolled in ${courseName}.`,
      });
    }

    // Get professor
    let professor = null;

    /*
     * Your courses use professor_id.
     */
    const professorId =
      selectedCourse.professor_id || selectedCourse.professor_user_id;

    if (professorId) {
      const [professorRows] = await db.execute(
        `SELECT
           userId,
           name,
           display_name,
           email
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [professorId],
      );

      professor = professorRows[0] || null;
    }

    // Fallback to professor email
    if (!professor && selectedCourse.professor_email) {
      const [professorRows] = await db.execute(
        `SELECT
           userId,
           name,
           display_name,
           email
         FROM users
         WHERE LOWER(email) = LOWER(?)
         LIMIT 1`,
        [selectedCourse.professor_email],
      );

      professor = professorRows[0] || null;
    }

    const professorEmail =
      professor?.email || selectedCourse.professor_email || "";

    const professorName =
      professor?.display_name ||
      professor?.name ||
      selectedCourse.professor_name ||
      selectedCourse.instructor ||
      "Professor";

    /*
     * Sends BOTH:
     * 1. professor email
     * 2. professor in-app notification
     */
    const notifyProfessor = async (enrollmentId) => {
      let emailSent = false;
      let emailError = null;

      // EMAIL
      if (!professorEmail) {
        emailError = "Professor email address was not found.";
      } else {
        try {
          await sendEnrollmentRequestEmail(
            professorEmail,
            professorName,
            studentName,
            courseName,
          );

          emailSent = true;

          console.log(`Enrollment request email sent to ${professorEmail}`);
        } catch (error) {
          console.error(
            "Failed to send professor enrollment request email:",
            error,
          );

          emailError =
            error?.message || "Professor email notification could not be sent.";
        }
      }

      // IN-APP NOTIFICATION
      if (professor?.userId) {
        try {
          await createNotification({
            recipientUserId: professor.userId,

            courseId: selectedCourseId,

            enrollmentId: Number(enrollmentId),

            title: "New Enrollment Request",

            message: `${studentName} requested to enroll in ${courseName}.`,

            target: "professor",

            type: "enrollment_request",

            createdByUserId: userId,

            createdByName: studentName,

            createdByRole: "student",
          });

          console.log(
            `Enrollment request notification created for professor ${professor.userId}`,
          );
        } catch (notificationError) {
          console.error(
            "Failed to create enrollment request notification:",
            notificationError,
          );
        }
      } else {
        console.warn(
          "Professor user ID not found. In-app notification was not created.",
        );
      }

      return {
        emailSent,
        emailError,
      };
    };

    // Check existing enrollment
    const [existingRows] = await db.execute(
      `SELECT *
       FROM course_enrollments
       WHERE course_id = ?
         AND user_id = ?
       LIMIT 1`,
      [selectedCourseId, userId],
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];

      if (existing.status === "approved" && !existing.archived) {
        return res.status(409).json({
          success: false,
          status: "approved",
          message: "You are already enrolled in this course.",
        });
      }

      if (existing.status === "pending" && !existing.archived) {
        return res.status(409).json({
          success: false,
          status: "pending",
          message: "Your enrollment request is already pending approval.",
        });
      }

      // Re-request enrollment
      await db.execute(
        `UPDATE course_enrollments
         SET
           status = 'pending',
           archived = 0,
           approved_at = NULL,
           rejection_reason = NULL,
           created_at = CURRENT_TIMESTAMP
         WHERE enrollment_id = ?`,
        [existing.enrollment_id],
      );

      const notificationResult = await notifyProfessor(existing.enrollment_id);

      /* =====================================================
        AUDIT LOG - REQUEST ENROLLMENT
      ===================================================== */

      await logAuditFromRequest(req, {
        category: "Enrollment Management",
        action: "Requested Enrollment",
        target: courseName,
        status: "Success",
        details: `${studentName} requested enrollment in ` + `"${courseName}".`,
      });

      return res.status(201).json({
        success: true,
        pending: true,
        enrolled: false,

        enrollmentId: existing.enrollment_id,

        emailSent: notificationResult.emailSent,

        emailError: notificationResult.emailError,

        message: notificationResult.emailSent
          ? "Enrollment request sent. The professor has been notified."
          : "Enrollment request sent. Waiting for professor approval.",
      });
    }

    // First enrollment request
    const [result] = await db.execute(
      `INSERT INTO course_enrollments (
         course_id,
         user_id,
         status,
         approved_at,
         archived
       )
       VALUES (?, ?, 'pending', NULL, 0)`,
      [selectedCourseId, userId],
    );

    const notificationResult = await notifyProfessor(result.insertId);

    return res.status(201).json({
      success: true,
      pending: true,
      enrolled: false,

      enrollmentId: result.insertId,

      emailSent: notificationResult.emailSent,

      emailError: notificationResult.emailError,

      message: notificationResult.emailSent
        ? "Enrollment request sent. The professor has been notified."
        : "Enrollment request sent. Waiting for professor approval.",
    });
  } catch (error) {
    if (!error.statusCode) console.error("Enrollment request error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to enroll in the course.",
    });
  }
}

export async function getCourseEnrollments(req, res) {
  const courseId = cleanText(req.params.courseId || req.params.id);

  if (!courseId) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const currentUser = await getRequestUserProfile(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isProfessorUser(currentUser)) {
      return res.status(403).json({
        success: false,
        message: "Professor account is required.",
      });
    }

    const idColumn = await getCourseIdColumn();

    /*
     * Make sure this course belongs
     * to the logged-in professor.
     */
    const owner = getProfessorOwnerCondition("c", currentUser);

    const [courseRows] = await db.execute(
      `SELECT c.${idColumn} AS course_id
       FROM courses c
       WHERE c.${idColumn} = ?
         AND ${owner.sql}
       LIMIT 1`,
      [courseId, ...owner.params],
    );

    if (courseRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or you do not have access to it.",
      });
    }

    const [rows] = await db.execute(
      `SELECT
         ce.enrollment_id AS enrollmentId,
         ce.course_id AS courseId,
         ce.user_id AS userId,
         ce.status,
         ce.created_at AS requestedAt,
         ce.approved_at AS approvedAt,
         ce.rejection_reason AS rejectionReason,

         u.student_id AS studentId,
         u.name,
         u.display_name AS displayName,
         u.email,
         u.gender,
         u.course AS course,
         u.year_level AS yearLevel,
         u.section_name AS sectionName,
         u.profile_image AS profileImage

       FROM course_enrollments ce

       INNER JOIN users u
         ON u.userId = ce.user_id

       WHERE ce.course_id = ?
         AND ce.archived = 0
         AND ce.status IN ('pending', 'approved', 'declined')

       ORDER BY
         CASE
           WHEN ce.status = 'pending' THEN 0
           ELSE 1
         END,
         ce.created_at DESC`,
      [courseId],
    );

    const pending = rows.filter((row) => row.status === "pending");

    const enrolled = rows.filter((row) => row.status === "approved");

    const declined = rows.filter((row) => row.status === "declined");

    return res.json({
      success: true,

      pending,
      enrolled,
      declined,

      counts: {
        pending: pending.length,
        enrolled: enrolled.length,
        declined: declined.length,
        total: rows.length,
      },
    });
  } catch (error) {
    console.error("Get course enrollments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch course enrollments.",
    });
  }
}

export async function unenrollStudentFromCourse(req, res) {
  const enrollmentId = cleanText(req.params.enrollmentId);

  const reason = cleanText(req.body?.reason);

  if (!enrollmentId) {
    return res.status(400).json({
      success: false,
      message: "Enrollment ID is required.",
    });
  }

  if (!reason) {
    return res.status(400).json({
      success: false,
      message: "Reason for unenrolling the student is required.",
    });
  }

  if (reason.length > 500) {
    return res.status(400).json({
      success: false,
      message: "Reason must be 500 characters or fewer.",
    });
  }

  try {
    const currentUser = await getRequestUserProfile(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isProfessorUser(currentUser)) {
      return res.status(403).json({
        success: false,
        message: "Professor account is required.",
      });
    }

    const idColumn = await getCourseIdColumn();

    const owner = getProfessorOwnerCondition("c", currentUser);

    /*
     * Get enrollment, student, and course
     * information before archiving.
     */
    const [rows] = await db.execute(
      `SELECT
         ce.enrollment_id,
         ce.course_id,
         ce.user_id,
         ce.status,

         u.name AS student_name,
         u.display_name AS student_display_name,
         u.email AS student_email,

         c.title AS course_title,
         c.course_name,
         c.course_code,
         c.professor_name

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

       INNER JOIN users u
         ON u.userId = ce.user_id

       WHERE ce.enrollment_id = ?
         AND ce.archived = 0
         AND ${owner.sql}

       LIMIT 1`,
      [enrollmentId, ...owner.params],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Student enrollment not found.",
      });
    }

    const enrollment = rows[0];

    if (enrollment.status !== "approved") {
      return res.status(409).json({
        success: false,
        message: "Only enrolled students can be unenrolled.",
      });
    }

    const studentName =
      enrollment.student_display_name || enrollment.student_name || "Student";

    const studentEmail = cleanText(enrollment.student_email);

    const courseName =
      enrollment.course_name ||
      enrollment.course_title ||
      enrollment.course_code ||
      "your course";

    const professorName =
      cleanText(
        currentUser.displayName ||
          currentUser.display_name ||
          currentUser.name ||
          enrollment.professor_name,
      ) || "Professor";

    /*
     * Archive enrollment.
     */
    await db.execute(
      `UPDATE course_enrollments
       SET archived = 1
       WHERE enrollment_id = ?`,
      [enrollmentId],
    );

    /*
     * Update student count.
     */
    await db.execute(
      `UPDATE courses
       SET students = (
         SELECT COUNT(*)
         FROM course_enrollments
         WHERE course_id = ?
           AND status = 'approved'
           AND archived = 0
       )
       WHERE ${idColumn} = ?`,
      [enrollment.course_id, enrollment.course_id],
    );

    /*
     * Send unenrollment email.
     *
     * Email failure should NOT undo
     * the unenrollment.
     */
    let emailSent = false;
    let emailError = null;

    if (!studentEmail) {
      emailError = "Student email address was not found.";
    } else {
      try {
        await sendStudentUnenrolledEmail(
          studentEmail,
          studentName,
          courseName,
          reason,
          professorName,
        );

        emailSent = true;

        console.log(`Unenrollment email sent to ${studentEmail}`);
      } catch (error) {
        console.error("Failed to send unenrollment email:", error);

        emailError =
          error?.message || "Student email notification could not be sent.";
      }
    }

    // Create in-app notification for the student
    try {
      await createNotification({
        recipientUserId: enrollment.user_id,

        courseId: enrollment.course_id,

        enrollmentId: Number(enrollmentId),

        title: "Course Unenrollment",

        message:
          `You have been unenrolled from ${courseName}. ` + `Reason: ${reason}`,

        target: "student",

        type: "student_unenrolled",

        createdByUserId: currentUser.userId,

        createdByName: professorName,

        createdByRole: "professor",
      });

      console.log(
        `Unenrollment notification created for user ${enrollment.user_id}`,
      );
    } catch (notificationError) {
      console.error(
        "Failed to create unenrollment notification:",
        notificationError,
      );
    }

    /* =====================================================
        AUDIT LOG - UNENROLL STUDENT
      ===================================================== */

    await logAuditFromRequest(req, {
      category: "Enrollment Management",
      action: "Unenrolled Student",
      target: studentName,
      status: "Success",
      details:
        `Unenrolled ${studentName} from ` +
        `"${courseName}". Reason: ${reason}`,
    });

    return res.json({
      success: true,

      message: emailSent
        ? "Student unenrolled and email notification sent."
        : "Student unenrolled, but email notification could not be sent.",

      enrollmentId: Number(enrollmentId),
      courseId: enrollment.course_id,
      userId: enrollment.user_id,
      status: "archived",

      reason,

      emailSent,
      emailError,
    });
  } catch (error) {
    console.error("Professor unenroll student error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to unenroll student.",
    });
  }
}

export async function unenrollCourse(req, res) {
  const userId = getRequestUserId(req);

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Student account is required.",
    });
  }

  const courseId = cleanText(
    req.params.id ||
      req.body?.courseId ||
      req.body?.course_id ||
      req.query?.courseId ||
      req.query?.course_id,
  );

  if (!courseId) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();

    const [courseRows] = await db.execute(
      `SELECT
          course_name,
          title,
          course_code,
          code
        FROM courses
        WHERE ${idColumn} = ?
        LIMIT 1`,
      [courseId],
    );

    if (courseRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const selectedCourse = courseRows[0];

    const courseName =
      selectedCourse.course_name ||
      selectedCourse.title ||
      selectedCourse.course_code ||
      selectedCourse.code ||
      `Course ${courseId}`;

    const [result] = await db.execute(
      `UPDATE course_enrollments
       SET archived = 1
       WHERE course_id = ?
         AND user_id = ?
         AND status = 'approved'
         AND archived = 0`,
      [courseId, userId],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "You are not actively enrolled in this course.",
      });
    }

    await db.execute(
      `UPDATE courses
       SET students = (
         SELECT COUNT(*)
         FROM course_enrollments
         WHERE course_id = ?
           AND status = 'approved'
           AND archived = 0
       )
       WHERE ${idColumn} = ?`,
      [courseId, courseId],
    );
    /* =====================================================
      AUDIT LOG - STUDENT LEFT COURSE
    ===================================================== */

    await logAuditFromRequest(req, {
      category: "Enrollment Management",
      action: "Left Course",
      target: courseName,
      status: "Success",
      details: `Student left "${courseName}".`,
    });

    return res.json({
      success: true,
      message: "Course moved to Archived Classes.",
      courseId,
    });
  } catch (error) {
    console.error("Unenroll course error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to unenroll from course.",
    });
  }
}

export async function getCourseById(req, res) {
  try {
    const idColumn = await getCourseIdColumn();
    const currentUser = await getRequestUserProfile(req);
    const where = [`c.${idColumn} = ?`];
    const params = [req.params.id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("c", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const [rows] = await db.execute(
      `SELECT
         c.*,
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image
       FROM courses c
       LEFT JOIN users u ON u.userId = c.professor_id
       WHERE ${where.join(" AND ")}
       LIMIT 1`,
      params,
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const courseId = getCourseId(rows[0]);
    const modulesByCourse = await getCourseLearningModules([courseId]);
    const course = rowToCourse(
      rows[0],
      modulesByCourse.get(String(courseId)) || [],
    );

    return res.json({
      success: true,
      course: currentUser && ["professor", "admin", "super_admin", "superadmin"].includes(normalizeRole(currentUser.role)) ? course : studentCourseContent(course),
    });
  } catch (error) {
    console.error("Get course error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch course.",
    });
  }
}

export async function getEnrolledPracticeModule(user, courseId, moduleId) {
  if (user?.role !== "student")
    throw requestError("Only enrolled students can take Module Practice.", 403);

  const idColumn = await getCourseIdColumn();
  const [rows] = await db.execute(
    `SELECT c.* FROM courses c
     JOIN course_enrollments e ON e.course_id = c.${idColumn}
     WHERE c.${idColumn} = ? AND e.user_id = ? AND e.status = 'approved'
       AND COALESCE(c.archived, 0) = 0 AND COALESCE(e.archived, 0) = 0 LIMIT 1`,
    [courseId, user.userId],
  );
  const row = rows[0];
  if (!row)
    throw requestError("You are not enrolled in an active course.", 403);

  const hasFlatContent =
    parseJsonList(row.lesson_pages).length || parseJsonList(row.quiz_items).length;
  const learningModules = hasFlatContent
    ? []
    : (await getCourseLearningModules([courseId])).get(String(courseId)) || [];
  const { contentModules } = rowToCourse(row, learningModules);
  const matches = (id) => id != null && String(id) === moduleId;
  const index = contentModules.findIndex((module) => matches(module.id));
  const moduleIndex = index === -1
    ? contentModules.findIndex((module) =>
        [module.module_id, module.lesson_id].some(matches),
      )
    : index;
  const module = contentModules[moduleIndex];
  if (!module) throw requestError("Module not found.", 404);
  if (
    contentModules.some((item) => item.studentPublished !== undefined) &&
    module.studentPublished !== true
  )
    throw requestError("This module has not been uploaded to students yet.", 403);

  return { ...module, moduleIndex };
}

export async function joinCourseByCode(req, res) {
  const courseCode = cleanText(
    req.body?.courseCode ||
      req.body?.course_code ||
      req.body?.code ||
      req.query.courseCode ||
      req.query.code,
  ).toUpperCase();

  if (!courseCode) {
    return res.status(400).json({
      success: false,
      message: "Course code is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    const summaryOnly = wantsCourseSummary(req);
    const courseSelect = getCourseSelect(idColumn, summaryOnly);

    const [rows] = await db.execute(
      `SELECT
         ${courseSelect},
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image
       FROM courses c
       LEFT JOIN users u
         ON u.userId = c.professor_id
       WHERE c.archived = 0
         AND c.status = 'published'
         AND (
           c.course_code = ?
           OR c.code = ?
         )
       LIMIT 1`,
      [courseCode, courseCode],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Course code not found. Please check the code from your professor.",
      });
    }

    const courseId = getCourseId(rows[0]);
    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules([courseId]);

    const course = rowToCourse(
      rows[0],
      modulesByCourse.get(String(courseId)) || [],
    );

    return res.json({
      success: true,
      message: "Course found.",
      course,
    });
  } catch (error) {
    console.error("Join course by code error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to join course.",
    });
  }
}

export async function getLearningModules(req, res) {
  try {
    const currentUser = await getRequestUserProfile(req);
    const includeArchived =
      req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const publicOnly = req.query.public === "1" || req.query.public === "true";
    const publishedOnly =
      req.query.published === "1" || req.query.published === "true";

    const where = [];
    const params = [];

    if (!includeArchived) where.push("c.archived = 0");
    if (publicOnly) {
      where.push("c.visibility = ?");
      params.push("public");
    }
    if (publishedOnly) {
      where.push("lm.status = ?");
      params.push("published");
    }
    if (isProfessorUser(currentUser) && !publicOnly) {
      const owner = getProfessorOwnerCondition("c", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const rows = await getModuleRows(
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      params,
    );
    const modules = rows.map(rowToModule);

    return res.json({
      success: true,
      modules,
      courses: modules,
    });
  } catch (error) {
    console.error("Get learning modules error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch learning modules.",
    });
  }
}

export async function getLearningModuleById(req, res) {
  try {
    const currentUser = await getRequestUserProfile(req);
    const where = ["lm.lesson_id = ?"];
    const params = [req.params.id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("c", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const rows = await getModuleRows(`WHERE ${where.join(" AND ")}`, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found.",
      });
    }

    const module = rowToModule(rows[0]);

    return res.json({
      success: true,
      module,
      course: module,
    });
  } catch (error) {
    console.error("Get learning module error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch learning module.",
    });
  }
}

export async function createCourse(req, res) {
  let connection;
  try {
    const ownerFields = await applyAuthenticatedProfessorFields(req, payloadToCourseFields(req.body));
    const idColumn = await getCourseIdColumn();
    connection = await db.getConnection();
    await connection.beginTransaction();
    const {course: catalog, versionId, joinCode} = await resolveClassCatalog(connection, req.body);
    // Serialize creation per professor so simultaneous requests cannot duplicate a catalog course.
    await connection.execute("SELECT userId FROM users WHERE userId=? FOR UPDATE", [ownerFields.professorId]);
    const [existingCatalogCourses] = await connection.execute(
      "SELECT course_id FROM courses WHERE professor_id=? AND catalog_id=? LIMIT 1",
      [ownerFields.professorId, catalog.catalog_id],
    );
    if (existingCatalogCourses.length) throw Object.assign(new Error("You have already created this catalog course. Please manage the existing course in Course Management."), {statusCode:409});
    const { academicYear, semester } = await getSystemSettingsConfig(connection);
    const period = classPeriod({
      ...req.body,
      academicYear: cleanText(req.body.academicYear ?? req.body.academic_year) || academicYear,
      semester: cleanText(req.body.semester) || semester,
    });
    let fields = payloadToCourseFields({...req.body, title: catalog.title, courseName: catalog.title,
      code: joinCode, courseCode: joinCode, course_code: joinCode,
      summary: catalog.description || req.body.summary || '', description: catalog.description || req.body.description || '', subject: catalog.title});
    const validationMessage = validateCourse(fields);
    if(validationMessage) throw Object.assign(new Error(validationMessage), {statusCode:400});
    for (const key of ["professorId", "professorName", "professorEmail", "professorDepartment", "professorProfileImage"]) fields[key] = ownerFields[key];
    const lessonPages = toJsonList(fields.lessonPages);
    const quizItems = toJsonList(fields.quizItems);
    const joinLink = `/student/join?courseCode=${encodeURIComponent(fields.courseCode)}`;

    const [result] = await connection.execute(
      `INSERT INTO courses
       (title, code, summary, subject, professor_id, course_name, description,
        course_code, learning_objectives, status, visibility, lesson_pages,
        quiz_items, students, modules, quizzes, join_link, archived,
        professor_name, professor_email, professor_department,
        professor_profile_image, catalog_id, syllabus_version_id, catalog_code,
        class_name, academic_year, semester, program, year_level, section_name, content_modules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fields.title,
        fields.courseCode,
        fields.summary,
        fields.subject,
        fields.professorId,
        fields.title,
        fields.summary,
        fields.courseCode,
        fields.learningObjectives,
        fields.status,
        fields.visibility,
        lessonPages,
        quizItems,
        fields.students,
        fields.moduleCount,
        fields.quizItems.length,
        joinLink,
        fields.archived ? 1 : 0,
        fields.professorName,
        fields.professorEmail,
        fields.professorDepartment,
        fields.professorProfileImage,
        catalog.catalog_id, versionId, catalog.code, period.class_name, period.academic_year,
        period.semester, period.program, period.year_level, period.section_name,
        JSON.stringify(fields.contentModules),
      ],
    );

    const [rows] = await connection.execute(
      `SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`,
      [result.insertId],
    );
    const course = rowToCourse(rows[0], []);

    await connection.commit();
    connection.release();
    connection = null;
    await logAuditFromRequest(req, {
      category: "Course Management",
      action: "Created Course",
      target: fields.title,
      status: "Success",
      details:
        `Created course "${fields.title}" ` +
        `with course code ${fields.courseCode}.`,
    });

    return res.status(201).json({
      success: true,
      message: "Course added successfully.",
      course,
    });
  } catch (error) {
    if(connection) await connection.rollback();
    if(error.statusCode) return res.status(error.statusCode).json({success:false,message:error.message});
    console.error("Create course error:", error);
    return sendCourseWriteError(res, error, "Failed to add course.");
  } finally {connection?.release();}
}

export async function createLearningModule(req, res) {
  let fields = payloadToModuleFields(req.body);
  const validationMessage = validateModule(fields);

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    fields = await applyAuthenticatedProfessorFields(req, fields);

    const course = await getOrCreateCourse(fields, req.user);

    const quizContents = toJsonList(fields.quizItems);

    const lessonContents = toJsonList(fields.lessonPages);

    const [result] = await db.execute(
      `INSERT INTO learning_modules
       (
         course_id,
         title,
         description,
         subject,
         status,
         quiz_contents,
         learning_objectives,
         lesson_contents,
         has_quiz
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        getCourseId(course),
        fields.title,
        fields.description,
        fields.subject,
        fields.status,
        quizContents,
        fields.learningObjectives,
        lessonContents,
        fields.quizItems.length > 0 ? 1 : 0,
      ],
    );

    const rows = await getModuleRows("WHERE lm.lesson_id = ?", [
      result.insertId,
    ]);

    const module = rowToModule(rows[0]);

    /* =====================================================
       AUDIT LOG - CREATE LEARNING MODULE
    ===================================================== */

    await logAuditFromRequest(req, {
      category: "Learning Module Management",

      action: "Created Learning Module",

      target: module.title || fields.title || `Module ${result.insertId}`,

      status: "Success",

      details:
        `Created learning module ` +
        `"${module.title || fields.title}" ` +
        `for course "${module.courseName || fields.courseName || "Course"}".`,
    });

    return res.status(201).json({
      success: true,
      message: "Learning module added successfully.",
      module,
      course: module,
    });
  } catch (error) {
    console.error("Create learning module error:", error);

    return sendCourseWriteError(res, error, "Failed to add learning module.");
  }
}

export async function updateCourse(req, res) {
  let fields = payloadToCourseFields(req.body);
  const validationMessage = validateCourse(fields);
  const id = req.params.id || req.body.id || req.body.course_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    fields = await applyAuthenticatedProfessorFields(req, fields);

    const idColumn = await getCourseIdColumn();
    const [[existingClass]] = await db.execute(`SELECT * FROM courses WHERE ${idColumn}=?`,[id]);
    if(existingClass?.catalog_id) {
      fields.title=existingClass.title;
      fields.courseCode=existingClass.code;
      fields.subject=existingClass.subject;
      const [[catalogState]] = await db.execute("SELECT archived_at FROM course_catalog WHERE catalog_id=?", [existingClass.catalog_id]);
      if (catalogState?.archived_at) fields.archived = true;
    }
    const period = classPeriod({...existingClass,...req.body});
    const lessonPages = toJsonList(fields.lessonPages);
    const quizItems = toJsonList(fields.quizItems);
    const joinLink = `/student/join?courseCode=${encodeURIComponent(fields.courseCode)}`;
    const currentUser = await getRequestUserProfile(req);
    const where = [`${idColumn} = ?`];
    const whereParams = [id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("", currentUser);
      where.push(owner.sql);
      whereParams.push(...owner.params);
    }

    const [result] = await db.execute(
      `UPDATE courses
       SET title = ?,
           code = ?,
           summary = ?,
           subject = ?,
           professor_id = ?,
           course_name = ?,
           description = ?,
           course_code = ?,
           learning_objectives = ?,
           status = ?,
           visibility = ?,
           lesson_pages = ?,
           quiz_items = ?,
           students = ?,
           modules = ?,
           quizzes = ?,
           join_link = ?,
           archived = ?,
           professor_name = ?,
           professor_email = ?,
           professor_department = ?,
           professor_profile_image = ?,
           class_name=?,academic_year=?,semester=?,program=?,year_level=?,section_name=?,
           content_modules=?
       WHERE ${where.join(" AND ")}`,
      [
        fields.title,
        fields.courseCode,
        fields.summary,
        fields.subject,
        fields.professorId,
        fields.title,
        fields.summary,
        fields.courseCode,
        fields.learningObjectives,
        fields.status,
        fields.visibility,
        lessonPages,
        quizItems,
        fields.students,
        fields.moduleCount,
        fields.quizItems.length,
        joinLink,
        fields.archived ? 1 : 0,
        fields.professorName,
        fields.professorEmail,
        fields.professorDepartment,
        fields.professorProfileImage,
        period.class_name,period.academic_year,period.semester,period.program,period.year_level,period.section_name,
        (Array.isArray(req.body.contentModules)||Array.isArray(req.body.content_modules)) ? JSON.stringify(fields.contentModules) : existingClass.content_modules == null ? null : JSON.stringify(parseJsonList(existingClass.content_modules)),
        ...whereParams,
      ],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const [rows] = await db.execute(
      `SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`,
      [id],
    );
    const courseId = getCourseId(rows[0]);
    const modulesByCourse = await getCourseLearningModules([courseId]);
    const course = rowToCourse(
      rows[0],
      modulesByCourse.get(String(courseId)) || [],
    );

    await logAuditFromRequest(req, {
      category: "Course Management",
      action: "Updated Course",
      target: course.title || fields.title,
      status: "Success",
      details:
        `Updated course "${course.title || fields.title}" ` +
        `with course code ${course.courseCode || fields.courseCode}.`,
    });

    return res.json({
      success: true,
      message: "Course updated successfully.",
      course,
    });
  } catch (error) {
    console.error("Update course error:", error);
    return sendCourseWriteError(res, error, "Failed to update course.");
  }
}

export async function updateLearningModule(req, res) {
  let fields = payloadToModuleFields(req.body);

  const validationMessage = validateModule(fields);

  const id = req.params.id || req.body.id || req.body.lesson_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Learning module ID is required.",
    });
  }

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    fields = await applyAuthenticatedProfessorFields(req, fields);

    const course = await getOrCreateCourse(fields, req.user);

    const currentUser = await getRequestUserProfile(req);

    const where = ["lesson_id = ?"];
    const whereParams = [id];

    /*
     * Professors may update modules
     * only from courses they own.
     */
    if (isProfessorUser(currentUser)) {
      const idColumn = await getCourseIdColumn();

      const owner = getProfessorOwnerCondition("c", currentUser);

      where.push(
        `EXISTS (
           SELECT 1
           FROM courses c
           WHERE c.${idColumn} =
                 learning_modules.course_id
             AND ${owner.sql}
         )`,
      );

      whereParams.push(...owner.params);
    }

    const [result] = await db.execute(
      `UPDATE learning_modules
       SET
         course_id = ?,
         title = ?,
         description = ?,
         subject = ?,
         status = ?,
         quiz_contents = ?,
         learning_objectives = ?,
         lesson_contents = ?,
         has_quiz = ?
       WHERE ${where.join(" AND ")}`,
      [
        getCourseId(course),
        fields.title,
        fields.description,
        fields.subject,
        fields.status,
        toJsonList(fields.quizItems),
        fields.learningObjectives,
        toJsonList(fields.lessonPages),
        fields.quizItems.length > 0 ? 1 : 0,
        ...whereParams,
      ],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found or you do not have access to it.",
      });
    }

    const rows = await getModuleRows("WHERE lm.lesson_id = ?", [id]);

    const module = rowToModule(rows[0]);

    /* =====================================================
       AUDIT LOG - UPDATE LEARNING MODULE
    ===================================================== */

    await logAuditFromRequest(req, {
      category: "Learning Module Management",

      action: "Updated Learning Module",

      target: module.title || fields.title || `Module ${id}`,

      status: "Success",

      details:
        `Updated learning module ` +
        `"${module.title || fields.title}" ` +
        `for course "${module.courseName || fields.courseName || "Course"}".`,
    });

    return res.json({
      success: true,
      message: "Learning module updated successfully.",
      module,
      course: module,
    });
  } catch (error) {
    console.error("Update learning module error:", error);

    return sendCourseWriteError(
      res,
      error,
      "Failed to update learning module.",
    );
  }
}

export async function archiveCourse(req, res) {
  const id = req.params.id || req.body?.id || req.body?.course_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  const requestedArchived = req.body?.archived ?? req.body?.archive;

  const archived =
    requestedArchived === undefined ? true : isTruthy(requestedArchived);

  try {
    const idColumn = await getCourseIdColumn();
    const currentUser = await getRequestUserProfile(req);

    // Must be logged in
    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const role = normalizeRole(currentUser.role);

    const allowedRoles = ["super_admin", "superadmin", "admin", "professor"];

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to archive courses.",
      });
    }

    const where = [`${idColumn} = ?`];
    const params = [id];

    // Professors can archive ONLY their own courses.
    if (role === "professor") {
      if (!archived) {
        const [[catalogState]] = await db.execute(
          `SELECT c.archived_by_role,cc.archived_at
           FROM courses c
           LEFT JOIN course_catalog cc ON cc.catalog_id=c.catalog_id
           WHERE c.${idColumn}=?`,
          [id],
        );
        const archiveRole = normalizeRole(catalogState?.archived_by_role);
        if (
          ["admin", "super_admin", "superadmin"].includes(archiveRole) ||
          catalogState?.archived_at
        ) {
          const archivedBy = archiveRole === "super_admin" || archiveRole === "superadmin"
            ? "the Super Admin"
            : "an administrator";
          return res.status(409).json({
            success: false,
            message: `This course was archived by ${archivedBy}. Only an administrator can restore it.`,
          });
        }
        where.push("archived = 1");
        where.push("(archived_by_role IS NULL OR archived_by_role = 'professor')");
        where.push(
          "NOT EXISTS (SELECT 1 FROM course_catalog cc WHERE cc.catalog_id = courses.catalog_id AND cc.archived_at IS NOT NULL)",
        );
      } else {
        where.push("archived = 0");
        where.push(
          "NOT EXISTS (SELECT 1 FROM course_catalog cc WHERE cc.catalog_id = courses.catalog_id AND cc.archived_at IS NOT NULL)",
        );
      }
      const owner = getProfessorOwnerCondition("", currentUser);

      where.push(owner.sql);
      params.push(...owner.params);
    }

    const [result] = await db.execute(
      `UPDATE courses
       SET archived = ?, archived_by_role = ?
       WHERE ${where.join(" AND ")}`,
      [archived ? 1 : 0, archived ? (role === "superadmin" ? "super_admin" : role) : null, ...params],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message:
          role === "professor"
            ? "Course not found or you do not have access to it."
            : "Course not found.",
      });
    }

    const [rows] = await db.execute(
      `SELECT
         c.*,
         u.display_name AS database_professor_display_name,
         u.name AS database_professor_name,
         u.email AS database_professor_email,
         u.professor_department AS database_professor_department,
         u.profile_image AS database_professor_profile_image
       FROM courses c
       LEFT JOIN users u
         ON u.userId = c.professor_id
       WHERE c.${idColumn} = ?
       LIMIT 1`,
      [id],
    );

    const courseId = getCourseId(rows[0]);

    const modulesByCourse = await getCourseLearningModules([courseId]);

    const course = rowToCourse(
      rows[0],
      modulesByCourse.get(String(courseId)) || [],
    );

    /* =====================================================
        AUDIT LOG - ARCHIVE / RESTORE COURSE
      ===================================================== */

    await logAuditFromRequest(req, {
      category: "Course Management",

      action: archived ? "Archived Course" : "Restored Course",

      target: course.title || course.courseName || `Course ${id}`,

      status: "Success",

      details: archived
        ? `Archived course "${course.title || course.courseName || id}".`
        : `Restored course "${course.title || course.courseName || id}".`,
    });

    return res.json({
      success: true,
      message: archived
        ? "Course archived successfully."
        : "Course restored successfully.",
      course,
    });
  } catch (error) {
    console.error("Archive course error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update course archive status.",
    });
  }
}

export async function deleteCourse(req, res) {
  if (!(await authenticateDeletion(req, res))) return;
  const id = req.params.id || req.body.id || req.body.course_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    await assertCourseAccess(req.user, Number(id));
    const currentUser = await getRequestUserProfile(req);
    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const role = String(currentUser.role || "")
      .trim()
      .toLowerCase();

    const allowedRoles = ["super_admin", "superadmin", "admin", "professor"];

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete courses.",
      });
    }
    const where = [`${idColumn} = ?`];
    const params = [id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const result = await deleteWithSources({
      entity: "course",
      id,
      deleteSql: `DELETE FROM courses WHERE ${where.join(" AND ")}`,
      parameters: params,
    });

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    return res.json({
      success: true,
      message: "Course deleted successfully.",
    });
  } catch (error) {
    console.error("Delete course error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Failed to delete course.",
    });
  }
}

export async function deleteLearningModule(req, res) {
  if (!(await authenticateDeletion(req, res))) {
    return;
  }

  const id = req.params.id || req.body.id || req.body.lesson_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Learning module ID is required.",
    });
  }

  try {
    const currentUser = await getRequestUserProfile(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    /*
     * Load module BEFORE deleting it.
     * We need the module/course information
     * for authorization and the audit log.
     */
    const where = ["lm.lesson_id = ?"];

    const params = [id];

    /*
     * Professors may delete modules only
     * from courses they own.
     */
    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("c", currentUser);

      where.push(owner.sql);
      params.push(...owner.params);
    }

    const rows = await getModuleRows(`WHERE ${where.join(" AND ")}`, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found or you do not have access to it.",
      });
    }

    const module = rowToModule(rows[0]);

    /*
     * Extra RAG/course authorization check.
     */
    await assertCourseAccess(req.user, Number(module.courseId), Number(id));

    /*
     * Delete the learning module together
     * with its associated RAG sources.
     */
    const result = await deleteWithSources({
      entity: "lesson",
      id,
      deleteSql: "DELETE FROM learning_modules WHERE lesson_id = ?",
      parameters: [id],
    });

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found.",
      });
    }

    /* =====================================================
       AUDIT LOG - DELETE LEARNING MODULE
    ===================================================== */

    await logAuditFromRequest(req, {
      category: "Learning Module Management",

      action: "Deleted Learning Module",

      target: module.title || `Module ${id}`,

      status: "Success",

      details:
        `Deleted learning module ` +
        `"${module.title || id}" ` +
        `from course "${module.courseName || "Course"}".`,
    });

    return res.json({
      success: true,
      message: "Learning module deleted successfully.",
      moduleId: Number(id),
    });
  } catch (error) {
    console.error("Delete learning module error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Failed to delete learning module.",
    });
  }
}

export async function handleLegacyLearningModule(req, res) {
  if (req.method === "GET") {
    return getLearningModules(req, res);
  }

  const action = cleanText(req.body.action).toLowerCase();

  if (action === "delete") {
    return deleteLearningModule(req, res);
  }

  if (req.body.id || req.body.lesson_id) {
    req.params.id = req.body.id || req.body.lesson_id;
    return updateLearningModule(req, res);
  }

  return createLearningModule(req, res);
}

export async function approveEnrollment(req, res) {
  const enrollmentId = cleanText(req.params.enrollmentId);

  if (!enrollmentId) {
    return res.status(400).json({
      success: false,
      message: "Enrollment ID is required.",
    });
  }

  try {
    const currentUser = await getRequestUserProfile(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isProfessorUser(currentUser)) {
      return res.status(403).json({
        success: false,
        message: "Professor account is required.",
      });
    }

    const idColumn = await getCourseIdColumn();

    const owner = getProfessorOwnerCondition("c", currentUser);

    /*
     * Get enrollment + course information.
     */
    const [rows] = await db.execute(
      `SELECT
        ce.enrollment_id,
        ce.course_id,
        ce.user_id,
        ce.status,

        c.course_name,
        c.title AS course_title,
        c.course_code,

        s.email AS student_email,
        s.name AS student_name,
        s.display_name AS student_display_name

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

         INNER JOIN users s
           ON s.userId = ce.user_id

       WHERE ce.enrollment_id = ?
         AND ce.archived = 0
         AND ${owner.sql}

       LIMIT 1`,
      [enrollmentId, ...owner.params],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Enrollment request not found.",
      });
    }

    const enrollment = rows[0];

    if (enrollment.status === "approved") {
      return res.status(409).json({
        success: false,
        message: "Student is already approved.",
      });
    }

    if (enrollment.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending enrollment requests can be approved.",
      });
    }

    const courseName =
      enrollment.course_name ||
      enrollment.course_title ||
      enrollment.course_code ||
      "your course";

    const studentName =
      enrollment.student_display_name ||
      enrollment.student_name ||
      `Student ${enrollment.user_id}`;

    const professorName =
      cleanText(
        currentUser.displayName || currentUser.display_name || currentUser.name,
      ) || "Professor";

    const settings = await getSystemSettingsConfig();
    const [approved] = await db.execute(
      `UPDATE course_enrollments
       SET
         status = 'approved',
         approved_at = CURRENT_TIMESTAMP,
         rejection_reason = NULL,
         archived = 0
       WHERE enrollment_id = ? AND status = 'pending' AND archived = 0`,
      [enrollmentId],
    );
    if (!approved.affectedRows) {
      return res.status(409).json({
        success: false,
        message: "This enrollment request has already been updated.",
      });
    }

    // Update student count
    await db.execute(
      `UPDATE courses
       SET students = (
         SELECT COUNT(*)
         FROM course_enrollments
         WHERE course_id = ?
           AND status = 'approved'
           AND archived = 0
       )
       WHERE ${idColumn} = ?`,
      [enrollment.course_id, enrollment.course_id],
    );

    await notifyEnrollmentApproved(settings, {
      email: enrollment.student_email,
      studentName,
      courseName,
      notification: {
        recipientUserId: enrollment.user_id,
        courseId: enrollment.course_id,
        enrollmentId: Number(enrollmentId),
        createdByUserId: currentUser.userId || currentUser.id,
        createdByName: professorName,
        createdByRole: "professor",
      },
    });

    /* =====================================================
        AUDIT LOG - APPROVE ENROLLMENT
      ===================================================== */

    await logAuditFromRequest(req, {
      category: "Enrollment Management",
      action: "Approved Enrollment",
      target: studentName,
      status: "Success",
      details: `Approved ${studentName}'s enrollment in ` + `"${courseName}".`,
    });

    return res.json({
      success: true,
      message: "Student enrollment approved.",
      enrollmentId: Number(enrollmentId),
      courseId: enrollment.course_id,
      userId: enrollment.user_id,
      status: "approved",
    });
  } catch (error) {
    console.error("Approve enrollment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve enrollment.",
    });
  }
}

export async function declineEnrollment(req, res) {
  const enrollmentId = cleanText(req.params.enrollmentId);

  const rejectionReason = cleanText(
    req.body?.reason || req.body?.rejectionReason || req.body?.rejection_reason,
  );

  if (!enrollmentId) {
    return res.status(400).json({
      success: false,
      message: "Enrollment ID is required.",
    });
  }

  if (!rejectionReason) {
    return res.status(400).json({
      success: false,
      message: "Decline reason is required.",
    });
  }

  if (rejectionReason.length > 500) {
    return res.status(400).json({
      success: false,
      message: "Decline reason must be 500 characters or fewer.",
    });
  }

  try {
    const currentUser = await getRequestUserProfile(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isProfessorUser(currentUser)) {
      return res.status(403).json({
        success: false,
        message: "Professor account is required.",
      });
    }

    const idColumn = await getCourseIdColumn();

    const owner = getProfessorOwnerCondition("c", currentUser);

    const [rows] = await db.execute(
      `SELECT
         ce.enrollment_id,
         ce.course_id,
         ce.user_id,
         ce.status,

         u.email AS student_email,
         u.name AS student_name,
         u.display_name AS student_display_name,

         c.course_name,
         c.title AS course_title,
         c.course_code,
         c.code

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

       INNER JOIN users u
         ON u.userId = ce.user_id

       WHERE ce.enrollment_id = ?
         AND ce.archived = 0
         AND ${owner.sql}

       LIMIT 1`,
      [enrollmentId, ...owner.params],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Enrollment request not found or you do not have access to it.",
      });
    }

    const enrollment = rows[0];

    if (enrollment.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending enrollment requests can be declined.",
      });
    }

    const settings = await getSystemSettingsConfig();
    const [declined] = await db.execute(
      `UPDATE course_enrollments
       SET
         status = 'declined',
         approved_at = NULL,
         rejection_reason = ?
       WHERE enrollment_id = ? AND status = 'pending' AND archived = 0`,
      [rejectionReason, enrollmentId],
    );
    if (!declined.affectedRows) {
      return res.status(409).json({
        success: false,
        message: "This enrollment request has already been updated.",
      });
    }

    const studentEmail = enrollment.student_email;

    const studentName =
      enrollment.student_display_name || enrollment.student_name || "Student";

    const courseName =
      enrollment.course_name || enrollment.course_title || "Course";

    const courseCode = enrollment.course_code || enrollment.code || "";

    const professorName =
      cleanText(
        currentUser.displayName || currentUser.display_name || currentUser.name,
      ) || "Professor";

    /*
     * SEND EMAIL
     */
    let emailSent = false;
    let emailError = null;

    if (settings.enrollmentDeclinedEmail && !studentEmail) {
      emailError =
        "The enrollment was declined, but the student does not have an email address.";
    } else if (settings.enrollmentDeclinedEmail) {
      try {
        await sendEnrollmentDeclinedEmail(
          studentEmail,
          studentName,
          courseName,
          courseCode,
          rejectionReason,
        );

        emailSent = true;

        console.log(
          `Enrollment decline email sent successfully to ${studentEmail}`,
        );
      } catch (error) {
        console.error("Failed to send enrollment decline email:", error);

        emailError = error?.message || "The email could not be sent.";
      }
    }

    if (settings.enrollmentSystemNotification) {
      try {
        await createNotification({
          recipientUserId: enrollment.user_id,
          courseId: enrollment.course_id,
          enrollmentId: Number(enrollmentId),
          title: "Enrollment Request Declined",
          message: `Your enrollment request for ${courseName} was declined. Reason: ${rejectionReason}`,
          target: "student",
          type: "enrollment_declined",
          createdByUserId: currentUser.userId || currentUser.id,
          createdByName: professorName,
          createdByRole: "professor",
        });
      } catch (error) {
        console.error("Failed to create decline notification:", error);
      }
    }
    /* =====================================================
        AUDIT LOG - DECLINE ENROLLMENT
      ===================================================== */

    await logAuditFromRequest(req, {
      category: "Enrollment Management",
      action: "Declined Enrollment",
      target: studentName,
      status: "Success",
      details:
        `Declined ${studentName}'s enrollment in ` +
        `"${courseName}". Reason: ${rejectionReason}`,
    });

    return res.status(200).json({
      success: true,
      declined: true,
      emailSent,

      message: emailSent
        ? "Enrollment declined and email sent successfully."
        : "Enrollment declined.",
      emailEnabled: settings.enrollmentDeclinedEmail,

      emailError,

      enrollmentId: Number(enrollmentId),

      courseId: enrollment.course_id,

      userId: enrollment.user_id,

      status: "declined",

      rejectionReason,
    });
  } catch (error) {
    console.error("Decline enrollment error:", error);

    return res.status(500).json({
      success: false,
      declined: false,
      emailSent: false,

      message: error?.message || "Failed to decline enrollment request.",
    });
  }
}
