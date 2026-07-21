import fs from "node:fs/promises";
import path from "node:path";

import {
  extractTextFromUploadedFile,
} from "../services/fileExtraction.js";

import {
  generateLessonContent,
} from "../services/geminiService.js";

import {
  generateQuizWithGemini,
} from "../services/quizGenerationService.js";

import {
  normalizeLessonPages,
  normalizeTextValue,
} from "../utils/normalize.js";

const allowedExtensions = new Set([
  "pdf",
  "docx",
  "txt",
]);

const maximumInlinePdfSize =
  15 * 1024 * 1024;

/*
 * POST /api/lessons/process-file
 *
 * Accepts:
 * multipart/form-data
 *
 * Field name:
 * file
 */
export async function processLessonFile(
  req,
  res
) {
  const uploadedFilePath =
    req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded.",
      });
    }

    const extension = path
      .extname(
        req.file.originalname
      )
      .replace(/^\./, "")
      .toLowerCase();

    if (
      !allowedExtensions.has(
        extension
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Only PDF, DOCX, and TXT files are allowed.",
      });
    }

    console.log(
      `Processing uploaded file: ${req.file.originalname}`
    );

    let textContent =
      await extractTextFromUploadedFile(
        uploadedFilePath,
        extension
      );

    textContent = String(
      textContent || ""
    ).trim();

    let pdfInlineData = null;

    /*
     * If normal PDF text extraction returns
     * no content, send the original PDF
     * directly to Gemini.
     */
    if (!textContent) {
      if (extension !== "pdf") {
        return res.status(400).json({
          success: false,
          message:
            "The uploaded file is empty or does not contain readable text.",
        });
      }

      if (
        req.file.size >
        maximumInlinePdfSize
      ) {
        return res.status(400).json({
          success: false,
          message:
            "This PDF has no readable text and is larger than 15 MB. Please upload a searchable or smaller PDF.",
        });
      }

      let pdfBuffer;

      try {
        pdfBuffer =
          await fs.readFile(
            uploadedFilePath
          );
      } catch (error) {
        console.error(
          "Could not read uploaded PDF:",
          error
        );

        return res.status(400).json({
          success: false,
          message:
            "The uploaded PDF could not be read.",
        });
      }

      pdfInlineData =
        pdfBuffer.toString(
          "base64"
        );

      console.log(
        "No searchable PDF text found. Sending PDF directly to Gemini."
      );
    }

    /*
     * Keep the prompt size controlled.
     */
    textContent = Array.from(
      textContent
    )
      .slice(0, 12_000)
      .join("");

    const parsed =
      await generateLessonContent({
        textContent,
        pdfInlineData,
      });

    const lessonPages =
      normalizeLessonPages(
        parsed.lesson_pages
      );

    return res.status(200).json({
      success: true,

      module_title:
        normalizeTextValue(
          parsed.module_title
        ),

      subject:
        normalizeTextValue(
          parsed.subject
        ),

      description:
        normalizeTextValue(
          parsed.description
        ),

      learning_objectives:
        normalizeTextValue(
          parsed.learning_objectives
        ),

      lesson_pages:
        lessonPages,
    });
  } catch (error) {
    console.error(
      "processLessonFile error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,

        message:
          error.message ||
          "Could not process the uploaded lesson file.",
      });
  } finally {
    /*
     * Always remove the temporary upload.
     */
    if (uploadedFilePath) {
      await fs
        .unlink(
          uploadedFilePath
        )
        .catch((error) => {
          console.error(
            "Could not remove temporary upload:",
            error.message
          );
        });
    }
  }
}

/*
 * POST /api/lessons/generate-quiz
 *
 * Accepts JSON:
 *
 * {
 *   lesson_title,
 *   lesson_content,
 *   learning_objectives,
 *   question_count,
 *   true_false_count,
 *   difficulty
 * }
 */
export async function generateLessonQuiz(
  req,
  res
) {
  try {
    const lessonTitle =
      String(
        req.body?.lesson_title ||
          ""
      ).trim();

    const learningObjectives =
      String(
        req.body
          ?.learning_objectives ||
          ""
      ).trim();

    let lessonContent =
      String(
        req.body?.lesson_content ||
          ""
      ).trim();

    let questionCount =
      Number.parseInt(
        req.body?.question_count,
        10
      );

    let trueFalseCount =
      Number.parseInt(
        req.body
          ?.true_false_count,
        10
      );

    const difficulty =
      String(
        req.body?.difficulty ||
          "medium"
      )
        .trim()
        .toLowerCase();

    /*
     * Default values.
     */
    if (
      !Number.isInteger(
        questionCount
      )
    ) {
      questionCount = 5;
    }

    if (
      !Number.isInteger(
        trueFalseCount
      )
    ) {
      trueFalseCount = 0;
    }

    /*
     * Keep counts within allowed limits.
     */
    questionCount = Math.max(
      1,
      Math.min(
        50,
        questionCount
      )
    );

    trueFalseCount = Math.max(
      0,
      Math.min(
        questionCount,
        trueFalseCount
      )
    );

    const allowedDifficulties =
      new Set([
        "easy",
        "medium",
        "hard",
      ]);

    if (
      !allowedDifficulties.has(
        difficulty
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Difficulty must be easy, medium, or hard.",
      });
    }

    if (
      !lessonContent &&
      !learningObjectives
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Lesson content or learning objectives are required.",
      });
    }

    /*
     * Limit lesson text sent to Gemini.
     */
    lessonContent = Array.from(
      lessonContent
    )
      .slice(0, 12_000)
      .join("");

    console.log(
      "Generating quiz:",
      {
        lessonTitle,
        questionCount,
        trueFalseCount,
        multipleChoiceCount:
          questionCount -
          trueFalseCount,
        difficulty,
      }
    );

    const questions =
      await generateQuizWithGemini({
        lessonTitle,
        lessonContent,
        learningObjectives,
        questionCount,
        trueFalseCount,
        difficulty,
      });

    return res.status(200).json({
      success: true,

      quiz: {
        questions,
      },

      generated_count:
        questions.length,

      question_count:
        questionCount,

      true_false_count:
        trueFalseCount,

      multiple_choice_count:
        questionCount -
        trueFalseCount,

      difficulty,
    });
  } catch (error) {
    console.error(
      "generateLessonQuiz error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,

        message:
          error.message ||
          "Could not generate the quiz.",
      });
  }
}