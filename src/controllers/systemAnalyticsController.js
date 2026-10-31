import { db } from "../db.js";

/* =====================================================
   NUMBER HELPERS
===================================================== */

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function toPercent(value) {
  const number = toNumber(value);

  return Math.round(number * 100) / 100;
}

/* =====================================================
   GET SYSTEM ANALYTICS
===================================================== */

export async function getSystemAnalytics(req, res) {
  try {
    /* =================================================
       USER ANALYTICS
    ================================================= */

    const [[userStats]] = await db.execute(`
      SELECT
        COUNT(*) AS totalUsers,

        SUM(
          CASE
            WHEN role = 'student'
            AND is_archived = 0
            THEN 1
            ELSE 0
          END
        ) AS students,

        SUM(
          CASE
            WHEN role = 'professor'
            AND is_archived = 0
            THEN 1
            ELSE 0
          END
        ) AS professors,

        SUM(
          CASE
            WHEN role = 'admin'
            AND is_archived = 0
            THEN 1
            ELSE 0
          END
        ) AS administrators,

        SUM(
          CASE
            WHEN is_archived = 0
            THEN 1
            ELSE 0
          END
        ) AS activeAccounts,

        SUM(
          CASE
            WHEN is_archived = 1
            THEN 1
            ELSE 0
          END
        ) AS archivedAccounts,

        SUM(
          CASE
<<<<<<< HEAD
            WHEN last_active >= (NOW() - INTERVAL '7 day')
=======
            WHEN last_active >= DATE_SUB(NOW(), INTERVAL 7 DAY)
>>>>>>> backend/main
            AND is_archived = 0
            THEN 1
            ELSE 0
          END
        ) AS activeUsersThisWeek

      FROM users
    `);

    /* =================================================
       USER REGISTRATIONS

       Current month versus previous month.
    ================================================= */

    const [[registrationStats]] = await db.execute(`
      SELECT

        SUM(
          CASE
<<<<<<< HEAD
            WHEN created_at >= DATE_TRUNC('month', NOW())
=======
            WHEN created_at >= DATE_FORMAT(
              NOW(),
              '%Y-%m-01'
            )
>>>>>>> backend/main
            THEN 1
            ELSE 0
          END
        ) AS registrationsThisMonth,

        SUM(
          CASE
<<<<<<< HEAD
            WHEN created_at >= DATE_TRUNC('month', (NOW() - INTERVAL '1 month'))
            AND created_at <
              DATE_TRUNC('month', NOW())
=======
            WHEN created_at >= DATE_FORMAT(
              DATE_SUB(
                NOW(),
                INTERVAL 1 MONTH
              ),
              '%Y-%m-01'
            )
            AND created_at <
              DATE_FORMAT(
                NOW(),
                '%Y-%m-01'
              )
>>>>>>> backend/main
            THEN 1
            ELSE 0
          END
        ) AS registrationsPreviousMonth

      FROM users
      WHERE is_archived = 0
    `);

    /* =================================================
       COURSE ANALYTICS
    ================================================= */

    const [[courseStats]] = await db.execute(`
      SELECT
        COUNT(*) AS totalCourses,

        SUM(
          CASE
            WHEN archived = 0
            THEN 1
            ELSE 0
          END
        ) AS activeCourses,

        SUM(
          CASE
            WHEN archived = 1
            THEN 1
            ELSE 0
          END
        ) AS archivedCourses,

        SUM(
          CASE
            WHEN status = 'published'
            AND archived = 0
            THEN 1
            ELSE 0
          END
        ) AS publishedCourses

      FROM courses
    `);

    /* =================================================
       ENROLLMENT ANALYTICS
    ================================================= */

    const [[enrollmentStats]] = await db.execute(`
      SELECT
        COUNT(*) AS totalEnrollments,

        SUM(
          CASE
            WHEN status = 'approved'
            AND archived = 0
            THEN 1
            ELSE 0
          END
        ) AS approvedEnrollments,

        SUM(
          CASE
            WHEN status = 'pending'
            AND archived = 0
            THEN 1
            ELSE 0
          END
        ) AS pendingEnrollments,

        SUM(
          CASE
            WHEN status = 'declined'
            THEN 1
            ELSE 0
          END
        ) AS declinedEnrollments

      FROM course_enrollments
    `);

    /* =================================================
       LEARNING MODULE ANALYTICS
    ================================================= */

    const [[moduleStats]] = await db.execute(`
      SELECT
        COUNT(*) AS totalModules,

        SUM(
          CASE
            WHEN status = 'published'
            THEN 1
            ELSE 0
          END
        ) AS publishedModules,

        SUM(
          CASE
            WHEN status = 'draft'
            THEN 1
            ELSE 0
          END
        ) AS draftModules

      FROM learning_modules
    `);

    /* =================================================
       QUIZ ANALYTICS
    ================================================= */

    const [[quizStats]] = await db.execute(`
      SELECT
        COUNT(*) AS totalAttempts,

        COUNT(
          DISTINCT user_id
        ) AS studentsWithAttempts,

        COALESCE(
          AVG(
            CASE
              WHEN total > 0
              THEN
<<<<<<< HEAD
                (score::numeric / total) * 100
=======
                (score / total) * 100
>>>>>>> backend/main
              ELSE NULL
            END
          ),
          0
        ) AS averageScore,

        COALESCE(
          SUM(time_spent),
          0
        ) AS totalQuizTime

      FROM quiz_attempts
    `);

    /* =================================================
       QUIZ ACTIVITY THIS WEEK
    ================================================= */

    const [[weeklyQuizStats]] = await db.execute(`
      SELECT
        COUNT(*) AS attemptsThisWeek,

        COUNT(
          DISTINCT user_id
        ) AS studentsThisWeek

      FROM quiz_attempts

      WHERE created_at >=
<<<<<<< HEAD
        (NOW() - INTERVAL '7 day')
=======
        DATE_SUB(
          NOW(),
          INTERVAL 7 DAY
        )
>>>>>>> backend/main
    `);

    /* =================================================
       QUIZ MODE USAGE
    ================================================= */

    const [quizModeRows] = await db.execute(`
      SELECT
        COALESCE(
          quiz_mode,
          'unknown'
        ) AS quizMode,

        COUNT(*) AS attempts

      FROM quiz_attempts

      GROUP BY quiz_mode

      ORDER BY attempts DESC
    `);

    /* =================================================
       LEARNING PROGRESS
    ================================================= */

    const [[progressStats]] = await db.execute(`
      SELECT
        COUNT(*) AS progressRecords,

        COUNT(
          DISTINCT user_id
        ) AS studentsWithProgress,

        COALESCE(
          AVG(progress_percent),
          0
        ) AS averageProgress,

        SUM(
          CASE
            WHEN progress_percent >= 100
            THEN 1
            ELSE 0
          END
        ) AS completedModules,

        COUNT(
          DISTINCT CASE
            WHEN progress_percent >= 100
            THEN user_id
            ELSE NULL
          END
        ) AS studentsWithCompletedModules

      FROM lesson_progress
    `);

    /* =================================================
       STUDENTS AT MASTERY

       Temporary system rule:
       average quiz performance >= 80%.

       We can change this threshold later if your
       PuffyBrain mastery rule uses another value.
    ================================================= */

    const [[masteryStats]] = await db.execute(`
      SELECT
        COUNT(*) AS studentsAtMastery

      FROM (
        SELECT
          user_id,

          AVG(
            CASE
              WHEN total > 0
              THEN
<<<<<<< HEAD
                (score::numeric / total) * 100
              ELSE NULL
            END
          ) AS average_percentage
=======
                (score / total) * 100
              ELSE NULL
            END
          ) AS averagePercentage
>>>>>>> backend/main

        FROM quiz_attempts

        GROUP BY user_id

<<<<<<< HEAD
      ) AS mastery WHERE average_percentage >= 80
=======
        HAVING averagePercentage >= 80
      ) AS mastery
>>>>>>> backend/main
    `);

    /* =================================================
       CALCULATIONS
    ================================================= */

    const totalUsers = toNumber(userStats.totalUsers);

    const activeAccounts = toNumber(userStats.activeAccounts);

    const totalCourses = toNumber(courseStats.totalCourses);

    const publishedCourses = toNumber(courseStats.publishedCourses);

    const totalModules = toNumber(moduleStats.totalModules);

    const publishedModules = toNumber(moduleStats.publishedModules);

    const totalEnrollments = toNumber(enrollmentStats.totalEnrollments);

    const approvedEnrollments = toNumber(enrollmentStats.approvedEnrollments);

    const activeAccountRate =
      totalUsers > 0 ? toPercent((activeAccounts / totalUsers) * 100) : 0;

    const publishedCourseRate =
      totalCourses > 0 ? toPercent((publishedCourses / totalCourses) * 100) : 0;

    const enrollmentApprovalRate =
      totalEnrollments > 0
        ? toPercent((approvedEnrollments / totalEnrollments) * 100)
        : 0;

    const modulePublishRate =
      totalModules > 0 ? toPercent((publishedModules / totalModules) * 100) : 0;

    /* =================================================
       RESPONSE
    ================================================= */

    return res.json({
      success: true,

      generatedAt: new Date().toISOString(),

      /* -----------------------------------------------
         OVERVIEW
      ----------------------------------------------- */

      overview: {
        totalUsers,

        activeUsers: toNumber(userStats.activeUsersThisWeek),

        totalCourses,

        quizAttempts: toNumber(quizStats.totalAttempts),
      },

      /* -----------------------------------------------
         USER GROWTH
      ----------------------------------------------- */

      users: {
        total: totalUsers,

        students: toNumber(userStats.students),

        professors: toNumber(userStats.professors),

        administrators: toNumber(userStats.administrators),

        activeAccounts,

        archivedAccounts: toNumber(userStats.archivedAccounts),

        activeThisWeek: toNumber(userStats.activeUsersThisWeek),

        registrationsThisMonth: toNumber(
          registrationStats.registrationsThisMonth,
        ),

        registrationsPreviousMonth: toNumber(
          registrationStats.registrationsPreviousMonth,
        ),

        activeAccountRate,
      },

      /* -----------------------------------------------
         COURSE ACTIVITY
      ----------------------------------------------- */

      courses: {
        total: totalCourses,

        active: toNumber(courseStats.activeCourses),

        archived: toNumber(courseStats.archivedCourses),

        published: publishedCourses,

        publishedRate: publishedCourseRate,

        totalEnrollments,

        approvedEnrollments,

        pendingEnrollments: toNumber(enrollmentStats.pendingEnrollments),

        declinedEnrollments: toNumber(enrollmentStats.declinedEnrollments),

        enrollmentApprovalRate,

        totalModules,

        publishedModules,

        draftModules: toNumber(moduleStats.draftModules),

        modulePublishRate,
      },

      /* -----------------------------------------------
         QUIZ USAGE
      ----------------------------------------------- */

      quizzes: {
        totalAttempts: toNumber(quizStats.totalAttempts),

        studentsWithAttempts: toNumber(quizStats.studentsWithAttempts),

        averageScore: toPercent(quizStats.averageScore),

        totalQuizTime: toNumber(quizStats.totalQuizTime),

        attemptsThisWeek: toNumber(weeklyQuizStats.attemptsThisWeek),

        studentsThisWeek: toNumber(weeklyQuizStats.studentsThisWeek),

        modeUsage: quizModeRows.map((row) => ({
          mode: row.quizMode || "unknown",

          attempts: toNumber(row.attempts),
        })),
      },

      /* -----------------------------------------------
         LEARNING PROGRESS
      ----------------------------------------------- */

      learning: {
        progressRecords: toNumber(progressStats.progressRecords),

        studentsWithProgress: toNumber(progressStats.studentsWithProgress),

        averageProgress: toPercent(progressStats.averageProgress),

        completedModules: toNumber(progressStats.completedModules),

        studentsWithCompletedModules: toNumber(
          progressStats.studentsWithCompletedModules,
        ),

        studentsAtMastery: toNumber(masteryStats.studentsAtMastery),

        masteryThreshold: 80,
      },
    });
  } catch (error) {
    console.error("System analytics error:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to load system analytics.",
    });
  }
}
