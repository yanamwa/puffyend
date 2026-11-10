import { assertCourseAccess, requestError } from "../rag/courseAccessService.js";
import { generateQuizBatch, generateQuizWithRag } from "../rag/quizRagService.js";
import { savedLessonChunks } from "./mainQuizService.js";

const QUESTION_COUNT = 5;

export async function generateModuleRecap({ user, body }) {
  if (!Array.isArray(body.document_ids || [])) {
    throw requestError("document_ids must be an array.", 400);
  }
  if (body.document_ids?.length) {
    const result = await generateQuizWithRag({
      user,
      body: {
        ...body,
        assessment_type: "practice",
        question_count: QUESTION_COUNT,
        identification_count: 0,
        multiple_choice_count: QUESTION_COUNT,
        true_false_count: 0,
        lots_count: QUESTION_COUNT,
        hots_count: 0,
      },
    });
    return { ...result, assessmentType: "recap" };
  }

  const courseId = Number(body.course_id);
  const lessonId = body.lesson_id ? Number(body.lesson_id) : null;
  await assertCourseAccess(user, courseId, lessonId);
  const moduleId = lessonId || "recap";
  const title = String(body.lesson_title || "Module").slice(0, 100);
  const objectives = String(body.learning_objectives || "").slice(0, 1500);
  const content = String(body.lesson_content || "").slice(0, 30000).trim();
  const chunks = savedLessonChunks([{ moduleId, title, content }], moduleId);
  if (!chunks.length) {
    throw requestError("Add lesson content before generating Quick Recap.", 409);
  }

  const questions = await generateQuizBatch({
    types: Array(QUESTION_COUNT).fill("multiple_choice"),
    skills: Array(QUESTION_COUNT).fill("LOTS"),
    chunks,
    title,
    objectives,
    difficulty: "easy",
    lessonContent: content,
  });
  return {
    questions,
    questionCount: QUESTION_COUNT,
    identificationCount: 0,
    document_ids: [],
    assessmentType: "recap",
  };
}
