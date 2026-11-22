import { randomUUID } from "node:crypto";
import { getEnrolledPracticeModule } from "../../controllers/courseController.js";
import { db } from "../../db.js";
import { removeLessonPracticeActivities } from "../lessons/lessonPracticeContent.js";
import { requestError } from "../rag/courseAccessService.js";
import { createPracticeJsonGenerator, MIN_OPENAI_REQUEST_MS } from "../rag/aiProviderService.js";
import { remainingTime, withEarlierDeadline } from "../rag/jsonProviderRequest.js";
import {
  generateQuizBatch,
  selectPracticeFocus,
} from "../rag/quizRagService.js";
import {
  analyzePractice,
  buildPracticeFeedback,
  loadPracticeHistory,
  PRACTICE_FEEDBACK_VERSION,
  PRACTICE_MASTERY_TARGET,
} from "./practiceAnalysis.js";
import {
  answersMatchQuestion,
  normalizeAnswer,
  shuffleMainQuizQuestions,
} from "./mainQuizAdaptive.js";
import { savedLessonChunks } from "./mainQuizService.js";
import {
  DUPLICATE_QUIZ_QUESTION,
  validateKnownAnswerKey,
  validateQuizUniqueness,
} from "./quizValidation.js";

const QUESTION_COUNT = 10;
const MAX_STALLED_REPAIR_ROUNDS = 3;
const MAX_OPENAI_VALIDATION_REPAIR_ROUNDS = 2;
export const PRACTICE_GENERATION_TIMEOUT_MS = 240_000;
const MASTERY_TARGET = PRACTICE_MASTERY_TARGET;
const RECAP_LIMIT = 5;
const PROMPT_HISTORY_LIMIT = RECAP_LIMIT + 2 * QUESTION_COUNT;
const practiceModes = new Set([
  "flashcard",
  "qna",
  "multiple",
  "matching",
  "timed",
  "mixed",
]);
const mixedPracticeTypes = [
  ...Array(6).fill("multiple_choice"),
  "true_false",
  "identification",
  "true_false",
  "identification",
];
const starting = new Map();
const generationMessages = {
  [DUPLICATE_QUIZ_QUESTION]:
    "A generated question repeated an earlier question.",
  QUIZ_EVIDENCE_INVALID:
    "A generated question could not be linked to a passage in this lesson.",
  QUIZ_REVIEW_REJECTED:
    "A generated question or its answer did not pass the lesson evidence check.",
  QUIZ_REVIEW_INCOMPLETE: "The review did not verify every generated answer.",
  QUIZ_FOCUS_MISMATCH:
    "A generated question missed the review topic assigned from your earlier answers.",
  QUIZ_QUESTION_FORMAT:
    "A generated question did not meet the required question or answer format.",
  INVALID_ANSWER_KEY: "A generated answer key conflicted with its question.",
  GENERATION_TIMEOUT: "The question generator took too long to respond.",
  GENERATION_INCOMPLETE: "The question generator stopped before finishing its response.",
  GENERATION_INVALID_OUTPUT: "The question generator returned a response that could not be read.",
};

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
    const labeledAnswer = /^\s*[a-z][.)]\s+(.+)$/i.exec(String(rawKey ?? ""));
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
        concept: item.concept || item.subtopic,
        userAnswer:
          submitted.find(
            (answer) => answer.question.trim() === item.question.trim(),
          )?.userAnswer || "",
        correctAnswer: key,
        explanation: item.explanation || "",
        isCorrect: answersMatchQuestion(submittedAnswer, {
          ...item,
          correct_answer: key,
        }),
      },
    ];
  });
}

async function generatePracticeBatch(options, generateBatch) {
  const { types, skills, practiceFocus, requestOptions } = options;
  const provider = generateBatch ? undefined : createPracticeJsonGenerator();
  const generate = generateBatch ?? ((batch) => generateQuizBatch(batch, provider));
  const draftAndReviewMs = 2 * requestOptions.timeoutMs;
  const allIndexes = [...types.keys()];
  const approved = new Map();
  const rejected = new Map();
  const generationId = randomUUID();
  let round = 0;
  let stalledRounds = 0;
  let lastFailure;
  const timings = { initialGenerationMs: 0, reviewMs: 0, repairMs: 0 };
  const log = (details) => console.info("[Practice validation]", JSON.stringify({
    generationId, jobId: options.jobId, round, passed: approved.size, total: types.length, ...details,
  }));

  async function runRequest(phase, send, request) {
    const remainingMs = remainingTime(request);
    const started = Date.now();
    const timing = phase === "review" ? "reviewMs" : round === 0 ? "initialGenerationMs" : "repairMs";
    // A draft, including transport retries and availability fallback, must leave
    // its own independent review a full call, or half of a shorter job window.
    const reviewReserveMs = phase === "draft" ? Math.min(request.timeoutMs, Math.floor(remainingMs / 2)) : 0;
    const phaseRequest = reviewReserveMs ? withEarlierDeadline(request, request.deadlineAt - reviewReserveMs) : request;
    try {
      const result = await send(phaseRequest, {
        validationReserveMs: draftAndReviewMs,
        repairing: round > 0,
      });
      remainingTime(phaseRequest);
      return result;
    } finally {
      timings[timing] += Date.now() - started;
    }
  }

  function approve(index, question) {
    approved.set(index, question);
    rejected.delete(index);
  }

  async function prepare(indexes) {
    remainingTime(requestOptions);
    const retainedStems = [...approved.values()].map((item) => item.question);
    const previousQuestions = [...options.previousQuestions, ...retainedStems];
    const feedback = indexes.flatMap((index) => {
      const failure = rejected.get(index);
      return failure ? [{ question_number: index + 1, ...failure.feedback }] : [];
    });
    try {
      const batch = await generate({
        ...options,
        types: indexes.map((i) => types[i]),
        skills: indexes.map((i) => skills[i]),
        practiceSlotIndexes: indexes,
        practiceTargets: indexes.map((i) => rejected.get(i)?.targets || {}),
        practiceFocus: selectPracticeFocus(practiceFocus, indexes),
        initialCorrection: feedback
          .map(({ question_number, reason }) => `Slot ${question_number}: ${reason}`)
          .join("\n"),
        repairFeedback: feedback,
        previousQuestions,
        promptPreviousQuestions: [...options.promptPreviousQuestions, ...retainedStems],
        onValidated: (questions) => validateQuizUniqueness(questions, previousQuestions, { compareSharedSetup: true }),
        maxAttempts: 1,
        preserveValidated: true,
        runRequest,
      });
      remainingTime(requestOptions);
      if (!Array.isArray(batch) || batch.length !== indexes.length)
        throw requestError("The generator returned an incomplete question set.", 502);
      indexes.forEach((index, position) => approve(index, batch[position]));
    } catch (error) {
      remainingTime(requestOptions);
      if (error.statusCode !== 422 && error.code !== DUPLICATE_QUIZ_QUESTION) throw error;
      lastFailure = error;
      const passed = error.validatedQuestions || [];
      for (const { index, question } of passed)
        approve(indexes[index], question);
      const slotsByReason = Object.create(null);
      for (const [position, index] of indexes.entries()) {
        if (approved.has(index)) continue;
        const failure = error.rejectedSlots?.get(position) || error;
        const previous = rejected.get(index);
        rejected.set(index, {
          targets: { ...previous?.targets, ...failure.targets },
          feedback: { reason: failure.message, draft: failure.draft ?? previous?.feedback.draft },
        });
        // Free-text verdicts and drafts go only to the repair generator.
        const safeReason = failure.safeReason ||
          (Object.hasOwn(generationMessages, failure.code) ? failure.code : "QUIZ_QUESTION_FORMAT");
        (slotsByReason[safeReason] ??= []).push(index + 1);
      }
      log({ attempted: indexes.length, batchPassed: passed.length, rejected: slotsByReason });
      return;
    }
    log({ attempted: indexes.length, batchPassed: indexes.length });
  }

  const pendingSlots = () => allIndexes.filter((index) => !approved.has(index));

  async function repairInGroups() {
    while (approved.size < types.length && stalledRounds < MAX_STALLED_REPAIR_ROUNDS) {
      const before = approved.size;
      const pending = pendingSlots();
      for (let start = 0; start < pending.length; start += 5) {
        const remainingMs = remainingTime(requestOptions);
        if (provider?.canStartOpenAIValidationRepair()) {
          // Admit another Gemini batch only if both providers could still
          // finish a draft and review. Recheck even between sibling batches.
          if (remainingMs <= 2 * draftAndReviewMs) return "time_budget";
          if (stalledRounds > 0) return "no_progress";
        }
        if (start === 0) round++;
        try {
          await prepare(pending.slice(start, start + 5));
        } catch (error) {
          if (error.code !== "PRACTICE_REPAIR_WINDOW_ENDED") throw error;
          return "time_budget";
        }
      }
      stalledRounds = approved.size === before ? stalledRounds + 1 : 0;
    }
  }

  let validationStop = "no_progress";
  let stop = "all_slots_verified";
  try {
    await prepare(allIndexes);
    const handoff = await repairInGroups();
    if (handoff) {
      validationStop = "openai_repair_limit";
      for (let pass = 0; pass < MAX_OPENAI_VALIDATION_REPAIR_ROUNDS && approved.size < types.length; pass++) {
        const remainingMs = remainingTime(requestOptions);
        if (remainingMs < 2 * MIN_OPENAI_REQUEST_MS) {
          validationStop = "insufficient_repair_time";
          throw lastFailure;
        }
        if (pass === 0) {
          if (!provider.startOpenAIValidationRepair(requestOptions)) throw lastFailure;
          log({
            event: "openai_validation_repair", reason: handoff, remainingMs,
            reservedMs: Math.min(remainingMs, draftAndReviewMs),
            stalledRounds, maxRounds: MAX_OPENAI_VALIDATION_REPAIR_ROUNDS,
          });
        }
        round++;
        // The reservation covers one pair of calls for all remaining gaps.
        await prepare(pendingSlots());
      }
    }
    if (approved.size < types.length) throw lastFailure;
  } catch (error) {
    stop = "generation_error";
    if (error.code === "GENERATION_TIMEOUT") {
      if (Date.now() >= requestOptions.deadlineAt) stop = "deadline";
      else stop = requestOptions.signal.aborted ? "cancelled" : "insufficient_request_time";
    } else if (error === lastFailure) stop = validationStop;
    else if (error.statusCode === 503) stop = "provider_unavailable";
    else if (error.statusCode === 502) stop = "invalid_provider_response";
    throw error;
  } finally {
    log({ event: "summary", ...timings, approvedCount: approved.size, rejectedCount: rejected.size,
      remainingMs: Math.max(0, requestOptions.deadlineAt - Date.now()), stop, stalledRounds });
  }
  return allIndexes.map((index) => approved.get(index));
}

export async function generatePracticeQuestions(
  module,
  performance,
  previousQuestions,
  { format = "mixed", generateBatch, history = [], isRepeatPractice = false, signal: jobSignal, deadlineAt: jobDeadline, jobId } = {},
) {
  const now = Date.now();
  const deadlineAt = Math.min(jobDeadline ?? Infinity, now + PRACTICE_GENERATION_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(Math.max(0, deadlineAt - now));
  const signal = jobSignal ? AbortSignal.any([jobSignal, timeout]) : timeout;
  const shortAnswer = format === "qna";
  const types = shortAnswer
    ? Array(QUESTION_COUNT).fill("identification")
    : mixedPracticeTypes;
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
  // Keep a steady baseline at 60% and above; adapt through missed concepts.
  const difficulty = accuracy < 0.6 ? "easy" : "medium";
  const weakTopics = analyzePractice(performance, history, module.title).filter(
    (group) => group.needsReview,
  );
  const misses = weakTopics.flatMap((group) =>
    group.misconceptions.slice(0, 3),
  );
  const related = new Map(
    weakTopics.map((group) => {
      const labels = [
        group.topic,
        ...group.misconceptions.map((miss) => miss.concept),
      ].map(normalizeAnswer);
      const words = [
        ...new Set(
          labels
            .flatMap((label) => label.split(/\W+/))
            .filter((word) => word.length >= 4),
        ),
      ];
      const ranked = chunks
        .map((chunk) => {
          const text = normalizeAnswer(
            `${chunk.source_filename} ${chunk.chunk_text}`,
          );
          return {
            chunk,
            score:
              labels.filter((label) => text.includes(label)).length * 4 +
              words.filter((word) => text.includes(word)).length,
          };
        })
        .sort((a, b) => b.score - a.score);
      return [
        group.topic,
        ranked
          .filter((item) => item.score > 0)
          .slice(0, 2)
          .map((item) => item.chunk),
      ];
    }),
  );
  // On a repeat attempt, one missed concept needs one required fresh check.
  // Leave the other slots open to the lesson instead of requiring six variants.
  const missedConcepts = new Set(weakTopics.flatMap(({ misconceptions }) =>
    misconceptions.map(({ concept }) => normalizeAnswer(concept)),
  ));
  const focusLimit = isRepeatPractice && missedConcepts.size === 1 ? 1 : 6;
  const allocation = weakTopics
    .slice(0, focusLimit)
    .map((group) => ({ ...group, count: 1 }));
  for (
    let remaining = focusLimit - allocation.length;
    allocation.length && remaining > 0;
    remaining--
  ) {
    const next = [...allocation].sort(
      (a, b) => b.priority / (b.count + 1) - a.priority / (a.count + 1),
    )[0];
    next.count++;
  }
  const targets = allocation.flatMap((group) =>
    Array(group.count).fill(group.topic),
  );
  const concepts = allocation.flatMap((group) =>
    Array.from(
      { length: group.count },
      (_, index) =>
        group.misconceptions[index % group.misconceptions.length]?.concept ||
        group.topic,
    ),
  );
  const focusSkills =
    difficulty === "easy" ? ["HOTS", "LOTS", "LOTS"] : ["HOTS", "HOTS", "LOTS"];
  const skills = [...focusSkills, ...focusSkills, ...Array(4).fill("LOTS")];
  const hotsCount = skills.filter((skill) => skill === "HOTS").length;
  const distribution = {
    questionCount: QUESTION_COUNT,
    multipleChoiceCount: shortAnswer ? 0 : 6,
    trueFalseCount: shortAnswer ? 0 : 2,
    identificationCount: shortAnswer ? QUESTION_COUNT : 2,
    hotsCount,
    lotsCount: QUESTION_COUNT - hotsCount,
  };
  // The server checks the full available history. The model sees the recap and
  // a recent sample so it can revisit a weak topic with a different question.
  const promptPreviousQuestions = previousQuestions.slice(
    0,
    PROMPT_HISTORY_LIMIT,
  );
  const spread = [0, Math.floor(chunks.length / 2)].flatMap((start) =>
    Array.from(
      { length: Math.min(chunks.length, 4) },
      (_, offset) => chunks[(start + offset) % chunks.length],
    ),
  );
  const focusedChunks = targets.flatMap((topic) => related.get(topic) || []);
  // Draft and independently review all ten slots before repairing any gaps.
  const questions = await generatePracticeBatch(
    {
      types,
      chunks: [...new Set([...spread, ...focusedChunks])],
      title: module.title,
      objectives: module.learningObjectives,
      difficulty,
      skills,
      distribution,
      shortAnswer,
      jobId,
      requestOptions: {
        signal,
        deadlineAt,
        timeoutMs: 45000,
        maxAttempts: 3,
      },
      previousQuestions,
      promptPreviousQuestions,
      practiceFocus: misses.length
        ? {
            target_count: targets.length,
            target_topics: targets,
            target_concepts: concepts,
            missed_concepts: misses,
          }
        : undefined,
    },
    generateBatch,
  );

  if (questions.length !== QUESTION_COUNT)
    throw requestError(
      `Practice did not generate ${QUESTION_COUNT} questions. Please try again.`,
      502,
    );
  validateQuizUniqueness(questions, previousQuestions, { compareSharedSetup: true });
  return shuffleMainQuizQuestions(questions).map((question, index) => ({
    ...question,
    id: index + 1,
  }));
}

function attemptQuestions(row) {
  // Apply the current limit when resuming an unfinished older practice set.
  return JSON.parse(row.questions_json).slice(0, QUESTION_COUNT);
}

function hasValidSavedKeys(row) {
  try {
    attemptQuestions(row).forEach(validateKnownAnswerKey);
    return true;
  } catch {
    return false;
  }
}

function publicAttempt(row, mode) {
  return {
    id: row.attempt_id,
    questions: attemptQuestions(row).map(
      ({
        id,
        question,
        type,
        options,
        topic,
        concept,
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
        concept,
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

export async function modulePracticeScope(user, body) {
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
  return { courseId, module, mode, format };
}

export async function startModulePractice(
  user,
  body,
  generate = generatePracticeQuestions,
  { signal, deadlineAt, jobId } = {},
) {
  const { courseId, module, mode, format } = await modulePracticeScope(
    user,
    body,
  );
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
    const unfinished = previousInFormat && !previousInFormat.result_json;
    if (
      unfinished &&
      attemptQuestions(previousInFormat).length === QUESTION_COUNT &&
      hasValidSavedKeys(previousInFormat)
    )
      return previousInFormat;

    const history = await loadPracticeHistory(scope, db);
    let coursePerformance = null;
    if (!history.length && module.practiceModuleIds) {
      // The first course-wide set uses the latest completed practice per module.
      const moduleHistory = await Promise.all(
        module.practiceModuleIds.map((id) =>
          loadPracticeHistory([user.userId, courseId, id], db),
        ),
      );
      history.push(
        ...moduleHistory.flatMap((attempts) => attempts.slice(0, 1)),
      );
      coursePerformance = history.flatMap((attempt) => attempt.answers);
    }
    const latestCompleted = history[0];

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
      ? coursePerformance || latestCompleted.answers
      : recapPerformance(recap, body.recapAnswers);
    const previousQuestions = [
      ...new Set([
        ...recap.map((item) => item.question),
        ...(previousInFormat
          ? JSON.parse(previousInFormat.questions_json)
          : []
        ).map((item) => item.question),
        ...history.flatMap((attempt) =>
          attempt.questions.map((item) => item.question),
        ),
      ]),
    ];
    let questions;
    try {
      questions = await generate(module, performance, previousQuestions, {
        format,
        history: history.slice(1),
        isRepeatPractice: Boolean(latestCompleted),
        signal,
        deadlineAt,
        jobId,
      });
      if (!Array.isArray(questions) || questions.length !== QUESTION_COUNT)
        throw requestError(
          `Practice requires ${QUESTION_COUNT} questions.`,
          502,
        );
    } catch (error) {
      if (error.statusCode === 409) throw error;
      console.error("Module Practice generation failed:", error.code || error.statusCode || "GENERATION_ERROR");
      const reason =
        generationMessages[error.code] ||
        (error.statusCode === 422
          ? "The generated questions did not pass validation for this lesson."
          : error.statusCode === 503
            ? "The question generator is temporarily unavailable."
            : "");
      const publicError = requestError(
        reason
          ? `${reason} Please try again.`
          : `We couldn't prepare ${QUESTION_COUNT} practice questions. Please try again.`,
        error.statusCode || 500,
      );
      if (error.statusCode === 422)
        publicError.code = "PRACTICE_VALIDATION_FAILED";
      publicError.cause = error;
      throw publicError;
    }
    signal?.throwIfAborted();
    let attemptId;
    if (unfinished) {
      // Repair an incomplete saved set without creating a completed attempt or
      // overwriting a set that another request has already repaired/submitted.
      await db.execute(
        `UPDATE module_practice_attempts SET questions_json=?
         WHERE attempt_id=? AND result_json IS NULL AND questions_json=?`,
        [
          JSON.stringify(questions),
          previousInFormat.attempt_id,
          previousInFormat.questions_json,
        ],
      );
      attemptId = previousInFormat.attempt_id;
    } else {
      const [insert] = await db.execute(
        `INSERT INTO module_practice_attempts (user_id, course_id, module_id, question_format, previous_attempt_id, questions_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course_id, module_id, question_format, previous_attempt_id)
       DO UPDATE SET previous_attempt_id = EXCLUDED.previous_attempt_id`,
        [
          ...formatScope,
          previousInFormat?.attempt_id ?? 0,
          JSON.stringify(questions),
        ],
      );
      attemptId = insert.insertId;
    }
    const [[attempt]] = await db.execute(
      "SELECT attempt_id, questions_json, result_json FROM module_practice_attempts WHERE attempt_id=?",
      [attemptId],
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
    throw requestError(
      `Submit one answer for each of the ${QUESTION_COUNT} questions.`,
      400,
    );

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
      concept: question.concept || "",
      subtopic: question.subtopic || "",
      type: question.type,
      isSelfAssessed: mode === "flashcard",
      cognitive_level: question.cognitive_level,
      thinking_skill: question.thinking_skill,
      isCorrect:
        mode === "flashcard"
          ? userAnswer === "easy" || userAnswer === "good"
          : Boolean(userAnswer) && answersMatchQuestion(userAnswer, question),
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
  const completedCount = async () => {
    const [[row]] = await connection.execute(
      `SELECT COUNT(*) AS attempts FROM module_practice_attempts
       WHERE user_id = ? AND course_id = ? AND module_id = ? AND result_json IS NOT NULL`,
      [user.userId, attempt.course_id, String(module.id)],
    );
    return Number(row.attempts);
  };
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
      if (
        !Array.isArray(result.feedback) ||
        !result.feedback.length ||
        result.feedback.some(
          (feedback) => feedback?.feedbackVersion !== PRACTICE_FEEDBACK_VERSION,
        )
      ) {
        const history = await loadPracticeHistory(
          [user.userId, attempt.course_id, String(module.id)],
          connection,
          attemptId,
        );
        result.feedback = buildPracticeFeedback(result.answers, history, {
          contentTitle: module.title,
          quizMode: result.assessmentBasis === "self_assessment" ? "flashcard" : result.feedback?.[0]?.quizType || body.mode || "mixed",
          questionCount: result.total,
          masteryTarget: result.masteryTarget,
        });
      }
      result.attempts = await completedCount();
      await connection.commit();
      return result;
    }

    const mode = getPracticeMode(body.mode);
    if (!hasValidSavedKeys(row))
      throw Object.assign(
        requestError(
          "This practice contains an inconsistent answer key. Return to the course and start practice again to prepare a validated set.",
          409,
        ),
        { code: "PRACTICE_KEY_INVALID" },
      );
    const gradingMode = row.question_format === "qna" ? "qna" : mode;
    const result = gradeAttempt(
      attemptId,
      attemptQuestions(row),
      body.answers,
      gradingMode,
    );
    const history = await loadPracticeHistory(
      [user.userId, attempt.course_id, String(module.id)],
      connection,
      attemptId,
    );
    result.assessmentBasis =
      gradingMode === "flashcard" ? "self_assessment" : "graded_answers";
    result.feedback = buildPracticeFeedback(result.answers, history, {
      contentTitle: module.title,
      quizMode: gradingMode || "mixed",
      questionCount: result.total,
      masteryTarget: result.masteryTarget,
    });
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
    result.attempts = await completedCount();
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
