import { assertCourseAccess } from "../services/rag/courseAccessService.js";
import { db } from "../db.js";
import { sendQuizResultEmail } from "../utils/mailer.js";

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

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function average(numbers) {
  const validNumbers = numbers.map(Number).filter(Number.isFinite);
  if (!validNumbers.length) return 0;
  return clampScore(
    validNumbers.reduce((sum, number) => sum + number, 0) / validNumbers.length,
  );
}

function formatDate(value) {
  if (!value) return "Not active yet";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not active yet";

  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${diffDays} days ago`;
}

function getStatus(completion, score) {
  if (completion < 55 || score < 60) return "atRisk";
  if (completion < 78 || score < 75) return "needsReview";
  return "onTrack";
}

function getWeakestTopic(topics, scores) {
  if (!topics.length || !scores.length) return "Course topic";

  const weakestIndex = scores.reduce(
    (lowestIndex, score, index) =>
      score < scores[lowestIndex] ? index : lowestIndex,
    0,
  );

  return topics[weakestIndex]?.name || "Course topic";
}

async function getCourseIdColumn() {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'courses'
       AND COLUMN_NAME IN ('course_id', 'id')`,
  );
  const names = new Set(columns.map((column) => column.COLUMN_NAME));
  return names.has("course_id") ? "course_id" : "id";
}

function getCourseId(row) {
  return row?.course_pk || row?.course_id || row?.id;
}

function getCourseTitle(row) {
  return row?.title || row?.course_name || row?.subject || "Untitled course";
}

function getCourseCode(row) {
  return row?.code || row?.course_code || `COURSE-${getCourseId(row)}`;
}

function getTopicNameFromQuiz(item, index) {
  return (
    item.topic ||
    item.category ||
    item.subject ||
    item.question ||
    `Quiz Topic ${index + 1}`
  );
}

function getCourseTopics(course, modules) {
  const courseLessonPages = parseJsonList(course.lesson_pages);
  const courseQuizItems = parseJsonList(course.quiz_items);
  const modulePages = modules.flatMap((module) =>
    parseJsonList(module.lesson_contents),
  );
  const moduleQuizzes = modules.flatMap((module) =>
    parseJsonList(module.quiz_contents),
  );

  const lessonTopics = [...courseLessonPages, ...modulePages]
    .map((page, index) => page?.title || `Lesson Page ${index + 1}`)
    .filter(Boolean);
  const quizTopics = [...courseQuizItems, ...moduleQuizzes]
    .map(getTopicNameFromQuiz)
    .filter(Boolean);
  const topics = [...new Set([...lessonTopics, ...quizTopics])].slice(0, 4);

  if (topics.length) {
    return topics.map((name) => ({ name, average: 0 }));
  }

  return [
    { name: "Module completion", average: 0 },
    { name: "Quiz performance", average: 0 },
    { name: "Activity submissions", average: 0 },
    { name: "Final output", average: 0 },
  ];
}

function getStudentName(row) {
  return (
    row.display_name ||
    row.name ||
    row.username ||
    row.email ||
    `Student ${row.user_id}`
  );
}

function buildTopicScores(topics, baseScore, analytics) {
  const weakest = String(analytics?.weakest_topic || "").toLowerCase();
  const strongest = String(analytics?.strongest_topic || "").toLowerCase();

  return topics.map((topic, index) => {
    const topicName = topic.name.toLowerCase();

    if (weakest && topicName.includes(weakest)) {
      return clampScore(baseScore - 15);
    }

    if (strongest && topicName.includes(strongest)) {
      return clampScore(baseScore + 10);
    }

    return clampScore(baseScore + ((index * 7) % 15) - 7);
  });
}

export async function getCourseMonitoring(req, res) {
  const requestedCourseId = req.params.courseId || req.query.courseId;

  if (!requestedCourseId) {
    return res.status(400).json({
      success: false,
      message: "Course ID is required.",
    });
  }

  try {
    const idColumn = await getCourseIdColumn();
    const [courseRows] = await db.execute(
      `SELECT *, ${idColumn} AS course_pk
       FROM courses
       WHERE ${idColumn} = ? OR code = ? OR course_code = ?
       LIMIT 1`,
      [requestedCourseId, requestedCourseId, requestedCourseId],
    );

    if (courseRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found.",
      });
    }

    const course = courseRows[0];
    const courseId = getCourseId(course);
    await assertCourseAccess(req.user, courseId);

    const [modules] = await db.execute(
      "SELECT * FROM learning_modules WHERE course_id = ? ORDER BY lesson_id",
      [courseId],
    );

    const topics = getCourseTopics(course, modules);
    const lessonIds = modules.map((module) => module.lesson_id).filter(Boolean);

    const [enrollments] = await db.execute(
      `SELECT ce.*, u.userId, u.name, u.email, u.display_name
       FROM course_enrollments ce
       LEFT JOIN users u ON u.userId = ce.user_id
       WHERE ce.course_id = ?
       ORDER BY ce.created_at ASC`,
      [courseId],
    );

    const [analyticsRows] = await db.execute(
      "SELECT * FROM performance_analytics WHERE course_id = ?",
      [courseId],
    );

    const enrolledUserIds = enrollments.map((row) => row.user_id);
    const analyticsUserIds = analyticsRows.map((row) => row.user_id);
    const userIds = [...new Set([...enrolledUserIds, ...analyticsUserIds])];

    const progressRows = [];
    const attemptRows = [];

    if (userIds.length) {
      const userPlaceholders = userIds.map(() => "?").join(", ");
      const lessonFilter = lessonIds.length
        ? `OR lesson_id IN (${lessonIds.map(() => "?").join(", ")})`
        : "";

      const [progress] = await db.execute(
        `SELECT *
         FROM lesson_progress
         WHERE user_id IN (${userPlaceholders})
           AND (course_id = ? ${lessonFilter})`,
        [...userIds, courseId, ...lessonIds],
      );
      progressRows.push(...progress);

      const [attempts] = await db.execute(
        `SELECT *
         FROM quiz_attempts
         WHERE user_id IN (${userPlaceholders})
           AND (course_id = ? ${lessonFilter})`,
        [...userIds, courseId, ...lessonIds],
      );
      attemptRows.push(...attempts);
    }

    const analyticsByUser = new Map(
      analyticsRows.map((row) => [String(row.user_id), row]),
    );

    const enrollmentByUser = new Map(
      enrollments.map((row) => [String(row.user_id), row]),
    );

    const students = userIds.map((userId) => {
      const userKey = String(userId);
      const enrollment = enrollmentByUser.get(userKey) || { user_id: userId };
      const analytics = analyticsByUser.get(userKey);
      const studentProgressRows = progressRows.filter(
        (row) => String(row.user_id) === userKey,
      );
      const studentAttemptRows = attemptRows.filter(
        (row) => String(row.user_id) === userKey,
      );

      const progressPercent = average(
        studentProgressRows.map((row) => {
          if (Number(row.progress_percent) > 0) return row.progress_percent;
          if (Number(row.total_cards) > 0) {
            return (Number(row.studied_cards) / Number(row.total_cards)) * 100;
          }
          return 0;
        }),
      );

      const attemptScore = average(
        studentAttemptRows.map((row) => {
          if (Number(row.total) <= 0) return 0;
          return (Number(row.score) / Number(row.total)) * 100;
        }),
      );

      const score = clampScore(
        Number(analytics?.average_score) || attemptScore || progressPercent,
      );
      const completion = clampScore(progressPercent);
      const topicScores = buildTopicScores(topics, score, analytics);
      const weakestTopic =
        analytics?.weakest_topic || getWeakestTopic(topics, topicScores);
      const lastProgress = studentProgressRows
        .map((row) => row.updated_at)
        .filter(Boolean)
        .sort()
        .at(-1);
      const lastAttempt = studentAttemptRows
        .map((row) => row.created_at)
        .filter(Boolean)
        .sort()
        .at(-1);

      return {
        id: `STU-${String(userId).padStart(4, "0")}`,
        userId,
        name: getStudentName(enrollment),
        completion,
        score,
        lastActive: formatDate(
          lastAttempt || lastProgress || enrollment.created_at,
        ),
        status: getStatus(completion, score),
        weakestTopic,
        strongestTopic: analytics?.strongest_topic || "",
        totalAttempts:
          Number(analytics?.total_attempts) || studentAttemptRows.length || 0,
        topicScores,
      };
    });

    const topicAverages = topics.map((topic, index) => ({
      ...topic,
      average: students.length
        ? average(students.map((student) => student.topicScores[index]))
        : 0,
    }));

    const quizAverage = average(
      attemptRows.map((row) => {
        if (Number(row.total) <= 0) return 0;
        return (Number(row.score) / Number(row.total)) * 100;
      }),
    );
    const completionAverage = average(
      students.map((student) => student.completion),
    );
    const scoreAverage = average(students.map((student) => student.score));

    return res.json({
      success: true,
      monitoring: {
        course: {
          id: courseId,
          code: getCourseCode(course),
          title: getCourseTitle(course),
        },
        section: course.section || "Course section",
        schedule: course.schedule || "Schedule not set",
        topics: topicAverages,
        assessments: [
          { label: "Quiz average", value: quizAverage },
          { label: "Activity completion", value: completionAverage },
          { label: "Overall performance", value: scoreAverage },
        ],
        students,
      },
    });
  } catch (error) {
    console.error("Get course monitoring error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode && error.statusCode < 500 ? error.message : "Failed to fetch student monitoring data.",
    });
  }
}

async function resolveCourseId(value) {
  if (!value) return null;

  const idColumn = await getCourseIdColumn();
  const [courseRows] = await db.execute(
    `SELECT ${idColumn} AS course_pk
     FROM courses
     WHERE ${idColumn} = ? OR code = ? OR course_code = ?
     LIMIT 1`,
    [value, value, value],
  );

  if (courseRows.length) return courseRows[0].course_pk;

  const [moduleRows] = await db.execute(
    "SELECT course_id FROM learning_modules WHERE lesson_id = ? LIMIT 1",
    [value],
  );

  return moduleRows[0]?.course_id || null;
}

async function refreshPerformanceAnalytics(userId, courseId) {
  if (!userId || !courseId) return;

  const [attempts] = await db.execute(
    "SELECT * FROM quiz_attempts WHERE user_id = ? AND course_id = ?",
    [userId, courseId],
  );

  const scores = attempts.map((attempt) => {
    if (Number(attempt.total) <= 0) return 0;
    return (Number(attempt.score) / Number(attempt.total)) * 100;
  });

  const averageScore = average(scores);

  await db.execute(
    `INSERT INTO performance_analytics
     (user_id, course_id, average_score, weakest_topic, strongest_topic, total_attempts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       average_score = VALUES(average_score),
       total_attempts = VALUES(total_attempts)`,
    [
      userId,
      courseId,
      averageScore,
      averageScore >= 80 ? "Review maintenance" : "Quiz performance",
      averageScore >= 80 ? "Quiz performance" : "Module completion",
      attempts.length,
    ],
  );
}

export async function getLessonProgress(req, res) {
  const userId = req.user.userId;
  const lessonId = req.query.lesson_id || req.query.lessonId;

  if (!lessonId) {
    return res.status(400).json({
      success: false,
      message: "Lesson ID is required.",
    });
  }

  try {
    const [rows] = await db.execute(
      `SELECT *
       FROM lesson_progress
       WHERE user_id = ?
         AND (lesson_id = ? OR course_id = ?)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId, lessonId, lessonId],
    );

    return res.json({
      success: true,
      progress: rows[0] || {
        total_cards: 0,
        studied_cards: 0,
        progress_percent: 0,
        last_viewed_card: 0,
      },
    });
  } catch (error) {
    console.error("Get lesson progress error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch lesson progress.",
    });
  }
}

export async function saveLessonProgress(req, res) {
  const userId = req.user.userId;
  const lessonId = req.body.lesson_id || req.body.lessonId;
  const requestedCourseId = req.body.course_id || req.body.courseId || null;
  const totalCards = Number(req.body.total_cards || req.body.totalCards || 0);
  const studiedCards = Number(
    req.body.studied_cards || req.body.studiedCards || 0,
  );
  const progressPercent =
    req.body.progress_percent !== undefined
      ? Number(req.body.progress_percent)
      : totalCards > 0
        ? (studiedCards / totalCards) * 100
        : 0;
  const lastViewedCard = Number(
    req.body.last_viewed_card || req.body.lastViewedCard || studiedCards || 0,
  );

  if (!lessonId) {
    return res.status(400).json({
      success: false,
      message: "Lesson ID is required.",
    });
  }

  try {
    const courseId = requestedCourseId || (await resolveCourseId(lessonId));

    if (courseId) {
      await db.execute(
        `INSERT IGNORE INTO course_enrollments (course_id, user_id)
         VALUES (?, ?)`,
        [courseId, userId],
      );
    }

    await db.execute(
      `INSERT INTO lesson_progress
       (user_id, lesson_id, course_id, total_cards, studied_cards, progress_percent, last_viewed_card)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         course_id = VALUES(course_id),
         total_cards = VALUES(total_cards),
         studied_cards = VALUES(studied_cards),
         progress_percent = VALUES(progress_percent),
         last_viewed_card = VALUES(last_viewed_card)`,
      [
        userId,
        lessonId,
        courseId,
        totalCards,
        studiedCards,
        clampScore(progressPercent),
        lastViewedCard,
      ],
    );

    return res.json({
      success: true,
      message: "Lesson progress saved.",
    });
  } catch (error) {
    console.error("Save lesson progress error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save lesson progress.",
    });
  }
}

export async function saveQuizAttempt(req, res) {
  if (req.body.assessment_type === "main")
    return res.status(400).json({
      success: false,
      message: "Submit Main Quiz through its saved assessment endpoint.",
    });
  const userId = req.user.userId;
  const lessonId = req.body.lesson_id || req.body.lessonId || null;
  const requestedCourseId = req.body.course_id || req.body.courseId || null;
  const score = Number(req.body.score || 0);
  const total = Number(req.body.total || 0);
  const source = String(req.body.source || "lesson");
  const quizMode = String(req.body.quiz_mode || req.body.quizMode || "quiz");
  const timeSpent = Number(req.body.time_spent || req.body.timeSpent || 0);

  try {
    const courseId = requestedCourseId || (await resolveCourseId(lessonId));

    const [result] = await db.execute(
      `INSERT INTO quiz_attempts
       (user_id, lesson_id, course_id, score, total, source, quiz_mode, time_spent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, lessonId, courseId, score, total, source, quizMode, timeSpent],
    );

    const assessmentType =
      quizMode === "lesson" || req.body.assessment_type === "recap"
        ? "recap"
        : "practice";
    const answers = Array.isArray(req.body.answers)
      ? req.body.answers.slice(0, 500)
      : [];
    await db.execute(
      "INSERT INTO quiz_attempt_details (attempts_id, assessment_type, answers_json, module_index) VALUES (?, ?, ?, ?)",
      [
        result.insertId,
        assessmentType,
        JSON.stringify(answers),
        Number.isInteger(req.body.module_index) ? req.body.module_index : null,
      ],
    );

    if (courseId) {
      await db.execute(
        `INSERT IGNORE INTO course_enrollments (course_id, user_id)
         VALUES (?, ?)`,
        [courseId, userId],
      );
      await refreshPerformanceAnalytics(userId, courseId);
    }

    return res.status(201).json({
      success: true,
      attemptId: result.insertId,
      message: "Quiz attempt saved.",
    });
  } catch (error) {
    console.error("Save quiz attempt error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save quiz attempt.",
    });
  }
}

export async function generateAdaptiveFeedback(req, res) {
  const userId = req.user.userId;
  const lessonId = req.body.lessonId || req.body.lesson_id || null;
  const source = String(req.body.source || "lesson");
  const quizMode = String(req.body.quizMode || req.body.quiz_mode || "quiz");
  const contentTitle = String(req.body.contentTitle || "This lesson").trim();
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

  try {
    const grouped = new Map();

    answers.forEach((answer, index) => {
      const userAnswer = answer.userAnswer || answer.selectedAnswer || "";
      const correctAnswer = answer.correctAnswer || answer.answer || "";
      const isCorrect =
        typeof answer.isCorrect === "boolean"
          ? answer.isCorrect
          : String(userAnswer).trim().toLowerCase() ===
            String(correctAnswer).trim().toLowerCase();
      const topic =
        String(
          answer.topic || answer.subject || answer.category || "",
        ).trim() ||
        contentTitle ||
        "Course topic";

      if (!grouped.has(topic)) {
        grouped.set(topic, {
          topic,
          total: 0,
          correct: 0,
          questionIndexes: [],
          strengths: [],
          improvements: [],
        });
      }

      const group = grouped.get(topic);
      const question = String(
        answer.question || `Question ${index + 1}`,
      ).trim();

      group.total += 1;
      group.questionIndexes.push(index);

      if (isCorrect) {
        group.correct += 1;
        group.strengths.push(`Answered correctly: ${question}`);
      } else {
        group.improvements.push(question);
      }
    });

    const feedback = [...grouped.values()].map((group) => {
      const confidence =
        group.total > 0 ? clampScore((group.correct / group.total) * 100) : 0;
      const understanding =
        confidence >= 80
          ? "Good Understanding"
          : confidence >= 60
            ? "Developing Understanding"
            : "Needs More Practice";
      const reviewTopics = group.improvements.length
        ? group.improvements.slice(0, 3)
        : [group.topic];

      return {
        topic: group.topic,
        quizType: quizMode,
        understanding,
        confidence,
        questionIndexes: group.questionIndexes,
        strengths: group.strengths.slice(0, 2),
        areasForImprovement: group.improvements.slice(0, 3),
        suggestedReviewTopics: reviewTopics,
        recommendation:
          confidence >= 80
            ? `Keep practicing ${group.topic} to maintain mastery.`
            : `Review ${group.topic}, then retry the quiz to improve your score.`,
        adaptiveRecommendation:
          confidence >= 80
            ? `Use higher difficulty questions for ${group.topic}.`
            : `Prioritize review questions for ${group.topic} before moving to harder items.`,
        nextGoal:
          confidence >= 80
            ? "Reach 100% confidence on your next attempt."
            : "Reach 80% confidence to move into good understanding.",
      };
    });

    if (feedback.length > 0) {
      let attemptId = req.body.attempts_id || req.body.attemptId || null;

      if (!attemptId && lessonId) {
        const [attemptRows] = await db.execute(
          `SELECT attempts_id
           FROM quiz_attempts
           WHERE user_id = ?
             AND lesson_id = ?
             AND source = ?
             AND quiz_mode = ?
           ORDER BY created_at DESC, attempts_id DESC
           LIMIT 1`,
          [userId, lessonId, source, quizMode],
        );

        attemptId = attemptRows[0]?.attempts_id || null;
      }

      await db.execute(
        `INSERT INTO adaptive_feedback
         (attempts_id, user_id, strengths, weaknesses, recommendations)
         VALUES (?, ?, ?, ?, ?)`,
        [
          attemptId,
          userId,
          JSON.stringify(feedback.flatMap((item) => item.strengths)),
          JSON.stringify(feedback.flatMap((item) => item.areasForImprovement)),
          JSON.stringify(feedback.map((item) => item.recommendation)),
        ],
      );
    }

    return res.json({
      success: true,
      feedback,
    });
  } catch (error) {
    console.error("Generate adaptive feedback error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate adaptive feedback.",
    });
  }
}

export async function getQuizAttempts(req, res) {
  const source = req.query.source || "";
  const lessonId = req.query.lessonId || req.query.lesson_id || "";
  const deckId = req.query.deckId || req.query.deck_id || "";
  const quizMode = req.query.quizMode || req.query.quiz_mode || "";

  try {
    const where = ["user_id = ?"];
    const params = [req.user.userId];

    if (source) {
      where.push("source = ?");
      params.push(source);
    }
    if (lessonId) {
      where.push("(lesson_id = ? OR course_id = ?)");
      params.push(lessonId, lessonId);
    }
    if (deckId) {
      where.push("lesson_id = ?");
      params.push(deckId);
    }
    if (quizMode) {
      where.push("quiz_mode = ?");
      params.push(quizMode);
    }

    const [rows] = await db.execute(
      `SELECT COUNT(*) AS attempts
       FROM quiz_attempts
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      params,
    );

    return res.json({
      success: true,
      attempts: Number(rows[0]?.attempts || 0),
    });
  } catch (error) {
    console.error("Get quiz attempts error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch quiz attempts.",
    });
  }
}

export async function emailAssessmentResult(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    await assertCourseAccess(req.user, courseId);
    const attemptId = Number(req.params.attemptId);
    if (!Number.isSafeInteger(attemptId) || attemptId < 1)
      return res
        .status(400)
        .json({ success: false, message: "A saved response is required." });
    const [rows] = await db.execute(
      `SELECT a.*, d.assessment_type, d.answers_json,
       COALESCE(u.display_name,u.name,u.email) AS student_name, u.email,
       c.title AS course_title
       FROM quiz_attempts a
       JOIN users u ON u.userId=a.user_id
       JOIN courses c ON c.course_id=a.course_id
       LEFT JOIN quiz_attempt_details d ON d.attempts_id=a.attempts_id
       WHERE a.attempts_id=? AND a.course_id=?`,
      [attemptId, courseId],
    );
    const row = rows[0];
    if (!row)
      return res
        .status(404)
        .json({ success: false, message: "Response not found." });
    if (
      row.assessment_type !== "main" &&
      !/main/i.test(`${row.source} ${row.quiz_mode}`)
    )
      return res
        .status(400)
        .json({ success: false, message: "Select a Main Quiz response." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email || ""))
      return res.status(400).json({
        success: false,
        message: "The student has no valid email address.",
      });
    const answers = parseJsonList(row.answers_json);
    if (!answers.length)
      return res.status(409).json({
        success: false,
        message: "This response has no saved answer key.",
      });
    const report = [
      row.course_title,
      "Main Quiz results",
      `Student: ${row.student_name}`,
      `Score: ${row.score} / ${row.total}`,
      "",
      ...answers.map(
        (answer, index) =>
          `${index + 1}. ${answer.question || answer.prompt || `Question ${index + 1}`}\nStudent answer: ${answer.selected_answer ?? answer.selectedAnswer ?? answer.user_answer ?? answer.userAnswer ?? answer.response ?? answer.answer ?? "No answer"}\nCorrect answer: ${answer.correct_answer ?? answer.correctAnswer ?? answer.correct_response ?? "Not recorded"}${answer.explanation ? `\nExplanation: ${answer.explanation}` : ""}`,
      ),
    ].join("\n");
    await sendQuizResultEmail(
      row.email,
      `${row.course_title} — Main Quiz results`,
      report,
      {
        courseTitle: row.course_title,
        studentName: row.student_name,
        email: row.email,
        score: row.score,
        total: row.total,
        answers,
      },
    );
    return res.json({
      success: true,
      message: `Score and answer key sent to ${row.email}.`,
    });
  } catch (error) {
    console.error("Email assessment result:", error.message);
    return res.status(error.statusCode || 502).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Could not send the email. Check the server email settings and try again.",
    });
  }
}

export async function getAssessmentAttempts(req, res) {
  try {
    await assertCourseAccess(req.user, Number(req.params.courseId));
    const [attempts] = await db.execute(
      `SELECT a.*, d.assessment_type, d.answers_json, d.module_index,
      COALESCE(u.display_name, u.name, u.email) AS student_name, u.email AS student_email
      FROM quiz_attempts a LEFT JOIN quiz_attempt_details d ON d.attempts_id = a.attempts_id
      LEFT JOIN users u ON u.userId = a.user_id
      WHERE a.course_id = ? ORDER BY a.created_at, a.attempts_id`,
      [req.params.courseId],
    );
    const [students] = await db.execute(
      `SELECT ce.user_id, COALESCE(u.display_name, u.name, u.email) AS student_name
      FROM course_enrollments ce LEFT JOIN users u ON u.userId = ce.user_id WHERE ce.course_id = ? AND ce.status = 'approved'`,
      [req.params.courseId],
    );
    return res.json({
      success: true,
      attempts: attempts.map((a) => ({
        ...a,
        answers: parseJsonList(a.answers_json),
        assessment_type:
          a.quiz_mode === "lesson"
            ? "recap"
            : a.assessment_type ||
              (/main/i.test(a.source + " " + a.quiz_mode)
                ? "main"
                : "practice"),
      })),
      students,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ success: false, message: error.message });
  }
}
