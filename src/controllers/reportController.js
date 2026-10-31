import { db } from '../db.js';

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
const percentage = (score, total) => {
  if (
    score == null ||
    total == null ||
    !Number.isFinite(Number(score)) ||
    !Number.isFinite(Number(total)) ||
    Number(total) <= 0
  ) {
    return null;
  }

  return (Number(score) / Number(total)) * 100;
};

function dateBounds(query) {
  const { start, end } = query;
  if ((start && !end) || (!start && end)) throw Object.assign(new Error('Both start and end dates are required.'), { statusCode: 400 });
  if (!start) return { start: null, end: null };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start) || !re.test(end) || !Number.isFinite(Date.parse(`${start}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${end}T00:00:00Z`)) || start > end) {
    throw Object.assign(new Error('Invalid date range. Use YYYY-MM-DD and start <= end.'), { statusCode: 400 });
  }
  return { start, end };
}

const inRange = (column, bounds, params) => {
  if (!bounds.start) return '1=1';
  params.push(bounds.start, bounds.end);
  return `${column} >= ? AND ${column} < (?::timestamp + INTERVAL '1 day')`;
};

export async function getReports(req, res, next) {
  try {
    const bounds = dateBounds(req.query);
    const [settingsRows] = await db.execute(`
        SELECT
            passing_percentage AS passingPercentage,
            TO_CHAR(semester_start_date, 'YYYY-MM-DD')
            AS semesterStartDate,
            TO_CHAR(semester_end_date, 'YYYY-MM-DD')
            AS semesterEndDate,
            TO_CHAR(school_year_start_date, 'YYYY-MM-DD')
            AS schoolYearStartDate,
            TO_CHAR(school_year_end_date, 'YYYY-MM-DD')
            AS schoolYearEndDate
        FROM system_settings
        ORDER BY setting_id ASC
        LIMIT 1
        `);

        const settings = settingsRows[0] || null;

        if (settings?.passingPercentage != null) {
        settings.passingPercentage =
            Number(settings.passingPercentage);
        }
    const params = [];
    const attemptRange = inRange('qa.created_at', bounds, params);
    const [users] = await db.execute(`SELECT userId AS id, name, email, role, gender, year_level AS yearLevel, section_name AS section, created_at AS createdAt FROM users WHERE COALESCE(is_archived,0)=0 AND role IN ('student','professor','admin','super_admin') ORDER BY name`);
    const [courses] = await db.execute(`SELECT course_id AS id, COALESCE(NULLIF(course_name,''),title) AS title, COALESCE(NULLIF(course_code,''),code) AS code, professor_id AS professorId, status, created_at AS createdAt FROM courses WHERE COALESCE(archived,0)=0 ORDER BY title`);
    const [enrollments] = await db.execute(`SELECT ce.course_id AS courseId, ce.user_id AS userId, ce.approved_at AS approvedAt FROM course_enrollments ce JOIN users u ON u.userId=ce.user_id WHERE ce.status='approved' AND COALESCE(ce.archived,0)=0 AND COALESCE(u.is_archived,0)=0`);
    const [modules] = await db.execute(`SELECT lm.lesson_id AS id, lm.course_id AS courseId, lm.title, lm.status, lm.has_quiz AS hasQuiz, lm.created_at AS createdAt FROM learning_modules lm JOIN courses c ON c.course_id=lm.course_id WHERE COALESCE(c.archived,0)=0 ORDER BY lm.title`);
    const [progress] = await db.execute(`SELECT lp.user_id AS userId, lp.lesson_id AS lessonId, lp.course_id AS courseId, lp.progress_percent AS progressPercent, lp.updated_at AS updatedAt FROM lesson_progress lp JOIN learning_modules lm ON lm.lesson_id=lp.lesson_id JOIN course_enrollments ce ON ce.user_id=lp.user_id AND ce.course_id=lm.course_id AND ce.status='approved' AND COALESCE(ce.archived,0)=0 JOIN users u ON u.userId=lp.user_id AND COALESCE(u.is_archived,0)=0 JOIN courses c ON c.course_id=lm.course_id AND COALESCE(c.archived,0)=0`);
    const [attempts] = await db.execute(`SELECT qa.attempts_id AS id, qa.user_id AS userId, qa.lesson_id AS lessonId, qa.course_id AS courseId, qa.score, qa.total, qa.source, qa.quiz_mode AS quizMode, qad.assessment_type AS assessmentType, qa.time_spent AS timeSpent, qa.created_at AS createdAt FROM quiz_attempts qa JOIN users u ON u.userId=qa.user_id AND COALESCE(u.is_archived,0)=0 JOIN courses c ON c.course_id=qa.course_id AND COALESCE(c.archived,0)=0 LEFT JOIN quiz_attempt_details qad ON qad.attempts_id=qa.attempts_id WHERE ${attemptRange} ORDER BY qa.created_at DESC`, params);
    const [analytics] = await db.execute(`SELECT pa.user_id AS userId, pa.course_id AS courseId, pa.average_score AS averageScore, pa.total_attempts AS totalAttempts, pa.weakest_topic AS weakestTopic, pa.strongest_topic AS strongestTopic, pa.updated_at AS updatedAt FROM performance_analytics pa JOIN courses c ON c.course_id=pa.course_id AND COALESCE(c.archived,0)=0 JOIN users u ON u.userId=pa.user_id AND COALESCE(u.is_archived,0)=0`);

    const enrolled = new Set(enrollments.map(e => `${e.courseId}:${e.userId}`));
    const filteredAttempts = attempts.filter(a => enrolled.has(`${a.courseId}:${a.userId}`)).map(a => ({ ...a, percentage: percentage(a.score, a.total) }));
    const validAttempts = filteredAttempts.filter(a => a.percentage !== null);
    const avg = list => list.length ? round(list.reduce((sum, x) => sum + x, 0) / list.length) : null;
    const courseRows = courses.map(c => {
      const students = enrollments.filter(e => e.courseId === c.id);
      const ownModules = modules.filter(m => m.courseId === c.id);
      const ownAttempts = validAttempts.filter(a => a.courseId === c.id);
      const completed = progress.filter(p => p.courseId === c.id && Number(p.progressPercent) >= 100);
      const possible = students.length * ownModules.length;
      return { ...c, students: students.length, modules: ownModules.length, quizAttempts: ownAttempts.length, averageScore: avg(ownAttempts.map(a => a.percentage)), moduleCompletionRate: possible ? round(completed.length * 100 / possible) : null };
    });
    const studentRows = users.filter(u => u.role === 'student').map(u => {
      const ownEnrollments = enrollments.filter(e => e.userId === u.id);
      const ownAttempts = validAttempts.filter(a => a.userId === u.id);
      const ownModules = modules.filter(m => ownEnrollments.some(e => e.courseId === m.courseId));
      const completed = progress.filter(p => p.userId === u.id && Number(p.progressPercent) >= 100).length;
      return { ...u, courseIds: ownEnrollments.map(e => e.courseId), enrolledCourses: ownEnrollments.length, quizAttempts: ownAttempts.length, averageScore: avg(ownAttempts.map(a => a.percentage)), completedModules: completed, totalModules: ownModules.length, moduleCompletionRate: ownModules.length ? round(completed * 100 / ownModules.length) : null };
    });
    const professorRows = users.filter(u => u.role === 'professor').map(u => {
      const owned = courseRows.filter(c => Number(c.professorId) === Number(u.id));
      return { ...u, courses: owned.length, courseIds: owned.map(c => c.id), students: new Set(enrollments.filter(e => owned.some(c => c.id === e.courseId)).map(e => e.userId)).size, modules: owned.reduce((s,c) => s + c.modules, 0), quizAttempts: owned.reduce((s,c) => s + c.quizAttempts, 0) };
    });
    const moduleRows = modules.map(m => {
      const enrolledStudents = enrollments.filter(e => e.courseId === m.courseId).length;
      const completions = progress.filter(p => p.lessonId === m.id && Number(p.progressPercent) >= 100).length;
      const ownAttempts = validAttempts.filter(a => a.lessonId === m.id);
      return { ...m, enrolledStudents, completions, completionRate: enrolledStudents ? round(completions * 100 / enrolledStudents) : null, quizAttempts: ownAttempts.length, averageScore: avg(ownAttempts.map(a => a.percentage)) };
    });
    const scores = validAttempts.map(a => a.percentage);
    const modeMap = new Map();
    for (const a of filteredAttempts) {
      const mode = a.assessmentType || a.quizMode || a.source || 'Unspecified';
      modeMap.set(mode, (modeMap.get(mode) || 0) + 1);
    }
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        range: bounds,

        // SYSTEM SETTINGS
        settings,

        // OVERVIEW
        overview: {
            totalUsers: users.length,
            totalStudents: studentRows.length,
            totalProfessors: professorRows.length,
            totalCourses: courses.length,
            totalModules: modules.length,
            totalQuizAttempts: filteredAttempts.length,
            scoredAttempts: validAttempts.length,
            averageQuizScore: avg(scores),
            highestQuizScore: scores.length ? Math.max(...scores) : null,
            lowestQuizScore: scores.length ? Math.min(...scores) : null,
        },

        // REPORT DATA
        courses: courseRows,
        modules: moduleRows,
        students: studentRows,
        professors: professorRows,
        attempts: filteredAttempts,

        // LESSON PROGRESS
        progress,

        // QUIZ MODE ANALYTICS
        quizModes: Array.from(modeMap, ([name, count]) => ({
            name,
            count,
        })),

        // ADAPTIVE ANALYTICS
        adaptive: analytics,
        });
  } catch (error) { next(error); }
}
export async function getReportConfig(req, res, next) {
  try {
    const [rows] = await db.execute(`
      SELECT
        passing_percentage AS passingPercentage,
        TO_CHAR(semester_start_date, 'YYYY-MM-DD')
          AS semesterStartDate,
        TO_CHAR(semester_end_date, 'YYYY-MM-DD')
          AS semesterEndDate,
        TO_CHAR(school_year_start_date, 'YYYY-MM-DD')
          AS schoolYearStartDate,
        TO_CHAR(school_year_end_date, 'YYYY-MM-DD')
          AS schoolYearEndDate
      FROM system_settings
      ORDER BY setting_id ASC
      LIMIT 1
    `);

    const settings = rows[0] || null;

    if (settings?.passingPercentage != null) {
      settings.passingPercentage =
        Number(settings.passingPercentage);
    }

    res.set("Cache-Control", "no-store");

    res.json({
      success: true,
      settings,
    });
  } catch (error) {
    next(error);
  }
}