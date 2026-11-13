import { getEnrolledPracticeModule } from "../../controllers/courseController.js";
import { db } from "../../db.js";
import { removeLessonPracticeActivities } from "../lessons/lessonPracticeContent.js";
import { requestError } from "../rag/courseAccessService.js";
import { parallelMap } from "../rag/parallelMap.js";
import { generateQuizBatch } from "../rag/quizRagService.js";
import {
  answersMatchQuestion,
  normalizeAnswer,
  shuffleMainQuizQuestions,
} from "./mainQuizAdaptive.js";
import { savedLessonChunks } from "./mainQuizService.js";
import {
  DUPLICATE_QUIZ_QUESTION,
  validateQuizUniqueness,
} from "./quizValidation.js";

const QUESTION_COUNT = 20;
const MASTERY_TARGET = 90;
const RECAP_LIMIT = 5;
const practiceModes = new Set([
  "flashcard",
  "qna",
  "multiple",
  "matching",
  "timed",
  "mixed",
]);
const mixedBatchTypes = [
  "multiple_choice",
  "multiple_choice",
  "multiple_choice",
  "true_false",
  "identification",
];
const starting = new Map();

function normalizeRecapAnswer(value) {
  return normalizeAnswer(value);
}

function recapPerformance(questions, submitted) {
  if (!questions.length) return [];
  const recapRequired = () =>
    Object.assign(
      requestError(
        "Finish this module's Quick Recap before starting practice.",
        409,
      ),
      { code: "QUICK_RECAP_REQUIRED" },
    );
  if (submitted == null) throw recapRequired();
  if (
    !Array.isArray(submitted) ||
    submitted.length > RECAP_LIMIT ||
    submitted.some(
      (item) =>
        typeof item?.question !== "string" ||
        item.question.length > 2000 ||
        typeof item?.userAnswer !== "string" ||
        item.userAnswer.length > 2000,
    )
  )
    throw requestError("Quick Recap answers are invalid.", 400);

  const responses = new Map(
    submitted.map(({ question, userAnswer }) => [
      question.trim(),
      normalizeRecapAnswer(userAnswer),
    ]),
  );

  return questions.flatMap((item) => {
    const submittedAnswer = responses.get(item.question.trim());
    const options = Array.isArray(item.options)
      ? item.options.filter(Boolean)
      : [];
    if (
      !submittedAnswer ||
      (options.length &&
        !options.some(
          (option) => normalizeRecapAnswer(option) === submittedAnswer,
        ))
    )
      throw recapRequired();
    const rawKey = item.correct_answer || item.correctAnswer || item.answer;
    const letter = /^\s*([a-z])[.)]?\s*$/i.exec(String(rawKey ?? ""));
    const labeledAnswer = /^\s*[a-z][.)]\s+(.+)$/i.exec(
      String(rawKey ?? ""),
    );
    const key = letter
      ? (options[letter[1].toUpperCase().charCodeAt(0) - 65] ?? rawKey)
      : labeledAnswer
        ? labeledAnswer[1]
        : rawKey;
    const correctAnswer = normalizeRecapAnswer(key);
    if (!correctAnswer) return [];
    return [
      {
        question: item.question,
        topic: item.topic || item.category || item.subject || "",
        isCorrect: answersMatchQuestion(submittedAnswer, {
          ...item,
          correct_answer: key,
        }),
      },
    ];
  });
}

async function generatePracticeBatch(options, generateBatch) {
  try {
    return await generateBatch(options);
  } catch (error) {
    if (error.code !== DUPLICATE_QUIZ_QUESTION) throw error;
  }

  const { types, skills, practiceFocus } = options;
  const midpoint = Math.ceil(types.length / 2);
  const generateRange = (start, end) =>
    generateBatch({
      ...options,
      types: types.slice(start, end),
      skills: skills.slice(start, end),
      practiceFocus: practiceFocus && {
        ...practiceFocus,
        target_count:
          Math.round((practiceFocus.target_count * end) / types.length) -
          Math.round((practiceFocus.target_count * start) / types.length),
      },
    });

  // Let the second prompt see the first set of newly accepted stems.
  const first = await generateRange(0, midpoint);
  const second = await generateRange(midpoint, types.length);
  return [...first, ...second];
}

export async function generatePracticeQuestions(
  module,
  performance,
  previousQuestions,
  { format = "mixed", generateBatch = generateQuizBatch } = {},
) {
  const shortAnswer = format === "qna";
  const batchTypes = shortAnswer
    ? mixedBatchTypes.map(() => "identification")
    : mixedBatchTypes;
  const moduleId = String(module.id);
  const pages = module.lessonPages.map((page) => ({
    moduleId,
    title: page?.title || page?.heading,
    content: removeLessonPracticeActivities(
      typeof page === "string"
        ? page
        : page?.content || page?.body || page?.lesson,
    ),
  }));
  const chunks = savedLessonChunks(pages, moduleId);
  if (!chunks.length)
    throw requestError(
      "This module needs lesson content before practice can start.",
      409,
    );

  const accuracy = performance.length
    ? performance.filter((item) => item.isCorrect).length / performance.length
    : 0.7;
  const difficulty =
    accuracy < 0.6 ? "easy" : accuracy >= 0.85 ? "hard" : "medium";
  const batchCount = QUESTION_COUNT / batchTypes.length;
  const hotsPerBatch = { easy: 1, medium: 2, hard: 3 }[difficulty];
  const hotsCount = hotsPerBatch * batchCount;
  const misses = performance
    .filter((item) => !item.isCorrect)
    .map(({ topic, question }) => ({ topic, question }));
  const focusTopics = [
    ...new Set(
      misses.map(({ topic }) => normalizeAnswer(topic)).filter(Boolean),
    ),
  ];
  const related = chunks.filter((chunk) => {
    const text = normalizeAnswer(
      `${chunk.source_filename} ${chunk.chunk_text}`,
    );
    return focusTopics.some((topic) => text.includes(topic));
  });
  const skills = batchTypes.map((_, index) =>
    index < hotsPerBatch ? "HOTS" : "LOTS",
  );
  const distribution = {
    questionCount: QUESTION_COUNT,
    multipleChoiceCount: shortAnswer ? 0 : 12,
    trueFalseCount: shortAnswer ? 0 : 4,
    identificationCount: shortAnswer ? QUESTION_COUNT : 4,
    hotsCount,
    lotsCount: QUESTION_COUNT - hotsCount,
  };
  const batches = Array.from({ length: batchCount }, (_, index) => index);
  const accepted = [...previousQuestions];

  const questions = (
    await parallelMap(batches, 3, async (index) => {
      const start = Math.floor((index * chunks.length) / batchCount);
      const spread = Array.from(
        { length: Math.min(chunks.length, 4) },
        (_, offset) => chunks[(start + offset) % chunks.length],
      );
      const focus = Array.from(
        { length: Math.min(related.length, 3) },
        (_, offset) => related[(index * 3 + offset) % related.length],
      );
      const context = [...new Set([...spread, ...focus])];
      return generatePracticeBatch(
        {
          types: batchTypes,
          chunks: context,
          title: module.title,
          objectives: module.learningObjectives,
          difficulty,
          skills,
          distribution,
          shortAnswer,
          previousQuestions: accepted,
          practiceFocus: misses.length
            ? { target_count: 3, missed_concepts: misses }
            : undefined,
          onValidated: (batch) => {
            validateQuizUniqueness(batch, accepted);
            accepted.push(...batch.map((question) => question.question));
          },
        },
        generateBatch,
      );
    })
  ).flat();

  if (questions.length !== QUESTION_COUNT)
    throw requestError(
      "Practice did not generate 20 questions. Please try again.",
      502,
    );
  validateQuizUniqueness(questions, previousQuestions);
  return shuffleMainQuizQuestions(questions).map((question, index) => ({
    ...question,
    id: index + 1,
  }));
}

function publicAttempt(row, mode) {
  return {
    id: row.attempt_id,
    questions: JSON.parse(row.questions_json).map(
      ({
        id,
        question,
        type,
        options,
        topic,
        correct_answer,
        accepted_answers,
        acceptedAnswers,
        acceptable_answers,
        acceptableAnswers,
        answer_aliases,
        answerAliases,
        alternatives,
        explanation,
      }) => ({
        id,
        question,
        type,
        options,
        topic,
        // The practice players show answer feedback and use keys for flips and pairs.
        ...(mode
          ? {
              correct_answer,
              accepted_answers:
                accepted_answers ??
                acceptedAnswers ??
                acceptable_answers ??
                acceptableAnswers ??
                answer_aliases ??
                answerAliases ??
                alternatives ??
                [],
              explanation,
            }
          : {}),
      }),
    ),
    total: QUESTION_COUNT,
    masteryTarget: MASTERY_TARGET,
  };
}

export async function startModulePractice(
  user,
  body,
  generate = generatePracticeQuestions,
) {
  const courseId = Number(body?.courseId);
  const requestedId = ["string", "number"].includes(typeof body?.moduleId)
    ? String(body.moduleId).trim()
    : "";
  if (
    !Number.isSafeInteger(courseId) ||
    courseId < 1 ||
    !requestedId ||
    requestedId.length > 100
  )
    throw requestError("A course and module are required.", 400);

  const module = await getEnrolledPracticeModule(user, courseId, requestedId);
  const mode = getPracticeMode(body.mode);
  const format = mode === "qna" ? "qna" : "mixed";
  const scope = [user.userId, courseId, String(module.id)];
  const formatScope = [...scope, format];
  const scopeKey = JSON.stringify(formatScope);
  if (starting.has(scopeKey))
    return publicAttempt(await starting.get(scopeKey), mode);

  const start = (async () => {
    const [[previousInFormat]] = await db.execute(
      `SELECT attempt_id, questions_json, result_json FROM module_practice_attempts
       WHERE user_id=? AND course_id=? AND module_id=? AND question_format=?
       ORDER BY attempt_id DESC LIMIT 1`,
      formatScope,
    );
    if (previousInFormat && !previousInFormat.result_json)
      return previousInFormat;

    const [[latestCompleted]] = await db.execute(
      `SELECT attempt_id, questions_json, result_json FROM module_practice_attempts
       WHERE user_id=? AND course_id=? AND module_id=? AND result_json IS NOT NULL
       ORDER BY completed_at DESC, attempt_id DESC LIMIT 1`,
      scope,
    );

    const recap = module.quizItems
      .filter(
        (item) => typeof item?.question === "string" && item.question.trim(),
      )
      .slice(0, RECAP_LIMIT)
      .filter(
        (item) =>
          item.type === "identification" ||
          (Array.isArray(item.options) && item.options.some(Boolean)),
      );
    const performance = latestCompleted
      ? JSON.parse(latestCompleted.result_json).answers
      : recapPerformance(recap, body.recapAnswers);
    const previousQuestions = [
      ...new Set([
        ...recap.map((item) => item.question),
        ...[previousInFormat, latestCompleted]
          .filter(Boolean)
          .flatMap((attempt) =>
            JSON.parse(attempt.questions_json).map((item) => item.question),
          ),
      ]),
    ];
    let questions;
    try {
      questions = await generate(module, performance, previousQuestions, {
        format,
      });
    } catch (error) {
      if (error.statusCode === 409) throw error;
      console.error("Module Practice generation failed:", error.message);
      throw requestError(
        "We couldn't prepare 20 practice questions. Please try again.",
        error.statusCode || 500,
      );
    }
    const [insert] = await db.execute(
      `INSERT INTO module_practice_attempts (user_id, course_id, module_id, question_format, previous_attempt_id, questions_json)
       VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE attempt_id = LAST_INSERT_ID(attempt_id)`,
      [
        ...formatScope,
        previousInFormat?.attempt_id ?? 0,
        JSON.stringify(questions),
      ],
    );
    const [[attempt]] = await db.execute(
      "SELECT attempt_id, questions_json, result_json FROM module_practice_attempts WHERE attempt_id=?",
      [insert.insertId],
    );
    if (attempt.result_json)
      throw requestError(
        "That practice attempt was already submitted. Try starting again.",
        409,
      );
    return attempt;
  })();
  starting.set(scopeKey, start);
  try {
    return publicAttempt(await start, mode);
  } finally {
    starting.delete(scopeKey);
  }
}

function getPracticeMode(mode) {
  if (mode != null && !practiceModes.has(mode))
    throw requestError("Choose a valid quiz type.", 400);
  return mode;
}

function gradeAttempt(attemptId, questions, submitted, mode) {
  if (!Array.isArray(submitted) || submitted.length !== QUESTION_COUNT)
    throw requestError("Submit one answer for each of the 20 questions.", 400);

  const byQuestion = new Map();
  for (const item of submitted) {
    if (
      !Number.isInteger(item?.questionId) ||
      typeof item.answer !== "string" ||
      (!mode && !item.answer.trim()) ||
      item.answer.length > 500 ||
      byQuestion.has(item.questionId)
    )
      throw requestError("Submit one valid answer per question.", 400);
    byQuestion.set(item.questionId, item.answer.trim());
  }

  const answers = questions.map((question) => {
    const userAnswer = byQuestion.get(question.id);
    if (
      userAnswer === undefined ||
      (userAnswer &&
        (!mode || mode === "multiple" || mode === "timed") &&
        question.options.length &&
        !question.options.some(
          (option) => normalizeAnswer(option) === normalizeAnswer(userAnswer),
        ))
    )
      throw requestError(
        "An answer does not match its practice question.",
        400,
      );
    return {
      question: question.question,
      userAnswer,
      correctAnswer: question.correct_answer,
      explanation: question.explanation,
      topic: question.topic,
      cognitive_level: question.cognitive_level,
      thinking_skill: question.thinking_skill,
      isCorrect:
        mode === "flashcard"
          ? userAnswer === "easy" || userAnswer === "good"
          : Boolean(userAnswer) &&
            answersMatchQuestion(userAnswer, question),
    };
  });
  const score = answers.filter((answer) => answer.isCorrect).length;
  const percentage = (score * 100) / QUESTION_COUNT;
  return {
    attemptId,
    score,
    total: QUESTION_COUNT,
    percentage,
    mastered: percentage >= MASTERY_TARGET,
    masteryTarget: MASTERY_TARGET,
    answers,
  };
}

export async function submitModulePractice(user, body) {
  const attemptId = Number(body?.attemptId);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1)
    throw requestError("A practice attempt is required.", 400);
  if (user?.role !== "student")
    throw requestError("Only enrolled students can take Module Practice.", 403);

  const [[attempt]] = await db.execute(
    "SELECT course_id, module_id FROM module_practice_attempts WHERE attempt_id=? AND user_id=?",
    [attemptId, user.userId],
  );
  if (!attempt) throw requestError("Practice attempt not found.", 404);
  const module = await getEnrolledPracticeModule(
    user,
    attempt.course_id,
    attempt.module_id,
  );

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[row]] = await connection.execute(
      `SELECT questions_json, result_json, question_format FROM module_practice_attempts
       WHERE attempt_id=? AND user_id=? FOR UPDATE`,
      [attemptId, user.userId],
    );
    if (!row) throw requestError("Practice attempt not found.", 404);
    if (row.result_json) {
      const result = JSON.parse(row.result_json);
      await connection.commit();
      return result;
    }

    const mode = getPracticeMode(body.mode);
    const result = gradeAttempt(
      attemptId,
      JSON.parse(row.questions_json),
      body.answers,
      row.question_format === "qna" ? "qna" : mode,
    );
    const [record] = await connection.execute(
      "INSERT INTO quiz_attempts(user_id,course_id,score,total,source,quiz_mode) VALUES(?,?,?,?,?,?)",
      [
        user.userId,
        attempt.course_id,
        result.score,
        result.total,
        "module",
        "adaptive_practice",
      ],
    );
    await connection.execute(
      "INSERT INTO quiz_attempt_details(attempts_id,assessment_type,answers_json,module_index) VALUES(?,?,?,?)",
      [
        record.insertId,
        "practice",
        JSON.stringify(result.answers),
        module.moduleIndex,
      ],
    );
    await connection.execute(
      "UPDATE module_practice_attempts SET result_json=?, completed_at=CURRENT_TIMESTAMP(6) WHERE attempt_id=?",
      [JSON.stringify(result), attemptId],
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
