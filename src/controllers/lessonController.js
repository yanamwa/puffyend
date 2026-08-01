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

const minimumReadableCharacterCount = 30;

function cleanExtractedText(value) {
  return String(value || "")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasReadableLessonText(value) {
  const text = cleanExtractedText(value);
  const letters = text.replace(/[^A-Za-z]/g, "");

  return letters.length >= minimumReadableCharacterCount;
}

function createFallbackModuleTitle(fileName) {
  const baseName = path.basename(
    String(fileName || "Uploaded lesson"),
    path.extname(String(fileName || ""))
  );

  return baseName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Uploaded lesson";
}

function summarizeText(value, maxLength = 220) {
  const text = cleanExtractedText(value).replace(/\s+/g, " ");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trim()}...`;
}

function titleFromChunk(chunk, index) {
  const firstLine = String(chunk || "")
    .split(/\n|[.!?]\s/)
    .map((part) => part.trim())
    .find(Boolean);

  const title = String(firstLine || "")
    .replace(/[^A-Za-z0-9 ():/,.-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();

  return title || `Lesson Page ${index + 1}`;
}

function createFallbackLessonPages(textContent) {
  const text = cleanExtractedText(textContent);

  if (!hasReadableLessonText(text)) {
    return [];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const pages = [];
  const wordsPerPage = 140;

  for (let index = 0; index < words.length; index += wordsPerPage) {
    const chunk = words.slice(index, index + wordsPerPage).join(" ");

    pages.push({
      title: titleFromChunk(chunk, pages.length),
      content: chunk,
    });
  }

  return pages;
}

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

    textContent = cleanExtractedText(
      textContent
    );

    let pdfInlineData = null;

    /*
     * If normal PDF text extraction returns
     * no content, send the original PDF
     * directly to Gemini.
     */
    if (
      !hasReadableLessonText(
        textContent
      )
    ) {
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

      textContent = "";

      console.log(
        "No readable PDF text found. Sending PDF directly to Gemini."
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

    let lessonPages =
      normalizeLessonPages(
        parsed.lesson_pages
      );

    if (
      lessonPages.length === 0 &&
      hasReadableLessonText(
        textContent
      )
    ) {
      lessonPages =
        createFallbackLessonPages(
          textContent
        );
    }

    if (lessonPages.length === 0) {
      return res.status(422).json({
        success: false,
        message:
          extension === "pdf"
            ? "The PDF uploaded, but no readable lesson text could be found. If it is scanned or image-only, please upload a searchable PDF, DOCX, or TXT file."
            : "The uploaded file was processed, but no lesson pages could be created from its text.",
      });
    }

    const moduleTitle =
      normalizeTextValue(
        parsed.module_title
      ) ||
      createFallbackModuleTitle(
        req.file.originalname
      );

    const description =
      normalizeTextValue(
        parsed.description
      ) ||
      summarizeText(
        textContent ||
          lessonPages
            .map((page) => page.content)
            .join(" ")
      );

    const learningObjectives =
      normalizeTextValue(
        parsed.learning_objectives
      ) ||
      `- Understand the key ideas in ${moduleTitle}.`;

    return res.status(200).json({
      success: true,

      module_title:
        moduleTitle,

      subject:
        normalizeTextValue(
          parsed.subject
        ) || moduleTitle,

      description:
        description,

      learning_objectives:
        learningObjectives,

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
