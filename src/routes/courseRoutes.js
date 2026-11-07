import { requireRole } from "../middleware/roleMiddleware.js";
import express from "express";

import {
  // COURSES
  createCourse,
  archiveCourse,
  getCourseById,
  getEnrolledCourses,
  getArchivedCourses,
  getCourses,
  updateCourse,

  // LEARNING MODULES
  createLearningModule,
  deleteLearningModule,
  getLearningModuleById,
  getLearningModules,
  updateLearningModule,
  handleLegacyLearningModule,

  // ENROLLMENT
  enrollCourse,
  getCourseEnrollments,
  approveEnrollment,
  declineEnrollment,
  unenrollStudentFromCourse,
  unenrollCourse,
  joinCourseByCode,
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
  getAssessmentAttempts,
  emailAssessmentResult,
  getLessonProgress,
  getQuizAttempts,
  saveLessonProgress,
  saveQuizAttempt,
} from "../controllers/monitoringController.js";

import authenticateUser from "../middleware/authMiddleware.js";

const router = express.Router();
router.post(
  "/assessment-attempts/:courseId/:attemptId/email",
  authenticateUser,
  emailAssessmentResult,
);

/* =====================================================
   LEGACY MULTIPART PARSER
===================================================== */

function parseMultipartText(body, boundary) {
  const result = {};

  const parts = body.split(`--${boundary}`);

  parts.forEach((part) => {
    const nameMatch = part.match(/name="([^"]+)"/);

    if (!nameMatch) {
      return;
    }

    const filenameMatch = part.match(/filename="([^"]*)"/);

    const valueStart = part.indexOf("\r\n\r\n");

    if (valueStart === -1) {
      return;
    }

    const rawValue = part
      .slice(valueStart + 4)
      .replace(/\r\n$/, "")
      .trim();

    result[nameMatch[1]] = filenameMatch ? filenameMatch[1] : rawValue;
  });

  return result;
}

/* =====================================================
   LEGACY MODE BODY PARSER
===================================================== */

function parseLegacyModeBody(req, _res, next) {
  if (req.body && Object.keys(req.body).length > 0) {
    return next();
  }

  const contentType = req.headers["content-type"] || "";

  const boundary = contentType.match(/boundary=(.+)$/)?.[1];

  if (!contentType.includes("multipart/form-data") || !boundary) {
    return next();
  }

  let body = "";

  req.setEncoding("binary");

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    req.body = parseMultipartText(body, boundary);

    next();
  });

  req.on("error", next);
}

/* =====================================================
   COURSES
===================================================== */

/*
 * Get all courses.
 */
router.get("/courses", getCourses);

/*
 * Create a new course.
 *
 * AUDIT:
 * Created Course
 */
router.post("/courses", authenticateUser, requireRole("professor", "admin", "super_admin"), createCourse);

/* =====================================================
   COURSE ENROLLMENT
===================================================== */

/*
 * Get courses where the current student
 * is actively enrolled.
 *
 * GET /api/courses/enrolled
 */
router.get("/courses/enrolled", authenticateUser, getEnrolledCourses);

/*
 * Student sends an enrollment request.
 *
 * AUDIT:
 * Requested Enrollment
 *
 * POST /api/courses/enroll
 *
 * Body:
 * {
 *   "courseId": 7
 * }
 */
router.post("/courses/enroll", authenticateUser, enrollCourse);

/*
 * Professor gets enrollment records
 * for a specific course.
 *
 * GET /api/courses/7/enrollments
 */
router.get(
  "/courses/:courseId/enrollments",
  authenticateUser,
  getCourseEnrollments,
);

/*
 * Professor approves enrollment.
 *
 * AUDIT:
 * Approved Enrollment
 *
 * PATCH /api/enrollments/25/approve
 */
router.patch(
  "/enrollments/:enrollmentId/approve",
  authenticateUser,
  approveEnrollment,
);

/*
 * Professor declines enrollment.
 *
 * AUDIT:
 * Declined Enrollment
 *
 * PATCH /api/enrollments/25/decline
 */
router.patch(
  "/enrollments/:enrollmentId/decline",
  authenticateUser,
  declineEnrollment,
);

/*
 * Professor removes an enrolled student.
 *
 * AUDIT:
 * Unenrolled Student
 *
 * PATCH /api/enrollments/25/unenroll
 */
router.patch(
  "/enrollments/:enrollmentId/unenroll",
  authenticateUser,
  unenrollStudentFromCourse,
);

/*
 * Student leaves/un-enrolls from a course.
 *
 * AUDIT:
 * Left Course
 *
 * PUT /api/courses/7/unenroll
 */
router.put("/courses/:id/unenroll", authenticateUser, unenrollCourse);

/* =====================================================
   COURSE JOINING
===================================================== */

/*
 * Find/join a course using a course code.
 */
router.get("/courses/join", joinCourseByCode);

router.post("/courses/join", authenticateUser, enrollCourse);

/* =====================================================
   ARCHIVED COURSES
===================================================== */

/*
 * Get archived courses for the
 * authenticated student.
 */
router.get("/courses/archived", authenticateUser, getArchivedCourses);

/* =====================================================
   SINGLE COURSE
===================================================== */

/*
 * IMPORTANT:
 *
 * Keep these routes AFTER:
 *
 * /courses/enrolled
 * /courses/join
 * /courses/archived
 *
 * Otherwise Express may interpret words such
 * as "enrolled" as the :id parameter.
 */

router.get("/courses/:id", getCourseById);

/*
 * Update course.
 *
 * AUDIT:
 * Updated Course
 */
router.put("/courses/:id", authenticateUser, requireRole("professor", "admin", "super_admin"), updateCourse);

/*
 * Archive or restore course.
 *
 * AUDIT:
 * Archived Course
 * Restored Course
 */
router.patch("/courses/:id/archive", authenticateUser, archiveCourse);

/*
 * Compatibility route for archive/restore.
 */
router.post("/courses/:id/archive", authenticateUser, archiveCourse);

/*
 * NO DELETE COURSE ROUTE.
 *
 * PuffyBrain uses archive/restore instead
 * of permanent course deletion.
 */

/* =====================================================
   LEARNING MODULES
===================================================== */

/*
 * Get learning modules.
 *
 * Reading data does not need an audit entry.
 */
router.get("/modules", getLearningModules);

/*
 * Create learning module.
 *
 * AUDIT:
 * Created Learning Module
 */
router.post("/modules", authenticateUser, createLearningModule);

/*
 * Get one learning module.
 */
router.get("/modules/:id", getLearningModuleById);

/*
 * Update learning module.
 *
 * AUDIT:
 * Updated Learning Module
 */
router.put("/modules/:id", authenticateUser, updateLearningModule);

/*
 * Delete learning module.
 *
 * AUDIT:
 * Deleted Learning Module
 *
 * NOTE:
 * If modules should eventually use archive
 * instead of permanent deletion, this can
 * later be changed to an archive route.
 */
router.delete("/modules/:id", authenticateUser, deleteLearningModule);

/* =====================================================
   QUIZ MODES
===================================================== */

router.get("/modes", getModes);

router.post("/modes", authenticateUser, createMode);

router.put("/modes/:id", authenticateUser, updateMode);

router.delete("/modes/:id", authenticateUser, deleteMode);

/* =====================================================
   MONITORING
===================================================== */

router.get(
  "/assessment-attempts/:courseId",
  authenticateUser,
  getAssessmentAttempts,
);

router.get("/monitoring/:courseId", getCourseMonitoring);

router.get("/getLessonProgress.php", getLessonProgress);

router.post("/saveLessonProgress.php", saveLessonProgress);

router.post("/saveQuizAttempt.php", authenticateUser, saveQuizAttempt);

router.get("/getQuizAttempts.php", authenticateUser, getQuizAttempts);

router.post("/generateAdaptiveFeedback.php", generateAdaptiveFeedback);

/* =====================================================
   LEGACY MODE ROUTES
===================================================== */

router.get("/getModes.php", getModes);

router.post("/addMode.php", authenticateUser, parseLegacyModeBody, createMode);

router.post(
  "/updateMode.php",
  authenticateUser,
  parseLegacyModeBody,
  updateMode,
);

router.post(
  "/deleteMode.php",
  authenticateUser,
  parseLegacyModeBody,
  deleteMode,
);

/* =====================================================
   LEGACY LEARNING MODULE ROUTES
===================================================== */

router.get("/adminLearningModule.php", handleLegacyLearningModule);

router.post(
  "/adminLearningModule.php",
  authenticateUser,
  handleLegacyLearningModule,
);

/* =====================================================
   EXPORT
===================================================== */

export default router;
