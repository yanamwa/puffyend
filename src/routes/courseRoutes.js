import express from "express";

import {
  createCourse,
  createLearningModule,
  archiveCourse,
  deleteCourse,
  deleteLearningModule,
  getCourseById,
  getEnrolledCourses,
  getArchivedCourses,
  getCourses,
  getLearningModuleById,
  getLearningModules,
  handleLegacyLearningModule,

  // ENROLLMENT
  enrollCourse,
  getCourseEnrollments,
  approveEnrollment,
  declineEnrollment,
  unenrollStudentFromCourse,
  unenrollCourse,

  joinCourseByCode,
  updateCourse,
  updateLearningModule,
} from "../controllers/courseController.js";

import {
  createMode,
  deleteMode,
  getModes,
  updateMode,
} from "../controllers/modeController.js";

import {
  generateAdaptiveFeedback,
  getCourseMonitoring,
  getLessonProgress,
  getQuizAttempts,
  saveLessonProgress,
  saveQuizAttempt,
} from "../controllers/monitoringController.js";
import authenticateUser from "../middleware/authMiddleware.js";
const router = express.Router();


/* =====================================================
   LEGACY MULTIPART PARSER
===================================================== */

function parseMultipartText(body, boundary) {
  const result = {};

  const parts = body.split(
    `--${boundary}`
  );

  parts.forEach((part) => {
    const nameMatch = part.match(
      /name="([^"]+)"/
    );

    if (!nameMatch) {
      return;
    }

    const filenameMatch = part.match(
      /filename="([^"]*)"/
    );

    const valueStart =
      part.indexOf("\r\n\r\n");

    if (valueStart === -1) {
      return;
    }

    const rawValue = part
      .slice(valueStart + 4)
      .replace(/\r\n$/, "")
      .trim();

    result[nameMatch[1]] =
      filenameMatch
        ? filenameMatch[1]
        : rawValue;
  });

  return result;
}


/* =====================================================
   LEGACY MODE BODY PARSER
===================================================== */

function parseLegacyModeBody(
  req,
  _res,
  next
) {
  if (
    req.body &&
    Object.keys(req.body).length > 0
  ) {
    return next();
  }

  const contentType =
    req.headers["content-type"] || "";

  const boundary =
    contentType.match(
      /boundary=(.+)$/
    )?.[1];

  if (
    !contentType.includes(
      "multipart/form-data"
    ) ||
    !boundary
  ) {
    return next();
  }

  let body = "";

  req.setEncoding("binary");

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    req.body = parseMultipartText(
      body,
      boundary
    );

    next();
  });

  req.on("error", next);
}


/* =====================================================
   COURSES
===================================================== */

/*
 * Get all courses
 */
router.get(
  "/courses",
  getCourses
);


/*
 * Create course
 */
router.post(
  "/courses",
  authenticateUser,
  createCourse
);


/* =====================================================
   COURSE ENROLLMENT
===================================================== */

/*
 * Get all courses where the current
 * student is already approved/enrolled.
 *
 * Example:
 * GET /api/courses/enrolled
 */
router.get(
  "/courses/enrolled",
  getEnrolledCourses
);


/*
 * Student sends an enrollment request.
 *
 * This should create/update:
 *
 * course_enrollments
 * status = "pending"
 *
 * Example:
 * POST /api/courses/enroll
 *
 * Body:
 * {
 *   "courseId": 7
 * }
 */
router.post(
  "/courses/enroll",
  authenticateUser,
  enrollCourse
);


/*
 * Professor gets all enrollment records
 * belonging to one specific course.
 *
 * The controller should return:
 *
 * {
 *   pending: [],
 *   enrolled: []
 * }
 *
 * Example:
 * GET /api/courses/7/enrollments
 */
router.get(
  "/courses/:courseId/enrollments",
  getCourseEnrollments
);


/*
 * Professor approves a student's
 * pending enrollment request.
 *
 * Example:
 * PATCH /api/enrollments/25/approve
 */
router.patch(
  "/enrollments/:enrollmentId/approve",
  authenticateUser,
  approveEnrollment
);


/*
 * Professor declines a student's
 * pending enrollment request.
 *
 * Example:
 * PATCH /api/enrollments/25/decline
 */
router.patch(
  "/enrollments/:enrollmentId/decline",
  authenticateUser,
  declineEnrollment
);

/*
 * Professor removes an enrolled student
 * from this course.
 *
 * Example:
 * PATCH /api/enrollments/25/unenroll
 */
router.patch(
  "/enrollments/:enrollmentId/unenroll",
  unenrollStudentFromCourse
);


/*
 * Professor removes a student
 * from a course.
 *
 * Existing route kept for compatibility.
 *
 * Example:
 * PUT /api/courses/7/unenroll
 */
router.put(
  "/courses/:id/unenroll",
  unenrollCourse
);


/* =====================================================
   COURSE JOINING
===================================================== */

/*
 * Find/join course using course code
 */
router.get(
  "/courses/join",
  joinCourseByCode
);

router.post(
  "/courses/join",
  joinCourseByCode
);


/* =====================================================
   ARCHIVED COURSES
===================================================== */

router.get(
  "/courses/archived",
  getArchivedCourses
);


/* =====================================================
   SINGLE COURSE
===================================================== */

/*
 * IMPORTANT:
 *
 * Keep these AFTER routes such as:
 *
 * /courses/enrolled
 * /courses/join
 * /courses/archived
 *
 * so Express does not treat words like
 * "enrolled" as the :id parameter.
 */

router.get(
  "/courses/:id",
  getCourseById
);

router.put(
  "/courses/:id",
  authenticateUser,
  updateCourse
);

router.patch(
  "/courses/:id/archive",
  authenticateUser,
  archiveCourse
);

router.post(
  "/courses/:id/archive",
  authenticateUser,
  archiveCourse
);

router.delete(
  "/courses/:id",
  authenticateUser,
  deleteCourse
);


/* =====================================================
   LEARNING MODULES
===================================================== */

router.get(
  "/modules",
  getLearningModules
);

router.post(
  "/modules",
  createLearningModule
);

router.get(
  "/modules/:id",
  getLearningModuleById
);

router.put(
  "/modules/:id",
  updateLearningModule
);

router.delete(
  "/modules/:id",
  deleteLearningModule
);


/* =====================================================
   QUIZ MODES
===================================================== */

router.get(
  "/modes",
  getModes
);

router.post(
  "/modes",
  createMode
);

router.put(
  "/modes/:id",
  updateMode
);

router.delete(
  "/modes/:id",
  deleteMode
);


/* =====================================================
   MONITORING
===================================================== */

router.get(
  "/monitoring/:courseId",
  getCourseMonitoring
);

router.get(
  "/getLessonProgress.php",
  getLessonProgress
);

router.post(
  "/saveLessonProgress.php",
  saveLessonProgress
);

router.post(
  "/saveQuizAttempt.php",
  saveQuizAttempt
);

router.get(
  "/getQuizAttempts.php",
  getQuizAttempts
);

router.post(
  "/generateAdaptiveFeedback.php",
  generateAdaptiveFeedback
);


/* =====================================================
   LEGACY MODE ROUTES
===================================================== */

router.get(
  "/getModes.php",
  getModes
);

router.post(
  "/addMode.php",
  parseLegacyModeBody,
  createMode
);

router.post(
  "/updateMode.php",
  parseLegacyModeBody,
  updateMode
);

router.post(
  "/deleteMode.php",
  parseLegacyModeBody,
  deleteMode
);


/* =====================================================
   LEGACY LEARNING MODULE ROUTES
===================================================== */

router.get(
  "/adminLearningModule.php",
  handleLegacyLearningModule
);

router.post(
  "/adminLearningModule.php",
  handleLegacyLearningModule
);


/* =====================================================
   EXPORT
===================================================== */

export default router;
