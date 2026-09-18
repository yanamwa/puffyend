import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { db } from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET || "puffybrain-secret";

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
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function getRequestUserId(req) {
  const explicitId =
    req.body?.userId || req.body?.user_id || req.query.userId || req.query.user_id;

  if (explicitId) {
    return explicitId;
  }

  const decoded = getTokenUser(req);

  return decoded?.id || decoded?.userId || decoded?.user_id || null;
}

function normalizeRole(role) {
  const value = cleanText(role).toLowerCase().replace(/[\s-]+/g, "_");

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
        [userId]
      );
    } else if (email) {
      [rows] = await db.execute(
        `SELECT userId, email, role, name, display_name,
                professor_department, profile_image
         FROM users
         WHERE LOWER(email) = ?
         LIMIT 1`,
        [email]
      );
    }

    if (rows.length) {
      const user = rows[0];

      return {
        ...tokenUser,
        id: user.userId,
        userId: user.userId,
        email: user.email,
        role: user.role,
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
  const professorEmail = cleanText(fields.professorEmail || fields.professor_email).toLowerCase();
  const courseProfessorId = cleanText(course?.professor_id || course?.professorId);
  const courseProfessorEmail = cleanText(
    course?.professor_email || course?.professorEmail
  ).toLowerCase();

  if (professorId && courseProfessorId && professorId === courseProfessorId) {
    return true;
  }

  if (professorEmail && courseProfessorEmail && professorEmail === courseProfessorEmail) {
    return true;
  }

  return false;
}

async function applyAuthenticatedProfessorFields(req, fields) {
  const currentUser = await getRequestUserProfile(req);

  if (!isProfessorUser(currentUser)) {
    return fields;
  }

  const professorId = currentUser.id || currentUser.userId || currentUser.user_id || null;
  const professorName =
    cleanText(currentUser.displayName || currentUser.display_name || currentUser.name) ||
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
        fields.professorDepartment
    ),
    professorProfileImage: cleanText(
      currentUser.profileImage ||
        currentUser.profile_image ||
        fields.professorProfileImage
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

function normalizeContentModule(module, index) {
  const lessonPages = readList(
    module?.lessonPages,
    module?.lesson_pages,
    module?.lessonContent,
    module?.lesson_content,
    module?.lesson_contents
  );

  const quizItems = readList(
    module?.quizItems,
    module?.quiz_items,
    module?.quizModule,
    module?.quiz_contents
  );

  return {
    id: module?.id || module?.lesson_id || module?.module_id || `module-${index + 1}`,
    lesson_id: module?.lesson_id || null,
    module_id: module?.module_id || module?.id || null,
    title: cleanText(module?.title) || `Module ${index + 1}`,
    description: cleanText(module?.description || module?.module_description || module?.summary),
    summary: cleanText(module?.description || module?.module_description || module?.summary),
    learningObjectives: cleanText(module?.learningObjectives || module?.learning_objectives),
    learning_objectives: cleanText(module?.learning_objectives || module?.learningObjectives),
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
        module.quizItems.length
    );
}

function getModuleMeta(module, index) {
  const moduleId = module.id || module.module_id || module.lesson_id || `module-${index + 1}`;

  return {
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
    }))
  );
}

function flattenModuleQuizItems(contentModules) {
  return contentModules.flatMap((module, moduleIndex) =>
    module.quizItems.map((item) => ({
      ...item,
      ...getModuleMeta(module, moduleIndex),
    }))
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

function buildContentModulesFromFlatContent(lessonPages, quizItems, fallback = {}) {
  const modules = new Map();

  const ensureModule = (item, fallbackIndex = 0) => {
    const key = getModuleKeyFromItem(item, fallbackIndex);
    if (!key) return null;

    if (!modules.has(key)) {
      const moduleIndex = Number(item?.moduleIndex ?? item?.module_index);
      const order = Number.isInteger(moduleIndex) ? moduleIndex : modules.size;
      const moduleId = item?.moduleId || item?.module_id || `module-${order + 1}`;
      const title = cleanText(item?.moduleTitle || item?.module_title) || `Module ${order + 1}`;
      const description = cleanText(
        item?.moduleDescription || item?.module_description || fallback.summary
      );
      const learningObjectives = cleanText(
        item?.moduleLearningObjectives ||
          item?.module_learning_objectives ||
          fallback.learningObjectives
      );

      modules.set(key, {
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

function buildCourseContentModules(learningModules, lessonPages, quizItems, fallback = {}) {
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
        index
      )
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
  return cleanText(visibility).toLowerCase() === "public" ? "public" : "private";
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
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'courses'
       AND COLUMN_NAME IN ('course_id', 'id')`
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
  const contentModules = buildCourseContentModules(learningModules, storedLessonPages, storedQuizItems, {
    summary: row.summary || row.description || "",
    learningObjectives: row.learning_objectives || "",
  });
  const fallbackLessonPages = contentModules.flatMap((module) => module.lessonPages || []);
  const fallbackQuizItems = contentModules.flatMap((module) => module.quizItems || []);
  const lessonPages = storedLessonPages.length ? storedLessonPages : fallbackLessonPages;
  const quizItems = storedQuizItems.length ? storedQuizItems : fallbackQuizItems;
  const courseCode = row.course_code || row.code || "";
  const courseName = row.course_name || row.title || row.subject || courseCode;
  const summary = row.summary || row.description || "";
  const pageCount = lessonPages.length;
  const quizCount = quizItems.length || Number(row.quizzes || 0);
  const moduleCount = contentModules.length || Number(row.modules || 0);

  return {
    id: courseId,
    course_id: courseId,
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
    professorId: row.professor_id || null,
    professorDisplayName:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professor_display_name:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professorName:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professor_name:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professorEmail: row.professor_email || row.database_professor_email || "",
    professor_email: row.professor_email || row.database_professor_email || "",
    professorDepartment: row.professor_department || row.database_professor_department || "",
    professor_department: row.professor_department || row.database_professor_department || "",
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
  const courseName = row.course_name || row.course_subject || row.course_title || courseCode;
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
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professor_display_name:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professorName:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professor_name:
      row.professor_name || row.database_professor_display_name || row.database_professor_name || "",
    professorEmail: row.professor_email || row.database_professor_email || "",
    professor_email: row.professor_email || row.database_professor_email || "",
    professorDepartment: row.professor_department || row.database_professor_department || "",
    professor_department: row.professor_department || row.database_professor_department || "",
    professorProfileImage:
      row.professor_profile_image || row.database_professor_profile_image || "",
    professor_profile_image:
      row.professor_profile_image || row.database_professor_profile_image || "",
    createdAt: formatDate(row.created_at),
    updatedAt,
  };
}

function payloadToModuleFields(body) {
  const courseCode = cleanText(body.courseCode || body.course_code || body.code).toUpperCase();
  const courseName = cleanText(
    body.courseName || body.course_name || body.courseTitle || body.subject || courseCode
  );
  const courseDescription = cleanText(
    body.courseDescription || body.course_description || body.courseSummary || body.summary
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
    courseStatus: normalizeStatus(body.courseStatus || body.course_status || body.status),
    courseVisibility: normalizeVisibility(body.visibility),
    professorId: body.professorId || body.professor_id || null,
    professorName: cleanText(body.professorName || body.professor_name),
    professorEmail: cleanText(body.professorEmail || body.professor_email),
    professorDepartment: cleanText(body.professorDepartment || body.professor_department),
    professorProfileImage: cleanText(
      body.professorProfileImage || body.professor_profile_image
    ),
    title: cleanText(body.title),
    description: cleanText(body.description || body.module_description || body.summary),
    subject: cleanText(body.subject || courseName),
    learningObjectives: cleanText(body.learningObjectives || body.learning_objectives),
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
    body.title || body.courseTitle || body.course_title || body.courseName || body.course_name
  );
  const summary = cleanText(
    body.summary || body.description || body.courseDescription || body.course_description
  );
  const providedLessonPages = readList(
    body.lessonPages,
    body.lessonContent,
    body.lesson_content,
    body.lesson_pages
  );
  const providedQuizItems = readList(
    body.quizItems,
    body.quizModule,
    body.quiz_contents,
    body.quiz_items
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
  const countedModuleCount = countContentModules(contentModules, lessonPages, quizItems);
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
    professorDepartment: cleanText(body.professorDepartment || body.professor_department),
    professorProfileImage: cleanText(
      body.professorProfileImage || body.professor_profile_image
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
  if (!fields.courseCode) {
    return "Course code is required.";
  }

  if (!fields.title || !fields.summary || !fields.subject) {
    return "Course title, description, and subject are required.";
  }

  if (!fields.learningObjectives || fields.lessonPages.length === 0) {
    return "Learning objectives and at least one lesson page are required.";
  }

  return "";
}

function duplicateCourseCode(error) {
  return error?.code === "ER_DUP_ENTRY" && String(error?.message || "").includes("code");
}

async function sendCourseWriteError(res, error, fallbackMessage) {
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

async function getOrCreateCourse(fields) {
  const idColumn = await getCourseIdColumn();

  if (fields.courseId) {
    const [rows] = await db.execute(`SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`, [
      fields.courseId,
    ]);

    if (rows.length > 0) return rows[0];
  }

  const [existing] = await db.execute(
    `SELECT *
     FROM courses
     WHERE course_code = ? OR code = ?
     LIMIT 1`,
    [fields.courseCode, fields.courseCode]
  );

  if (existing.length > 0) {
    if (
      (fields.professorId || fields.professorEmail) &&
      !courseMatchesProfessorFields(existing[0], fields)
    ) {
      const error = new Error("A course with that code already exists.");
      error.code = "ER_DUP_ENTRY";
      throw error;
    }

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
      ]
    );

    const [updated] = await db.execute(`SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`, [
      getCourseId(existing[0]),
    ]);
    return updated[0];
  }

  const [result] = await db.execute(
    `INSERT INTO courses
     (title, code, summary, subject, professor_id, course_name, description,
      course_code, status, visibility, join_link, archived, professor_name,
      professor_email, professor_department, professor_profile_image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      fields.courseName,
      fields.courseCode,
      fields.courseDescription,
      fields.courseName,
      fields.professorId,
      fields.courseName,
      fields.courseDescription,
      fields.courseCode,
      fields.courseStatus,
      fields.courseVisibility,
      `/student/join?courseCode=${encodeURIComponent(fields.courseCode)}`,
      fields.professorName,
      fields.professorEmail,
      fields.professorDepartment,
      fields.professorProfileImage,
    ]
  );

  const [rows] = await db.execute(`SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`, [
    result.insertId,
  ]);
  return rows[0];
}

async function getCourseLearningModules(courseIds) {
  if (!courseIds.length) return new Map();

  const placeholders = courseIds.map(() => "?").join(", ");
  const rows = await getModuleRows(`WHERE lm.course_id IN (${placeholders})`, courseIds);
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
    params
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
         u.profile_image AS database_professor_profile_image
       FROM courses c
       LEFT JOIN users u ON u.userId = c.professor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.updated_at DESC, c.${idColumn} DESC`,
      params
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(courseRows.map(getCourseId));

    const courses = courseRows.map((course) =>
      rowToCourse(course, modulesByCourse.get(String(getCourseId(course))) || [])
    );

    return res.json({
      success: true,
      courses,
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

    const where = [
      "ce.user_id = ?",
      "ce.status = 'approved'",
    ];

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
      params
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(
          courseRows.map(getCourseId)
        );

    const courses = courseRows.map((course) => ({
      ...rowToCourse(
        course,
        modulesByCourse.get(
          String(getCourseId(course))
        ) || []
      ),

      enrollmentId: course.enrollment_id,
      enrollmentStatus: course.enrollment_status,
      approvedAt: course.approved_at,
    }));

    return res.json({
      success: true,
      courses,
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
      [userId]
    );

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules(
          courseRows.map(getCourseId)
        );

    const courses = courseRows.map((course) =>
      rowToCourse(
        course,
        modulesByCourse.get(
          String(getCourseId(course))
        ) || []
      )
    );

    return res.json({
      success: true,
      courses,
    });
  } catch (error) {
    console.error(
      "Get archived courses error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch archived courses.",
    });
  }
}

export async function enrollCourse(req, res) {
  const userId = getRequestUserId(req);

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
      req.query?.id
  );

  const courseCode = cleanText(
    req.body?.courseCode ||
      req.body?.course_code ||
      req.body?.code ||
      req.query?.courseCode ||
      req.query?.course_code ||
      req.query?.code
  ).toUpperCase();

  if (!courseId && !courseCode) {
    return res.status(400).json({
      success: false,
      message: "Course ID or course code is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();

    const conditions = [
      "c.archived = 0",
      "c.status = 'published'",
    ];

    const params = [];

    if (courseId) {
      conditions.push(`c.${idColumn} = ?`);
      params.push(courseId);
    } else {
      conditions.push("(c.course_code = ? OR c.code = ?)");
      params.push(courseCode, courseCode);
    }

    const [rows] = await db.execute(
      `SELECT c.*
       FROM courses c
       WHERE ${conditions.join(" AND ")}
       LIMIT 1`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or unavailable for enrollment.",
      });
    }

    const selectedCourseId = getCourseId(rows[0]);

    /*
     * Check whether the student already has
     * an enrollment record.
     */
    const [existingRows] = await db.execute(
      `SELECT *
       FROM course_enrollments
       WHERE course_id = ?
         AND user_id = ?
       LIMIT 1`,
      [selectedCourseId, userId]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];

      if (
        existing.status === "approved" &&
        !existing.archived
      ) {
        return res.status(409).json({
          success: false,
          status: "approved",
          message: "You are already enrolled in this course.",
        });
      }

      if (
        existing.status === "pending" &&
        !existing.archived
      ) {
        return res.status(409).json({
          success: false,
          status: "pending",
          message: "Your enrollment request is already pending approval.",
        });
      }

      /*
       * Previously declined or archived.
       * Allow student to request again.
       */
      await db.execute(
        `UPDATE course_enrollments
         SET
           status = 'pending',
           archived = 0,
           approved_at = NULL,
           rejection_reason = NULL,
           created_at = CURRENT_TIMESTAMP
         WHERE enrollment_id = ?`,
        [existing.enrollment_id]
      );

      return res.json({
        success: true,
        pending: true,
        enrolled: false,
        enrollmentId: existing.enrollment_id,
        message: "Enrollment request sent. Waiting for professor approval.",
      });
    }

    /*
     * First enrollment request.
     */
    const [result] = await db.execute(
      `INSERT INTO course_enrollments (
         course_id,
         user_id,
         status,
         approved_at,
         archived
       )
       VALUES (?, ?, 'pending', NULL, 0)`,
      [selectedCourseId, userId]
    );

    return res.status(201).json({
      success: true,
      pending: true,
      enrolled: false,
      enrollmentId: result.insertId,
      message: "Enrollment request sent. Waiting for professor approval.",
    });
  } catch (error) {
    console.error("Enrollment request error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to send enrollment request.",
    });
  }
}

export async function getCourseEnrollments(req, res) {
  const courseId = cleanText(
    req.params.courseId ||
    req.params.id
  );

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
    const owner = getProfessorOwnerCondition(
      "c",
      currentUser
    );

    const [courseRows] = await db.execute(
      `SELECT c.${idColumn} AS course_id
       FROM courses c
       WHERE c.${idColumn} = ?
         AND ${owner.sql}
       LIMIT 1`,
      [
        courseId,
        ...owner.params,
      ]
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
      [courseId]
    );

    const pending = rows.filter(
      (row) => row.status === "pending"
    );

    const enrolled = rows.filter(
      (row) => row.status === "approved"
    );

    const declined = rows.filter(
      (row) => row.status === "declined"
    );

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
    console.error(
      "Get course enrollments error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch course enrollments.",
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
      req.query?.course_id
  );

  if (!courseId) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();

    const [result] = await db.execute(
      `UPDATE course_enrollments
       SET archived = 1
       WHERE course_id = ?
         AND user_id = ?
         AND status = 'approved'
         AND archived = 0`,
      [courseId, userId]
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
      [courseId, courseId]
    );

    return res.json({
      success: true,
      message: "Course moved to Archived Classes.",
      courseId,
    });
  } catch (error) {
    console.error(
      "Unenroll course error:",
      error
    );

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
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const courseId = getCourseId(rows[0]);
    const modulesByCourse = await getCourseLearningModules([courseId]);
    const course = rowToCourse(rows[0], modulesByCourse.get(String(courseId)) || []);

    return res.json({
      success: true,
      course,
    });
  } catch (error) {
    console.error("Get course error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch course.",
    });
  }
}

export async function joinCourseByCode(req, res) {
  const courseCode = cleanText(
    req.body?.courseCode ||
      req.body?.course_code ||
      req.body?.code ||
      req.query.courseCode ||
      req.query.code
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
      [courseCode, courseCode]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Course code not found. Please check the code from your professor.",
      });
    }

    const userId = getRequestUserId(req);

let enrolled = false;
let pending = false;
let enrollmentCreated = false;

if (userId) {
  const [existingRows] = await db.execute(
    `SELECT *
     FROM course_enrollments
     WHERE course_id = ?
       AND user_id = ?
     LIMIT 1`,
    [courseId, userId]
  );

  if (existingRows.length > 0) {
    const existing = existingRows[0];

    if (
      existing.status === "approved" &&
      !existing.archived
    ) {
      enrolled = true;
    } else if (
      existing.status === "pending" &&
      !existing.archived
    ) {
      pending = true;
    } else {
      await db.execute(
        `UPDATE course_enrollments
         SET
         status = 'pending',
         approved_at = NULL,
         rejection_reason = NULL,
         archived = 0,
         created_at = CURRENT_TIMESTAMP
       WHERE enrollment_id = ?`,
        [existing.enrollment_id]
      );

      pending = true;
    }
  } else {
    await db.execute(
      `INSERT INTO course_enrollments (
         course_id,
         user_id,
         status,
         approved_at,
         archived
       )
       VALUES (?, ?, 'pending', NULL, 0)`,
      [courseId, userId]
    );

    pending = true;
    enrollmentCreated = true;
  }
}

    const modulesByCourse = summaryOnly
      ? new Map()
      : await getCourseLearningModules([
          courseId,
        ]);

    const [updatedRows] =
      await db.execute(
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
         WHERE c.${idColumn} = ?
         LIMIT 1`,
        [courseId]
      );

    const course = rowToCourse(
      updatedRows[0] || rows[0],
      modulesByCourse.get(
        String(courseId)
      ) || []
    );

    return res.json({
        success: true,
        enrolled,
        pending,
        enrollmentCreated,

        message: enrolled
          ? "You are already enrolled in this course."
          : pending
            ? "Enrollment request sent. Waiting for professor approval."
            : "Course found.",

        course,
      });
  } catch (error) {
    console.error(
      "Join course by code error:",
      error
    );

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
      params
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
  let fields = payloadToCourseFields(req.body);
  const validationMessage = validateCourse(fields);

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    fields = await applyAuthenticatedProfessorFields(req, fields);

    const idColumn = await getCourseIdColumn();
    const lessonPages = toJsonList(fields.lessonPages);
    const quizItems = toJsonList(fields.quizItems);
    const joinLink = `/student/join?courseCode=${encodeURIComponent(fields.courseCode)}`;

    const [result] = await db.execute(
      `INSERT INTO courses
       (title, code, summary, subject, professor_id, course_name, description,
        course_code, learning_objectives, status, visibility, lesson_pages,
        quiz_items, students, modules, quizzes, join_link, archived,
        professor_name, professor_email, professor_department,
        professor_profile_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );

    const [rows] = await db.execute(`SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`, [
      result.insertId,
    ]);
    const course = rowToCourse(rows[0], []);

    return res.status(201).json({
      success: true,
      message: "Course added successfully.",
      course,
    });
  } catch (error) {
    console.error("Create course error:", error);
    return sendCourseWriteError(res, error, "Failed to add course.");
  }
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

    const course = await getOrCreateCourse(fields);
    const quizContents = toJsonList(fields.quizItems);
    const lessonContents = toJsonList(fields.lessonPages);

    const [result] = await db.execute(
      `INSERT INTO learning_modules
       (course_id, title, description, subject, status, quiz_contents,
        learning_objectives, lesson_contents, has_quiz)
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
      ]
    );

    const rows = await getModuleRows("WHERE lm.lesson_id = ?", [result.insertId]);
    const module = rowToModule(rows[0]);

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
           professor_profile_image = ?
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
        ...whereParams,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const [rows] = await db.execute(`SELECT * FROM courses WHERE ${idColumn} = ? LIMIT 1`, [id]);
    const courseId = getCourseId(rows[0]);
    const modulesByCourse = await getCourseLearningModules([courseId]);
    const course = rowToCourse(rows[0], modulesByCourse.get(String(courseId)) || []);

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

    const course = await getOrCreateCourse(fields);
    const currentUser = await getRequestUserProfile(req);
    const where = ["lesson_id = ?"];
    const whereParams = [id];

    if (isProfessorUser(currentUser)) {
      const idColumn = await getCourseIdColumn();
      const owner = getProfessorOwnerCondition("c", currentUser);
      where.push(
        `EXISTS (
           SELECT 1
           FROM courses c
           WHERE c.${idColumn} = learning_modules.course_id
             AND ${owner.sql}
         )`
      );
      whereParams.push(...owner.params);
    }

    const [result] = await db.execute(
      `UPDATE learning_modules
       SET course_id = ?,
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
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found.",
      });
    }

    const rows = await getModuleRows("WHERE lm.lesson_id = ?", [id]);
    const module = rowToModule(rows[0]);

    return res.json({
      success: true,
      message: "Learning module updated successfully.",
      module,
      course: module,
    });
  } catch (error) {
    console.error("Update learning module error:", error);

    return sendCourseWriteError(res, error, "Failed to update learning module.");
  }
}

export async function archiveCourse(req, res) {
  const id = req.params.id || req.body.id || req.body.course_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  const requestedArchived = req.body?.archived ?? req.body?.archive;
  const archived = requestedArchived === undefined ? true : isTruthy(requestedArchived);

  try {
    const idColumn = await getCourseIdColumn();
    const currentUser = await getRequestUserProfile(req);
    const where = [`${idColumn} = ?`];
    const params = [id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const [result] = await db.execute(
      `UPDATE courses
       SET archived = ?
       WHERE ${where.join(" AND ")}`,
      [archived ? 1 : 0, ...params]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
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
       LEFT JOIN users u ON u.userId = c.professor_id
       WHERE c.${idColumn} = ?
       LIMIT 1`,
      [id]
    );

    const courseId = getCourseId(rows[0]);
    const modulesByCourse = await getCourseLearningModules([courseId]);
    const course = rowToCourse(rows[0], modulesByCourse.get(String(courseId)) || []);

    return res.json({
      success: true,
      message: archived ? "Course archived successfully." : "Course restored successfully.",
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
  const id = req.params.id || req.body.id || req.body.course_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    const currentUser = await getRequestUserProfile(req);
    const where = [`${idColumn} = ?`];
    const params = [id];

    if (isProfessorUser(currentUser)) {
      const owner = getProfessorOwnerCondition("", currentUser);
      where.push(owner.sql);
      params.push(...owner.params);
    }

    const [result] = await db.execute(
      `DELETE FROM courses WHERE ${where.join(" AND ")}`,
      params
    );

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

    return res.status(500).json({
      success: false,
      message: "Failed to delete course.",
    });
  }
}

export async function deleteLearningModule(req, res) {
  const id = req.params.id || req.body.id || req.body.lesson_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Learning module ID is required.",
    });
  }

  try {
    const [result] = await db.execute(
      "DELETE FROM learning_modules WHERE lesson_id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Learning module not found.",
      });
    }

    return res.json({
      success: true,
      message: "Learning module deleted successfully.",
    });
  } catch (error) {
    console.error("Delete learning module error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete learning module.",
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
  const enrollmentId = cleanText(
    req.params.enrollmentId
  );

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

    const owner = getProfessorOwnerCondition(
      "c",
      currentUser
    );

    /*
     * Find request and verify that the
     * professor owns the course.
     */
    const [rows] = await db.execute(
      `SELECT
         ce.enrollment_id,
         ce.course_id,
         ce.user_id,
         ce.status

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

       WHERE ce.enrollment_id = ?
         AND ce.archived = 0
         AND ${owner.sql}

       LIMIT 1`,
      [
        enrollmentId,
        ...owner.params,
      ]
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

    await db.execute(
      `UPDATE course_enrollments
       SET
         status = 'approved',
         approved_at = CURRENT_TIMESTAMP,
         rejection_reason = NULL,
         archived = 0
       WHERE enrollment_id = ?`,
      [enrollmentId]
    );

    /*
     * Recalculate approved student count.
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
      [
        enrollment.course_id,
        enrollment.course_id,
      ]
    );

    return res.json({
      success: true,
      message: "Student enrollment approved.",
      enrollmentId: Number(enrollmentId),
      courseId: enrollment.course_id,
      userId: enrollment.user_id,
      status: "approved",
    });
  } catch (error) {
    console.error(
      "Approve enrollment error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to approve enrollment.",
    });
  }
}

export async function declineEnrollment(req, res) {
  const enrollmentId = cleanText(
    req.params.enrollmentId
  );
  const rejectionReason = cleanText(
    req.body?.reason ||
    req.body?.rejectionReason ||
    req.body?.rejection_reason
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
      message: "Please provide a reason for rejecting this enrollment request.",
    });
  }

  if (rejectionReason.length > 500) {
    return res.status(400).json({
      success: false,
      message: "Reject reason must be 500 characters or fewer.",
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

    const owner = getProfessorOwnerCondition(
      "c",
      currentUser
    );

    const [rows] = await db.execute(
      `SELECT
         ce.enrollment_id,
         ce.course_id,
         ce.user_id,
         ce.status

       FROM course_enrollments ce

       INNER JOIN courses c
         ON c.${idColumn} = ce.course_id

       WHERE ce.enrollment_id = ?
         AND ce.archived = 0
         AND ${owner.sql}

       LIMIT 1`,
      [
        enrollmentId,
        ...owner.params,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Enrollment request not found.",
      });
    }

    const enrollment = rows[0];

    if (enrollment.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending enrollment requests can be declined.",
      });
    }

    await db.execute(
      `UPDATE course_enrollments
       SET
         status = 'declined',
         approved_at = NULL,
         rejection_reason = ?
       WHERE enrollment_id = ?`,
      [rejectionReason, enrollmentId]
    );

    return res.json({
      success: true,
      message: "Enrollment request declined.",
      enrollmentId: Number(enrollmentId),
      courseId: enrollment.course_id,
      userId: enrollment.user_id,
      status: "declined",
      rejectionReason,
    });
  } catch (error) {
    console.error(
      "Decline enrollment error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to decline enrollment.",
    });
  }
}
