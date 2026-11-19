import { answersMatchQuestion, normalizeAnswer } from "./mainQuizAdaptive.js";
import { validateKnownAnswerKey } from "./quizValidation.js";

export const PRACTICE_MASTERY_TARGET = 90;
export const PRACTICE_HISTORY_LIMIT = 20;
const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const percent = (correct, total) =>
  total ? Math.round((100 * correct) / total) : null;
const unique = (items) => [
  ...new Map(items.map((item) => [normalizeAnswer(item), item])).values(),
];

export function practiceTopic(answer, fallback = "Module concepts") {
  return clean(answer.topic || answer.category || answer.subject) || fallback;
}

export function practiceConcept(answer, fallback = "Module concepts") {
  const explicit = clean(answer.concept || answer.subtopic);
  if (explicit) return explicit;
  const key = clean(answer.correctAnswer || answer.correct_answer);
  return key &&
    key.length <= 90 &&
    key.split(" ").length <= 8 &&
    !/^(true|false|yes|no)[.!]?$/i.test(key)
    ? key
    : practiceTopic(answer, fallback);
}

export function isPracticeCorrect(answer) {
  if (typeof answer.isCorrect === "boolean") return answer.isCorrect;
  return answersMatchQuestion(answer.userAnswer || answer.selectedAnswer, {
    ...answer,
    correct_answer:
      answer.correctAnswer || answer.correct_answer || answer.answer,
  });
}

const isVerified = (answer) =>
  !answer.isSelfAssessed && answer.answerKeyValid !== false;

// Saved answers, rather than client supplied scores, are the evidence for history.
export async function loadPracticeHistory(
  scope,
  database,
  excludeAttemptId = null,
) {
  const [rows] = await database.execute(
    `SELECT attempt_id, questions_json, result_json FROM module_practice_attempts
     WHERE user_id=? AND course_id=? AND module_id=? AND result_json IS NOT NULL
       ${excludeAttemptId == null ? "" : "AND attempt_id <> ?"}
     ORDER BY completed_at DESC, attempt_id DESC LIMIT ${PRACTICE_HISTORY_LIMIT}`,
    [...scope, ...(excludeAttemptId == null ? [] : [excludeAttemptId])],
  );
  return rows.flatMap((row) => {
    try {
      const result = JSON.parse(row.result_json);
      const questions = JSON.parse(row.questions_json);
      const answers = (result.answers || []).map((answer, index) => {
        const legacyRating =
          /^(easy|good|hard|again)$/i.test(clean(answer.userAnswer)) &&
          normalizeAnswer(answer.userAnswer) !==
            normalizeAnswer(answer.correctAnswer);
        if (result.assessmentBasis === "self_assessment" || legacyRating)
          answer = { ...answer, isSelfAssessed: true };
        try {
          validateKnownAnswerKey(questions[index] || {});
        } catch {
          return { ...answer, answerKeyValid: false };
        }
        return answer;
      });
      return Array.isArray(result.answers)
        ? [{ ...result, answers, attemptId: row.attempt_id, questions }]
        : [];
    } catch {
      return [];
    }
  });
}

export function analyzePractice(
  answers,
  history = [],
  fallback = "Module concepts",
) {
  const topics = new Map();
  const get = (answer) => {
    const topic = practiceTopic(answer, fallback);
    const key = normalizeAnswer(topic);
    if (!topics.has(key))
      topics.set(key, {
        topic,
        questionIndexes: [],
        current: [],
        historical: [],
        missedAttempts: new Set(),
        observedAttempts: new Set(),
        gradedAttempts: new Set(),
      });
    return topics.get(key);
  };
  answers.forEach((answer, index) => {
    if (answer.answerKeyValid === false) return;
    const group = get(answer);
    group.current.push(answer);
    group.questionIndexes.push(index);
    group.observedAttempts.add("current");
    if (isVerified(answer)) group.gradedAttempts.add("current");
    if (!isPracticeCorrect(answer)) group.missedAttempts.add("current");
  });
  history.slice(0, PRACTICE_HISTORY_LIMIT - 1).forEach((attempt, index) => {
    for (const answer of attempt.answers || []) {
      // Flashcard ratings from older versions are not graded answers either.
      const rating = /^(easy|good|hard|again)$/i.test(clean(answer.userAnswer));
      if (
        !isVerified(answer) ||
        attempt.assessmentBasis === "self_assessment" ||
        (rating &&
          normalizeAnswer(answer.userAnswer) !==
            normalizeAnswer(answer.correctAnswer))
      )
        continue;
      const group = get(answer);
      group.historical.push(answer);
      group.observedAttempts.add(index);
      group.gradedAttempts.add(index);
      if (!isPracticeCorrect(answer)) group.missedAttempts.add(index);
    }
  });
  return [...topics.values()]
    .map((group) => {
      const verifiedCurrent = group.current.filter(isVerified);
      const all = [...verifiedCurrent, ...group.historical];
      const misses = group.current.filter(
        (answer) => !isPracticeCorrect(answer),
      );
      const historicalMisses = group.historical.filter(
        (answer) => !isPracticeCorrect(answer),
      );
      const latestCorrect = verifiedCurrent.filter(isPracticeCorrect).length;
      const historicalCorrect = all.filter(isPracticeCorrect).length;
      const latestAccuracy = percent(latestCorrect, verifiedCurrent.length);
      const historicalAccuracy = percent(historicalCorrect, all.length);
      const recurring =
        group.missedAttempts.size >= 2 &&
        (misses.length > 0 || historicalAccuracy < PRACTICE_MASTERY_TARGET);
      const needsReview =
        misses.length > 0 ||
        (historicalMisses.length > 0 &&
          historicalAccuracy < PRACTICE_MASTERY_TARGET);
      const evidence = [...misses, ...(needsReview ? historicalMisses : [])];
      const misconceptions = [
        ...new Map(
          evidence.map((answer) => [
            normalizeAnswer(`${answer.question}|${answer.userAnswer}`),
            {
              topic: group.topic,
              concept: practiceConcept(answer, group.topic),
              question: clean(answer.question),
              userAnswer: clean(answer.userAnswer || answer.selectedAnswer),
              correctAnswer: clean(
                answer.correctAnswer || answer.correct_answer || answer.answer,
              ),
              explanation: clean(answer.explanation),
              isSelfAssessed: Boolean(answer.isSelfAssessed),
            },
          ]),
        ).values(),
      ];
      return {
        ...group,
        latestAccuracy,
        historicalAccuracy,
        latestCorrect,
        latestTotal: verifiedCurrent.length,
        historicalCorrect,
        historicalTotal: all.length,
        recurring,
        needsReview,
        misconceptions,
        observedAttempts: group.observedAttempts.size,
        gradedAttempts: group.gradedAttempts.size,
        missedAttempts: group.missedAttempts.size,
        priority:
          (misses.length ? 4 : 0) +
          (recurring ? 4 : 0) +
          (historicalAccuracy === null ? 0 : (100 - historicalAccuracy) / 100) +
          Math.min(group.missedAttempts.size, 5),
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

function reviewExplanation(miss) {
  if (miss.isSelfAssessed)
    return `You rated this card as difficult. Review ${miss.concept}, then check it with a graded question.`;
  const correction = miss.correctAnswer
    ? `You answered "${miss.userAnswer || "No answer"}"; the saved correct answer is "${miss.correctAnswer}".`
    : `Review the unanswered concept in: ${miss.question}`;
  return `${correction}${miss.explanation ? ` ${miss.explanation}` : " Revisit the lesson explanation before trying a new example."}`;
}

export function buildPracticeFeedback(
  answers,
  history = [],
  {
    contentTitle = "Module concepts",
    quizMode = "mixed",
    questionCount = 10,
  } = {},
) {
  const analysis = analyzePractice(answers, history, contentTitle);
  const verified = answers.filter(isVerified);
  const score = verified.filter(isPracticeCorrect).length;
  const target = Math.ceil((questionCount * PRACTICE_MASTERY_TARGET) / 100);
  const currentAccuracy = verified.length ? score / verified.length : 0;
  const achievedTarget = currentAccuracy * 100 >= PRACTICE_MASTERY_TARGET;
  const nextScore = Math.min(
    target,
    Math.ceil(questionCount * Math.max(0.6, currentAccuracy + 0.1)),
  );
  const selfAssessed = answers.length > 0 && verified.length === 0;
  return analysis
    .filter((group) => group.current.length || group.needsReview)
    .map((group) => {
      const currentMisses = group.current.filter(
        (answer) => !isPracticeCorrect(answer),
      );
      const reviewTopics = [
        ...new Map(
          group.misconceptions.map((miss) => [
            normalizeAnswer(miss.concept),
            {
              topic: miss.concept,
              explanation: reviewExplanation(miss),
              question: miss.question,
            },
          ]),
        ).values(),
      ].slice(0, 3);
      // A correct answer is evidence of that response, not proof of full mastery.
      const concepts = new Map();
      for (const answer of group.current.filter(isVerified)) {
        const concept = practiceConcept(answer, group.topic);
        const key = normalizeAnswer(concept);
        if (!concepts.has(key))
          concepts.set(key, { concept, correct: 0, total: 0 });
        const record = concepts.get(key);
        record.total++;
        if (isPracticeCorrect(answer)) record.correct++;
      }
      const strengths = [...concepts.values()]
        .filter(
          (record) => record.correct === record.total && record.correct > 0,
        )
        .map(
          ({ concept, correct, total }) =>
            `${concept}: ${correct}/${total} correct in this attempt.`,
        )
        .slice(0, 2);
      const focus = unique(group.misconceptions.map((miss) => miss.concept))
        .slice(0, 3)
        .join(", ");
      const historyNote = group.recurring
        ? ` This topic was missed in ${group.missedAttempts} of ${group.observedAttempts} analyzed attempts.`
        : "";
      const recommendation = group.needsReview
        ? `Review ${focus || group.topic}. ${reviewTopics[0]?.explanation || "Compare your answers with the lesson."}${historyNote}`
        : `You answered ${group.latestCorrect}/${group.latestTotal} graded questions correctly in this topic. Check your understanding with new examples.`;
      const latest = group.latestAccuracy;
      const overallAccuracy = percent(
        answers.filter(isPracticeCorrect).length,
        answers.length,
      );
      const difficulty =
        overallAccuracy !== null && overallAccuracy < 60
          ? "Foundation"
          : "Steady practice";
      return {
        topic: group.topic,
        quizType: quizMode,
        questionIndexes: group.questionIndexes,
        // Kept for older clients; the displayed metric is explicitly latest accuracy.
        confidence: latest ?? 0,
        latestAccuracy: latest,
        metricLabel: selfAssessed
          ? "Self-assessed recall"
          : "Latest topic accuracy",
        selfAssessed,
        recallPercentage: selfAssessed
          ? percent(
              group.current.filter(isPracticeCorrect).length,
              group.current.length,
            )
          : null,
        historicalAccuracy: group.historicalAccuracy,
        historicalCorrect: group.historicalCorrect,
        historicalTotal: group.historicalTotal,
        analyzedAttempts: group.observedAttempts,
        gradedAttempts: group.gradedAttempts,
        latestCorrect: group.latestCorrect,
        latestTotal: group.latestTotal,
        recurring: group.recurring,
        missedAttempts: group.missedAttempts,
        understanding: selfAssessed
          ? "Check With Graded Practice"
          : latest === null
            ? "Earlier Topic to Recheck"
            : latest >= 80
              ? "Good Understanding"
              : latest >= 60
                ? "Developing Understanding"
                : "Needs More Practice",
        strengths,
        areasForImprovement: reviewTopics.map((review) => review.topic),
        suggestedReviewTopics: reviewTopics,
        misconceptions: group.misconceptions,
        recommendation,
        difficulty,
        adaptiveRecommendation: group.needsReview
          ? `The next 10-question practice will prioritize current mistakes and recurring weak topics, including ${focus || group.topic} where supported by the module, using clearer questions and different scenarios.${historyNote} Correct answers do not trigger harder questions.`
          : "The next practice will check other weak topics from recent attempts, if present, and review this topic with fresh examples at the same baseline difficulty.",
        nextGoal: selfAssessed
          ? `Complete a graded practice quiz and aim for ${target}/${questionCount} (${PRACTICE_MASTERY_TARGET}%). Flashcard ratings do not establish mastery.`
          : `${achievedTarget ? `Maintain at least ${target}` : `Aim for at least ${nextScore}`}/${questionCount} correct on the next practice quiz${!achievedTarget ? ` (current: ${score}/${verified.length})` : ""}. The mastery target is ${PRACTICE_MASTERY_TARGET}% (${target}/${questionCount}).${currentMisses.length || group.recurring ? ` Correctly answer a new question about ${focus || group.topic}.` : ""}`,
      };
    });
}
