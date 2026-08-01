import express from "express";
import {
  createCourse,
  createLearningModule,
  deleteCourse,
  deleteLearningModule,
  getCourseById,
  getEnrolledCourses,
  getCourses,
  getLearningModuleById,
  getLearningModules,
  handleLegacyLearningModule,
  enrollCourse,
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

const router = express.Router();

function parseMultipartText(body, boundary) {
  const result = {};
  const parts = body.split(`--${boundary}`);

  parts.forEach((part) => {
    const nameMatch = part.match(/name="([^"]+)"/);
    if (!nameMatch) return;

    const filenameMatch = part.match(/filename="([^"]*)"/);
    const valueStart = part.indexOf("\r\n\r\n");
    if (valueStart === -1) return;

    const rawValue = part.slice(valueStart + 4).replace(/\r\n$/, "").trim();
    result[nameMatch[1]] = filenameMatch ? filenameMatch[1] : rawValue;
  });

  return result;
}

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

router.get("/courses", getCourses);
router.post("/courses", createCourse);
router.get("/courses/enrolled", getEnrolledCourses);
router.post("/courses/enroll", enrollCourse);
router.get("/courses/join", joinCourseByCode);
router.post("/courses/join", joinCourseByCode);
router.get("/courses/:id", getCourseById);
router.put("/courses/:id", updateCourse);
router.delete("/courses/:id", deleteCourse);

router.get("/modules", getLearningModules);
router.post("/modules", createLearningModule);
router.get("/modules/:id", getLearningModuleById);
router.put("/modules/:id", updateLearningModule);
router.delete("/modules/:id", deleteLearningModule);

router.get("/modes", getModes);
router.post("/modes", createMode);
router.put("/modes/:id", updateMode);
router.delete("/modes/:id", deleteMode);

router.get("/monitoring/:courseId", getCourseMonitoring);
router.get("/getLessonProgress.php", getLessonProgress);
router.post("/saveLessonProgress.php", saveLessonProgress);
router.post("/saveQuizAttempt.php", saveQuizAttempt);
router.get("/getQuizAttempts.php", getQuizAttempts);
router.post("/generateAdaptiveFeedback.php", generateAdaptiveFeedback);

router.get("/getModes.php", getModes);
router.post("/addMode.php", parseLegacyModeBody, createMode);
router.post("/updateMode.php", parseLegacyModeBody, updateMode);
router.post("/deleteMode.php", parseLegacyModeBody, deleteMode);

router.get("/adminLearningModule.php", handleLegacyLearningModule);
router.post("/adminLearningModule.php", handleLegacyLearningModule);

export default router;
