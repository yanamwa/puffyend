import express from "express";

import upload from "../middleware/upload.js";
import authenticateUser from "../middleware/authMiddleware.js";

import {
  processLessonFile,
  generateLessonQuiz,
  retryLessonJob, getLessonJob, listLessonSources, queueSourceGeneration, deleteLessonSource, downloadLessonSource,
} from "../controllers/lessonController.js";

const router = express.Router();
router.post('/jobs/:jobId/retry', authenticateUser, retryLessonJob);
router.get('/jobs/:jobId', authenticateUser, getLessonJob);
router.get('/sources', authenticateUser, listLessonSources);
router.get('/sources/:documentId/file', authenticateUser, downloadLessonSource);
router.post('/sources/:documentId/generate', authenticateUser, queueSourceGeneration);
router.post('/sources/:documentId/reindex', authenticateUser, queueSourceGeneration);
router.delete('/sources/:documentId', authenticateUser, deleteLessonSource);

function handleLessonUpload(
  req,
  res,
  next
) {
  upload.fields([{ name: 'files', maxCount: 10 }, { name: 'file', maxCount: 1 }])(
    req,
    res,
    (error) => {
      if (!error) {
        next();
        return;
      }

      console.error(
        "Lesson upload error:",
        error
      );

      let message =
        error.message ||
        "File upload failed.";

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {
        message =
          "The uploaded file is too large. The maximum size is 25 MB.";
      }
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') message = 'Upload at most 10 files using the files field (or one legacy file field).';

      return res
        .status(
          error.statusCode || 400
        )
        .json({
          success: false,
          message,
        });
    }
  );
}

router.post(
  "/process-file",
  authenticateUser,
  handleLessonUpload,
  processLessonFile
);

router.post(
  "/generate-quiz",
  authenticateUser,
  generateLessonQuiz
);

export default router;
