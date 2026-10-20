import { db } from "../db.js";
export async function studentMainQuizHistory(user, query = {}, database = db) {
  if (user.role !== "student") throw Object.assign(new Error("Student quiz history is only available to students."), { statusCode: 403 });
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(20, Math.max(1, Math.floor(Number(query.pageSize) || 3)));
  const [[count]] = await database.execute("SELECT COUNT(*) AS total FROM main_quiz_results WHERE user_id=?", [user.userId]);
  const [rows] = await database.query(`SELECT r.result_id,r.created_at,r.result_json,c.title AS course_title,q.config_json FROM main_quiz_results r JOIN personalized_main_quizzes q ON q.quiz_id=r.quiz_id LEFT JOIN courses c ON c.course_id=q.course_id WHERE r.user_id=? AND q.user_id=? ORDER BY r.created_at DESC,r.result_id DESC LIMIT ? OFFSET ?`, [user.userId, user.userId, pageSize, (page - 1) * pageSize]);
  const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
  return { page, pageSize, total: Number(count.total), records: rows.map((row) => {
    const result = parse(row.result_json), config = parse(row.config_json) || {};
    return { result_id: row.result_id, course_title: row.course_title || "Course", quiz_title: config.lessonTitle ? `${config.lessonTitle} — Main Quiz` : Number.isInteger(config.moduleIndex) && config.moduleIndex >= 0 ? `Main Quiz ${config.moduleIndex + 1}` : "Main Quiz", score: result.score, total: result.total, passed: result.passed === true, created_at: row.created_at };
  }) };
}
