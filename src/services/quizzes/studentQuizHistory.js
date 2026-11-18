import { getCourseModuleLabels } from "../../controllers/courseController.js";
import { db } from "../../db.js";
import { requestError } from "../rag/courseAccessService.js";
export async function studentMainQuizHistory(user, query = {}, database = db) {
  if (user.role !== "student") throw Object.assign(new Error("Student quiz history is only available to students."), { statusCode: 403 });
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(Number(query.pageSize) || 3)));
  const [[count]] = await database.execute("SELECT COUNT(*) AS total FROM main_quiz_results WHERE user_id=?", [user.userId]);
  const [rows] = await database.query(`SELECT r.result_id,r.created_at,r.result_json,c.title AS course_title,q.config_json,q.module_id FROM main_quiz_results r JOIN personalized_main_quizzes q ON q.quiz_id=r.quiz_id LEFT JOIN courses c ON c.course_id=q.course_id WHERE r.user_id=? AND q.user_id=? ORDER BY r.created_at DESC,r.result_id DESC LIMIT ? OFFSET ?`, [user.userId, user.userId, pageSize, (page - 1) * pageSize]);
  const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
  return { page, pageSize, total: Number(count.total), records: rows.map((row) => {
    const result = parse(row.result_json), config = parse(row.config_json) || {};
    const moduleIndex = Number(config.moduleIndex);
    const moduleTitle = config.moduleTitle || config.lessonTitle || (Number.isInteger(moduleIndex) && moduleIndex >= 0 ? `Module ${moduleIndex + 1}` : "Module");
    return { module_id: row.module_id, module_title: moduleTitle, module_number: Number.isInteger(moduleIndex) && moduleIndex >= 0 ? moduleIndex + 1 : null, result_id: row.result_id, course_title: row.course_title || "Course", quiz_title: config.lessonTitle ? `${config.lessonTitle} — Main Quiz` : Number.isInteger(config.moduleIndex) && config.moduleIndex >= 0 ? `Main Quiz ${config.moduleIndex + 1}` : "Main Quiz", score: result.score, total: result.total, passed: result.passed === true, created_at: row.created_at };
  }) };
}

export async function studentPracticeHistory(user) {
  if (user.role !== "student")
    throw requestError("Practice history is only available to students.", 403);

  const [rows] = await db.execute(
    `SELECT attempt_id, course_id, module_id, completed_at,
            result_json::jsonb ->> 'score' AS score,
            result_json::jsonb ->> 'total' AS total
     FROM module_practice_attempts
     WHERE user_id = ? AND result_json IS NOT NULL
     ORDER BY completed_at DESC NULLS LAST, attempt_id DESC`,
    [user.userId],
  );
  const labels = await getCourseModuleLabels([
    ...new Set(rows.map((row) => row.course_id)),
  ]);
  const modules = new Map();
  for (const row of rows) {
    const score = Number(row.score);
    const total = Number(row.total);
    if (
      row.score == null ||
      !Number.isSafeInteger(score) ||
      !Number.isSafeInteger(total) ||
      score < 0 ||
      total < 1 ||
      score > total
    )
      continue;

    const key = `${row.course_id}:${row.module_id}`;
    if (!modules.has(key)) {
      const course = labels.get(row.course_id);
      modules.set(key, {
        courseId: row.course_id,
        moduleId: row.module_id,
        courseTitle: course?.title || "Course",
        moduleTitle: course?.moduleTitles.get(row.module_id) || "Module Practice",
        attempts: [],
      });
    }
    modules.get(key).attempts.push({
      id: row.attempt_id,
      score,
      total,
      completedAt: row.completed_at,
    });
  }
  return [...modules.values()];
}
