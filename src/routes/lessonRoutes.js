import {
  saveMainQuizPreview,
  generateMainQuizPreview,
  listGeneratedMainQuizzes,
  getMainConfig,
  saveMainConfig,
  startMainQuiz,
  submitMainQuiz,
  mainQuizAnalysis,
  mainQuizStatus,
} from "../services/mainQuizService.js";
import express from "express";

import upload from "../middleware/upload.js";
import authenticateUser from "../middleware/authMiddleware.js";

import {
  processLessonFile,
  generateLessonQuiz,
  retryLessonJob,
  getLessonJob,
  listLessonSources,
  queueSourceGeneration,
  deleteLessonSource,
  downloadLessonSource,
} from "../controllers/lessonController.js";

const router = express.Router();
const mainHandler = (handler) => async (req, res) => {
  try {
    res.json({ success: true, ...(await handler(req)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode
        ? error.message
        : "Main Quiz request failed. Please try again.",
    });
    if (!error.statusCode) console.error("Main Quiz:", error.message);
  }
};
router.get(
  "/main-quiz/status/:courseId/:moduleId",
  authenticateUser,
  mainHandler(async (req) => ({
    status: await mainQuizStatus(
      req.user,
      req.params.courseId,
      req.params.moduleId,
    ),
  })),
);
router.get(
  "/main-quiz/config/:courseId/:moduleId",
  authenticateUser,
  mainHandler(async (req) => ({
    config: await getMainConfig(
      req.user,
      req.params.courseId,
      req.params.moduleId,
    ),
  })),
);
router.get(
  "/main-quiz/generated/:courseId/:moduleId",
  authenticateUser,
  mainHandler(async (req) => ({
    quizzes: await listGeneratedMainQuizzes(
      req.user,
      req.params.courseId,
      req.params.moduleId,
    ),
  })),
);
router.post(
  "/main-quiz/config",
  authenticateUser,
  mainHandler(async (req) => ({
    config: await saveMainConfig(req.user, req.body),
  })),
);
router.post(
  "/main-quiz/preview",
  authenticateUser,
  mainHandler(async (req) => ({
    config: await generateMainQuizPreview(req.user, req.body),
  })),
);
router.put(
  "/main-quiz/preview",
  authenticateUser,
  mainHandler(async (req) => ({
    config: await saveMainQuizPreview(req.user, req.body),
  })),
);
router.post(
  "/main-quiz/start",
  authenticateUser,
  mainHandler(async (req) => ({
    quiz: await startMainQuiz(req.user, req.body),
  })),
);
router.post(
  "/main-quiz/submit",
  authenticateUser,
  mainHandler(async (req) => ({
    result: await submitMainQuiz(req.user, req.body),
  })),
);
router.get(
  "/main-quiz/analysis/:courseId/:moduleId?",
  authenticateUser,
  mainHandler(async (req) => ({
    results: await mainQuizAnalysis(
      req.user,
      req.params.courseId,
      req.params.moduleId,
    ),
  })),
);
router.post("/jobs/:jobId/retry", authenticateUser, retryLessonJob);
router.get("/jobs/:jobId", authenticateUser, getLessonJob);
router.get("/sources", authenticateUser, listLessonSources);
router.get("/sources/:documentId/file", authenticateUser, downloadLessonSource);
router.post(
  "/sources/:documentId/generate",
  authenticateUser,
  queueSourceGeneration,
);
router.post(
  "/sources/:documentId/reindex",
  authenticateUser,
  queueSourceGeneration,
);
router.delete("/sources/:documentId", authenticateUser, deleteLessonSource);

function handleLessonUpload(req, res, next) {
  upload.fields([
    { name: "files", maxCount: 10 },
    { name: "file", maxCount: 1 },
  ])(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    console.error("Lesson upload error:", error);

    let message = error.message || "File upload failed.";

    if (error.code === "LIMIT_FILE_SIZE") {
      message = "The uploaded file is too large. The maximum size is 25 MB.";
    }
    if (
      error.code === "LIMIT_FILE_COUNT" ||
      error.code === "LIMIT_UNEXPECTED_FILE"
    )
      message =
        "Upload at most 10 files using the files field (or one legacy file field).";

    return res.status(error.statusCode || 400).json({
      success: false,
      message,
    });
  });
}

router.post(
  "/process-file",
  authenticateUser,
  handleLessonUpload,
  processLessonFile,
);

router.post("/generate-quiz", authenticateUser, generateLessonQuiz);

export default router;
