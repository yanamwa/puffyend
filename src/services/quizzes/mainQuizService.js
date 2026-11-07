import { db } from "../../db.js";
import { embedTexts, embeddingConfig } from "../rag/embeddingService.js";
import { assertCourseAccess, requestError } from "../rag/courseAccessService.js";
import { loadChunks } from "../rag/vectorRepository.js";
import { retrieveContexts } from "../rag/retrievalService.js";
import { generateQuizBatch } from "../rag/quizRagService.js";
import { createMainQuizPrompt } from "./mainQuizPrompt.js";
import {
  validateMainSettings,
  mainQuizBlueprint,
  validateAdaptiveQuestions,
  gradeMainQuiz,
  shuffleMainQuizQuestions,
} from "./mainQuizAdaptive.js";
const parse = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
export async function initMainQuizTables() {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS main_quiz_configs (course_id INT NOT NULL, module_id VARCHAR(100) NOT NULL, revision INT NOT NULL DEFAULT 1, config_json LONGTEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY(course_id,module_id))`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS personalized_main_quizzes (quiz_id INT AUTO_INCREMENT PRIMARY KEY, course_id INT NOT NULL, module_id VARCHAR(100) NOT NULL, user_id INT NOT NULL, revision INT NOT NULL, practice_attempt_id INT NOT NULL, questions_json LONGTEXT NOT NULL, blueprint_json LONGTEXT NOT NULL, config_json LONGTEXT NOT NULL, submissions INT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY personalized_quiz_unique(course_id,module_id,user_id,revision))`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS main_quiz_results (result_id INT AUTO_INCREMENT PRIMARY KEY, quiz_id INT NOT NULL, user_id INT NOT NULL, attempts_id INT NOT NULL, result_json LONGTEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  );
}
async function studentAccess(user, courseId, moduleId) {
  if (user.role !== "student")
    throw requestError("Only enrolled students can take Main Quiz.", 403);
  const [enrollments] = await db.execute(
    "SELECT user_id FROM course_enrollments WHERE course_id=? AND user_id=? AND status='approved'",
    [courseId, user.userId],
  );
  if (!enrollments.length)
    throw requestError("You are not enrolled in this course.", 403);
  const [courses] = await db.execute(
    "SELECT lesson_pages AS lesson_contents, quiz_items AS quiz_contents, content_modules FROM courses WHERE course_id=?",
    [courseId],
  );
  const publicationModules = parse(courses[0]?.content_modules || "[]");
  if (publicationModules.some(m => m.studentPublished !== undefined)) {
    const publishedModule = publicationModules.find(m => String(m.id ?? m.module_id) === String(moduleId));
    if (publishedModule?.studentPublished !== true)
      throw requestError("This module has not been uploaded to students yet.", 403);
  }
  const content = [
    ...parse(courses[0]?.lesson_contents || "[]"),
    ...parse(courses[0]?.quiz_contents || "[]"),
  ];
  const module = content.find(
    (item) => String(item.moduleId ?? item.module_id) === String(moduleId),
  );
  if (!module) throw requestError("Module no longer exists.", 404);
  const settings = module.mainQuizSettings || {};
  if (
    [false, 0, "false", "0"].includes(settings.enabled) ||
    (settings.unlockAt && new Date(settings.unlockAt) > new Date()) ||
    (settings.lockAt && new Date(settings.lockAt) <= new Date())
  )
    throw requestError("Main Quiz is currently locked.", 403);
  return module;
}
export async function saveMainConfig(user, body) {
  let settings;
  try {
    settings = validateMainSettings(body);
  } catch (error) {
    throw requestError(error.message, 400);
  }
  const courseId = Number(body.course_id),
    moduleId = String(body.module_id || "");
  if (!moduleId || moduleId.length > 100)
    throw requestError("A saved module_id is required.", 400);
  await assertCourseAccess(user, courseId);
  const [courses] = await db.execute(
    "SELECT lesson_pages AS lesson_contents, quiz_items AS quiz_contents FROM courses WHERE course_id=?",
    [courseId],
  );
  const content = [
    ...parse(courses[0]?.lesson_contents || "[]"),
    ...parse(courses[0]?.quiz_contents || "[]"),
  ];
  const module = content.find(
    (item) => String(item.moduleId ?? item.module_id) === moduleId,
  );
  if (!module)
    throw requestError("Save the module before configuring Main Quiz.", 409);
  const documentIds = [
    ...new Set(
      content
        .filter((item) => String(item.moduleId ?? item.module_id) === moduleId)
        .flatMap((item) => [
          ...(item.source_document_ids || []),
          ...(item.source_document_id ? [item.source_document_id] : []),
          ...(item.source_chunks || []).map((chunk) => chunk.document_id),
          ...(item.statements || []).flatMap((statement) =>
            (statement.citations || []).map((citation) => citation.document_id),
          ),
        ])
        .filter((value) => value != null)
        .map(String),
    ),
  ];
  const lessonPages = parse(courses[0]?.lesson_contents || "[]").filter(
    (item) =>
      String(item.moduleId ?? item.module_id) === moduleId &&
      typeof item.content === "string" &&
      item.content.trim().length >= 12,
  );
  if (!documentIds.length && !lessonPages.length)
    throw requestError(
      "Add lesson content or upload learning materials for this module before configuring Main Quiz.",
      409,
    );
  const moduleIndex = Number(module.moduleIndex ?? module.module_index);
  if (!Number.isInteger(moduleIndex))
    throw requestError("Saved module index is missing.", 409);
  const topics = [
    ...new Set(
      content
        .filter(
          (item) =>
            String(item.moduleId ?? item.module_id) === moduleId &&
            typeof item.topic === "string" &&
            item.topic.trim(),
        )
        .map((item) => item.topic.trim()),
    ),
  ];
  const config = {
    ...settings,
    topics,
    moduleIndex,
    documentIds,
    sourceMode: documentIds.length ? "documents" : "saved_lessons",
    lessonTitle: module.moduleTitle || module.module_title || body.lesson_title,
    learningObjectives:
      module.moduleLearningObjectives ||
      module.module_learning_objectives ||
      body.learning_objectives ||
      "",
  };
  await db.execute(
    "INSERT INTO main_quiz_configs(course_id,module_id,config_json) VALUES(?,?,?) ON DUPLICATE KEY UPDATE config_json=VALUES(config_json),revision=revision+1",
    [courseId, moduleId, JSON.stringify(config)],
  );
  return config;
}
const publicQuiz = (row) => {
  const config = parse(row.config_json);
  return {
    quizId: row.quiz_id,
    questions: parse(row.questions_json).map(
      ({
        correct_answer,
        explanation,
        source_chunks,
        grounding,
        source_question_index,
        ...question
      }) => question,
    ),
    passingPercentage: config.passingPercentage,
  };
};
const inFlight = new Map();
export async function startMainQuiz(user, body) {
  const courseId = Number(body.course_id),
    moduleId = String(body.module_id || "");
  const module = await studentAccess(user, courseId, moduleId);
  const manualQuestions = module.mainQuizSettings?.manualQuestions || [];
  if (manualQuestions.length) {
    validateManualQuestions(manualQuestions);
    const manualConfig = {
      questionCount: manualQuestions.length,
      passingPercentage: 70,
      moduleIndex: Number(module.moduleIndex ?? module.module_index),
      lessonTitle: module.moduleTitle || module.module_title || "",
      mode: "manual",
    };
    await db.execute(
      "INSERT IGNORE INTO main_quiz_configs(course_id,module_id,config_json) VALUES(?,?,?)",
      [courseId, moduleId, JSON.stringify(manualConfig)],
    );
  }
  const [configs] = await db.execute(
    "SELECT * FROM main_quiz_configs WHERE course_id=? AND module_id=?",
    [courseId, moduleId],
  );
  const stored = configs[0];
  if (!stored)
    throw requestError(
      "Your professor has not configured this Main Quiz yet.",
      409,
    );
  const config = parse(stored.config_json);
  const [saved] = await db.execute(
    "SELECT * FROM personalized_main_quizzes WHERE course_id=? AND module_id=? AND user_id=? AND revision=?",
    [courseId, moduleId, user.userId, stored.revision],
  );
  if (saved.length) {
    if (saved[0].submissions >= 1)
      throw requestError(
        "This Main Quiz has already been submitted and recorded.",
        409,
      );
    return publicQuiz(saved[0]);
  }
  if (manualQuestions.length) {
    const snapshot = {
      ...config,
      questionCount: manualQuestions.length,
      passingPercentage: 70,
      moduleIndex: Number(module.moduleIndex ?? module.module_index),
      lessonTitle: module.moduleTitle || module.module_title || "",
      mode: "manual",
    };
    const questions = manualQuestions.map((question) => ({
      ...question,
      topic: question.topic || "Unclassified",
    }));
    const blueprint = {
      mode: "manual",
      lotsCount: 0,
      hotsCount: 0,
      tosDistribution: [
        ...new Set(questions.map((question) => question.topic)),
      ].map((topic) => ({
        topic,
        question_count: questions.filter((question) => question.topic === topic)
          .length,
        cognitive_levels: {},
        practice_percent: null,
      })),
    };
    await db.execute(
      "INSERT IGNORE INTO personalized_main_quizzes(course_id,module_id,user_id,revision,practice_attempt_id,questions_json,blueprint_json,config_json) VALUES(?,?,?,?,?,?,?,?)",
      [
        courseId,
        moduleId,
        user.userId,
        stored.revision,
        0,
        JSON.stringify(shuffleMainQuizQuestions(questions)),
        JSON.stringify(blueprint),
        JSON.stringify(snapshot),
      ],
    );
    const [rows] = await db.execute(
      "SELECT * FROM personalized_main_quizzes WHERE course_id=? AND module_id=? AND user_id=? AND revision=?",
      [courseId, moduleId, user.userId, stored.revision],
    );
    return publicQuiz(rows[0]);
  }
  const key = [courseId, moduleId, user.userId, stored.revision].join(":");
  if (inFlight.has(key)) return inFlight.get(key);
  const work = generatePersonalized(user, courseId, moduleId, stored, config);
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}
async function generatePersonalized(
  user,
  courseId,
  moduleId,
  stored,
  config,
  preview = false,
) {
  const [attempts] = preview
    ? [[]]
    : await db.execute(
        `SELECT a.attempts_id,a.total,d.answers_json FROM quiz_attempts a JOIN quiz_attempt_details d ON d.attempts_id=a.attempts_id WHERE a.user_id=? AND a.course_id=? AND d.module_index=? AND d.assessment_type='practice' AND a.quiz_mode <> 'lesson' AND a.total>0 ORDER BY a.created_at DESC,a.attempts_id DESC LIMIT 1`,
        [user.userId, courseId, config.moduleIndex],
      );
  let blueprint, practiceAttemptId;
  try {
    ({ blueprint, practiceAttemptId } = mainQuizBlueprint(config, attempts[0]));
  } catch (error) {
    throw requestError(error.message, 409);
  }
  if (!preview && !practiceAttemptId && config.baselineQuestions?.length) {
    const questions = config.baselineQuestions;
    validateManualQuestions(questions);
    blueprint = baselineQuestionBlueprint(questions);
    await db.execute(
      "INSERT IGNORE INTO personalized_main_quizzes(course_id,module_id,user_id,revision,practice_attempt_id,questions_json,blueprint_json,config_json) VALUES(?,?,?,?,?,?,?,?)",
      [
        courseId,
        moduleId,
        user.userId,
        stored.revision,
        0,
        JSON.stringify(shuffleMainQuizQuestions(questions)),
        JSON.stringify(blueprint),
        JSON.stringify(config),
      ],
    );
    const [rows] = await db.execute(
      "SELECT * FROM personalized_main_quizzes WHERE course_id=? AND module_id=? AND user_id=? AND revision=?",
      [courseId, moduleId, user.userId, stored.revision],
    );
    return publicQuiz(rows[0]);
  }
  const [documents] = await db.execute(
    "SELECT document_id,filename,processing_status FROM lesson_source_documents WHERE course_id=?",
    [courseId],
  );
  const sources = documents.filter((document) =>
    config.documentIds.includes(String(document.document_id)),
  );
  if (
    sources.length !== config.documentIds.length ||
    sources.some((document) => document.processing_status !== "ready")
  )
    throw requestError(
      "Required lesson sources are unavailable. Ask your professor to reindex them.",
      409,
    );
  let chunks = (
    await Promise.all(
      sources.map(async (document) =>
        (await loadChunks(document.document_id)).map((chunk) => ({
          ...chunk,
          source_filename: document.filename,
        })),
      ),
    )
  ).flat();
  if (!config.documentIds.length) {
    const [courses] = await db.execute(
      "SELECT lesson_pages FROM courses WHERE course_id=?",
      [courseId],
    );
    chunks = savedLessonChunks(
      parse(courses[0]?.lesson_pages || "[]"),
      moduleId,
    );
    if (chunks.length) {
      const embedding = embeddingConfig();
      const vectors = await embedTexts(
        chunks.map((chunk) => chunk.chunk_text),
        "RETRIEVAL_DOCUMENT",
        embedding,
      );
      chunks = chunks.map((chunk, index) => ({
        ...chunk,
        embedding: vectors[index],
        embedding_model: embedding.model,
        embedding_dimensions: embedding.dimensions,
      }));
    }
  }
  if (!chunks.length)
    throw requestError("No indexed source evidence is available.", 409);
  const ids = [...new Set(chunks.map((chunk) => chunk.document_id))];
  const [history] = preview
    ? [[]]
    : await db.execute(
        `SELECT d.answers_json FROM quiz_attempts a JOIN quiz_attempt_details d ON d.attempts_id=a.attempts_id WHERE a.user_id=? AND a.course_id=? AND d.module_index=? AND d.assessment_type='practice' AND a.quiz_mode <> 'lesson' ORDER BY a.attempts_id`,
        [user.userId, courseId, config.moduleIndex],
      );
  const previousPracticeQuestions = [
    ...new Set(
      history
        .flatMap((row) => parse(row.answers_json))
        .map((answer) => answer.question || answer.prompt)
        .filter(Boolean),
    ),
  ];
  const contexts = new Map();
  for (const topic of blueprint.tosDistribution)
    contexts.set(
      topic.topic,
      await retrieveContexts(
        ids,
        `${topic.topic} ${config.learningObjectives}`,
        { topK: Math.min(6, chunks.length), chunks },
      ),
    );
  const questions = [];
  for (let index = 0; index < blueprint.slots.length; index += 5) {
    const slots = blueprint.slots.slice(index, index + 5);
    const context = [
      ...new Map(
        slots
          .flatMap((slot) => contexts.get(slot.topic))
          .map((chunk) => [String(chunk.chunk_id), chunk]),
      ).values(),
    ];
    const lessonContent = context.map((chunk) => chunk.chunk_text).join("\n\n");
    const prompt = createMainQuizPrompt({
      ...config,
      ...blueprint,
      lessonContent,
      previousPracticeQuestions,
    });
    const batch = await generateQuizBatch({
      types: slots.map((slot) => slot.type),
      skills: slots.map((slot) => slot.thinking_skill),
      chunks: context,
      title: config.lessonTitle,
      objectives: config.learningObjectives,
      mainPrompt: prompt,
      assignedSlots: slots,
      previousQuestions: [
        ...previousPracticeQuestions,
        ...questions.map((question) => question.question),
      ],
    });
    questions.push(...batch);
  }
  validateAdaptiveQuestions(
    questions,
    blueprint.slots,
    previousPracticeQuestions,
  );
  if (preview) return questions;
  // Another process may have saved this revision while generation ran; preserve that saved quiz.
  await db.execute(
    `INSERT IGNORE INTO personalized_main_quizzes(course_id,module_id,user_id,revision,practice_attempt_id,questions_json,blueprint_json,config_json) VALUES(?,?,?,?,?,?,?,?)`,
    [
      courseId,
      moduleId,
      user.userId,
      stored.revision,
      practiceAttemptId,
      JSON.stringify(shuffleMainQuizQuestions(questions)),
      JSON.stringify(blueprint),
      JSON.stringify(config),
    ],
  );
  const [saved] = await db.execute(
    "SELECT * FROM personalized_main_quizzes WHERE course_id=? AND module_id=? AND user_id=? AND revision=?",
    [courseId, moduleId, user.userId, stored.revision],
  );
  return publicQuiz(saved[0]);
}

export async function generateMainQuizPreview(user, body) {
  const courseId = Number(body.course_id),
    moduleId = String(body.module_id || "");
  await assertCourseAccess(user, courseId);
  const [rows] = await db.execute(
    "SELECT * FROM main_quiz_configs WHERE course_id=? AND module_id=?",
    [courseId, moduleId],
  );
  const stored = rows[0];
  if (!stored)
    throw requestError("Configure Main Quiz before generating questions.", 409);
  const config = parse(stored.config_json);
  const baselineQuestions = await generatePersonalized(
    user,
    courseId,
    moduleId,
    stored,
    config,
    true,
  );
  const nextConfig = { ...config, baselineQuestions };
  const [updated] = await db.execute(
    "UPDATE main_quiz_configs SET config_json=? WHERE course_id=? AND module_id=? AND revision=?",
    [JSON.stringify(nextConfig), courseId, moduleId, stored.revision],
  );
  if (!updated.affectedRows)
    throw requestError(
      "Main Quiz settings changed during generation. Please try again.",
      409,
    );
  return nextConfig;
}

export function baselineQuestionBlueprint(questions) {
  const lotsCount = questions.filter(
    (question) => question.thinking_skill === "LOTS",
  ).length;
  return {
    mode: "baseline",
    lotsCount,
    hotsCount: questions.length - lotsCount,
    tosDistribution: [
      ...new Set(questions.map((question) => question.topic)),
    ].map((topic) => {
      const rows = questions.filter((question) => question.topic === topic);
      return {
        topic,
        question_count: rows.length,
        practice_percent: null,
        cognitive_levels: Object.fromEntries(
          [...new Set(rows.map((question) => question.cognitive_level))].map(
            (level) => [
              level,
              rows.filter((question) => question.cognitive_level === level)
                .length,
            ],
          ),
        ),
      };
    }),
  };
}

export async function saveMainQuizPreview(user, body) {
  const courseId = Number(body.course_id),
    moduleId = String(body.module_id || "");
  await assertCourseAccess(user, courseId);
  validateManualQuestions(body.questions);
  const [rows] = await db.execute(
    "SELECT * FROM main_quiz_configs WHERE course_id=? AND module_id=?",
    [courseId, moduleId],
  );
  if (!rows.length)
    throw requestError("Configure Main Quiz before saving questions.", 409);
  const levels = [
    "Remember",
    "Understand",
    "Apply",
    "Analyze",
    "Evaluate",
    "Create",
  ];
  const questions = body.questions.map((question) => {
    const level = levels.includes(question.cognitive_level)
      ? question.cognitive_level
      : "Understand";
    return {
      ...question,
      topic: String(
        question.topic ||
          parse(rows[0].config_json).lessonTitle ||
          "Lesson concepts",
      ).trim(),
      cognitive_level: level,
      thinking_skill: levels.indexOf(level) < 3 ? "LOTS" : "HOTS",
    };
  });
  const config = {
    ...parse(rows[0].config_json),
    baselineQuestions: questions,
    questionCount: questions.length,
    multipleChoiceCount: questions.filter(
      (question) => question.type === "multiple_choice",
    ).length,
    identificationCount: questions.filter(
      (question) => question.type === "identification",
    ).length,
    trueFalseCount: questions.filter(
      (question) => question.type === "true_false",
    ).length,
  };
  const [updated] = await db.execute(
    "UPDATE main_quiz_configs SET config_json=?,revision=revision+1 WHERE course_id=? AND module_id=? AND revision=?",
    [JSON.stringify(config), courseId, moduleId, rows[0].revision],
  );
  if (!updated.affectedRows)
    throw requestError(
      "Main Quiz settings changed. Reload before saving.",
      409,
    );
  return config;
}
export async function submitMainQuiz(user, body) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT * FROM personalized_main_quizzes WHERE quiz_id=? AND user_id=? FOR UPDATE",
      [Number(body.quiz_id), user.userId],
    );
    const row = rows[0];
    if (!row) throw requestError("Main Quiz not found.", 404);
    await studentAccess(user, row.course_id, row.module_id);
    const [configs] = await connection.execute(
      "SELECT revision FROM main_quiz_configs WHERE course_id=? AND module_id=?",
      [row.course_id, row.module_id],
    );
    if (configs[0]?.revision !== row.revision)
      throw requestError(
        "Main Quiz configuration changed. Return to the course to start the current quiz.",
        409,
      );
    const config = parse(row.config_json);
    if (row.submissions >= 1)
      throw requestError(
        "This Main Quiz has already been submitted and recorded.",
        409,
      );
    let result;
    try {
      result = gradeMainQuiz(
        parse(row.questions_json),
        body.answers,
        config.passingPercentage,
      );
    } catch (error) {
      throw requestError(error.message, 400);
    }
    const [attempt] = await connection.execute(
      `INSERT INTO quiz_attempts(user_id,course_id,score,total,source,quiz_mode) VALUES(?,?,?,?,?,?)`,
      [
        user.userId,
        row.course_id,
        result.score,
        result.total,
        "module",
        "adaptive_main",
      ],
    );
    await connection.execute(
      "INSERT INTO quiz_attempt_details(attempts_id,assessment_type,answers_json,module_index) VALUES(?,?,?,?)",
      [
        attempt.insertId,
        "main",
        JSON.stringify(result.answers),
        config.moduleIndex,
      ],
    );
    await connection.execute(
      "INSERT INTO main_quiz_results(quiz_id,user_id,attempts_id,result_json) VALUES(?,?,?,?)",
      [row.quiz_id, user.userId, attempt.insertId, JSON.stringify(result)],
    );
    await connection.execute(
      "UPDATE personalized_main_quizzes SET submissions=submissions+1 WHERE quiz_id=?",
      [row.quiz_id],
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
export async function mainQuizAnalysis(user, courseId, moduleId) {
  await assertCourseAccess(user, Number(courseId));
  const [rows] = await db.execute(
    `SELECT q.module_id,q.quiz_id,q.user_id,q.blueprint_json,q.config_json,q.practice_attempt_id,r.result_json,r.created_at,COALESCE(u.display_name,u.name) AS student_name FROM personalized_main_quizzes q JOIN main_quiz_results r ON r.quiz_id=q.quiz_id JOIN users u ON u.userId=q.user_id WHERE q.course_id=? AND (? IS NULL OR q.module_id=?) ORDER BY r.created_at`,
    [
      Number(courseId),
      moduleId ? String(moduleId) : null,
      moduleId ? String(moduleId) : null,
    ],
  );
  return rows.map((row) => ({
    moduleId: row.module_id,
    quizId: row.quiz_id,
    userId: row.user_id,
    studentName: row.student_name || `Student ${row.user_id}`,
    blueprint: parse(row.blueprint_json),
    config: parse(row.config_json),
    practiceAttemptId: row.practice_attempt_id,
    result: parse(row.result_json),
    createdAt: row.created_at,
  }));
}

export async function getMainConfig(user, courseId, moduleId) {
  await assertCourseAccess(user, Number(courseId));
  const [rows] = await db.execute(
    "SELECT config_json FROM main_quiz_configs WHERE course_id=? AND module_id=?",
    [Number(courseId), String(moduleId)],
  );
  return rows.length ? parse(rows[0].config_json) : null;
}

export async function listGeneratedMainQuizzes(user, courseId, moduleId) {
  await assertCourseAccess(user, Number(courseId));
  const [rows] = await db.execute(
    `SELECT q.quiz_id,q.revision,q.questions_json,q.created_at,q.submissions,COALESCE(u.display_name,u.name) AS student_name FROM personalized_main_quizzes q JOIN users u ON u.userId=q.user_id JOIN main_quiz_configs c ON c.course_id=q.course_id AND c.module_id=q.module_id AND c.revision=q.revision WHERE q.course_id=? AND q.module_id=? ORDER BY q.created_at DESC`,
    [Number(courseId), String(moduleId)],
  );
  return rows.map((row) => ({
    quizId: row.quiz_id,
    studentName: row.student_name,
    submitted: row.submissions > 0,
    questions: parse(row.questions_json),
  }));
}

export function validateManualQuestions(questions) {
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 100
  )
    throw requestError("Manual Main Quiz must contain 1–100 questions.", 400);
  const seen = new Set();
  for (const question of questions) {
    const text = String(question.question || "")
      .trim()
      .toLowerCase();
    if (!text || seen.has(text))
      throw requestError(
        "Manual Main Quiz contains an empty or duplicate question.",
        400,
      );
    seen.add(text);
    if (
      !["multiple_choice", "identification", "true_false"].includes(
        question.type,
      ) ||
      typeof question.correct_answer !== "string" ||
      !question.correct_answer.trim() ||
      !Array.isArray(question.options)
    )
      throw requestError(
        "Complete every manual question and correct answer before taking Main Quiz.",
        400,
      );
    if (
      question.type === "multiple_choice" &&
      (question.options.length !== 4 ||
        question.options.some(
          (option) => typeof option !== "string" || !option.trim(),
        ) ||
        new Set(question.options).size !== 4 ||
        !question.options.includes(question.correct_answer))
    )
      throw requestError(
        "Manual multiple choice questions need four distinct options and a matching correct answer.",
        400,
      );
    if (
      question.type === "true_false" &&
      (JSON.stringify(question.options) !== '["True","False"]' ||
        !question.options.includes(question.correct_answer))
    )
      throw requestError(
        "Manual True/False questions need True and False options and a matching answer.",
        400,
      );
    if (question.type === "identification" && question.options.length)
      throw requestError(
        "Manual identification questions must have no options.",
        400,
      );
  }
}

export function savedLessonChunks(pages, moduleId) {
  return pages
    .filter(
      (page) =>
        String(page.moduleId ?? page.module_id) === String(moduleId) &&
        typeof page.content === "string" &&
        page.content.trim().length >= 12,
    )
    .flatMap((page, pageIndex) => {
      const chunks = [];
      const text = page.content.trim();
      for (let start = 0; start < text.length; start += 2400) {
        const end = Math.min(start + 3000, text.length);
        chunks.push({
          chunk_id: `lesson-${moduleId}-${pageIndex}-${start}`,
          document_id: `saved-module-${moduleId}`,
          chunk_text: text.slice(start, end),
          source_filename: page.title || `Lesson ${pageIndex + 1}`,
          source_start: start,
          source_end: end,
          source_position: [{ page: pageIndex + 1, start, end }],
        });
        if (end === text.length) break;
      }
      return chunks;
    });
}

export async function mainQuizStatus(user, courseId, moduleId) {
  if (user.role !== "student")
    throw requestError("Only students can access Main Quiz.", 403);
  const [results] = await db.execute(
    "SELECT q.quiz_id FROM personalized_main_quizzes q JOIN main_quiz_results r ON r.quiz_id=q.quiz_id WHERE q.course_id=? AND q.module_id=? AND q.user_id=? LIMIT 1",
    [Number(courseId), String(moduleId), user.userId],
  );
  if (results.length) return { taken: true };
  const module = await studentAccess(user, Number(courseId), String(moduleId));
  const manualQuestions = module.mainQuizSettings?.manualQuestions;
  if (!Array.isArray(manualQuestions) || !manualQuestions.length) {
    const [configs] = await db.execute(
      "SELECT course_id FROM main_quiz_configs WHERE course_id=? AND module_id=? LIMIT 1",
      [Number(courseId), String(moduleId)],
    );
    if (!configs.length)
      throw requestError(
        "Your professor has not created the Main Quiz for this module yet. Please check back later.",
        409,
      );
  }
  return { taken: false };
}
