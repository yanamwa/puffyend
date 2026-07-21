import express from "express";

import upload from "../middleware/upload.js";

import {
  processLessonFile,
  generateLessonQuiz,
} from "../controllers/lessonController.js";

const router = express.Router();

function handleLessonUpload(
  req,
  res,
  next
) {
  upload.single("file")(
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
  handleLessonUpload,
  processLessonFile
);

router.post(
  "/generate-quiz",
  generateLessonQuiz
);

export default router;