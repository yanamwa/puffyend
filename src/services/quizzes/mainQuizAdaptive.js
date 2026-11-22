import { randomInt } from "node:crypto";

const LEVELS = [
  "Remember",
  "Understand",
  "Apply",
  "Analyze",
  "Evaluate",
  "Create",
];
export const normalizeAnswer = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

// Identification answers should not be marked wrong just because a learner
// uses capitalization, ending punctuation, or an optional leading "the".
const normalizeIdentificationAnswer = (value) =>
  normalizeAnswer(value)
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .replace(/^the\s+/u, "");

export function answersMatchQuestion(answer, question) {
  const candidates = [question?.correct_answer];
  if (question?.type === "identification") {
    for (const field of [
      "accepted_answers",
      "acceptedAnswers",
      "acceptable_answers",
      "acceptableAnswers",
      "answer_aliases",
      "answerAliases",
      "alternatives",
    ]) {
      const value = question[field];
      if (Array.isArray(value)) candidates.push(...value);
      else if (typeof value === "string")
        candidates.push(...value.split(/\r?\n/));
    }
  }
  const normalize =
    question?.type === "identification"
      ? normalizeIdentificationAnswer
      : normalizeAnswer;
  const normalizedAnswer = normalize(answer);
  if (!normalizedAnswer) return false;
  return candidates.some(
    (candidate) => normalize(candidate) === normalizedAnswer,
  );
}
export const skillForLevel = (level) =>
  LEVELS.indexOf(level) < 3 ? "LOTS" : "HOTS";
export function validateMainSettings(body) {
  const settings = {
    questionCount: Number(body.question_count),
    multipleChoiceCount: Number(body.multiple_choice_count),
    identificationCount: Number(body.identification_count),
    trueFalseCount: Number(body.true_false_count),
    passingPercentage: Number(body.passing_percentage ?? 70),
  };
  if (
    !Number.isInteger(settings.questionCount) ||
    settings.questionCount < 1 ||
    settings.questionCount > 100
  )
    throw new Error("Choose 1–100 total questions.");
  if (
    ["multipleChoiceCount", "identificationCount", "trueFalseCount"].some(
      (key) => !Number.isInteger(settings[key]) || settings[key] < 0,
    ) ||
    settings.multipleChoiceCount +
      settings.identificationCount +
      settings.trueFalseCount !==
      settings.questionCount
  )
    throw new Error("Question type counts must equal the total.");
  if (
    !Number.isInteger(settings.passingPercentage) ||
    settings.passingPercentage < 1 ||
    settings.passingPercentage > 100
  )
    throw new Error("Passing percentage must be 1–100.");
  if (body.tos_slots != null) {
    const slots = body.tos_slots;
    const expected = { multiple_choice: settings.multipleChoiceCount, identification: settings.identificationCount, true_false: settings.trueFalseCount };
    if (!Array.isArray(slots) || slots.length !== settings.questionCount ||
      slots.some(s => !s || typeof s.topic !== "string" || !s.topic.trim() || s.topic.length > 100 ||
        !LEVELS.includes(s.cognitive_level) || !Object.hasOwn(expected, s.type) ||
        (s.learning_objective != null && (typeof s.learning_objective !== "string" || s.learning_objective.length > 500))) ||
      Object.entries(expected).some(([type, count]) => slots.filter(s => s.type === type).length !== count))
      throw new Error("TOS assignments must match every question type and the selected total.");
    settings.tosSlots = slots.map(s => ({ topic: s.topic.trim(), type: s.type, cognitive_level: s.cognitive_level,
      thinking_skill: skillForLevel(s.cognitive_level), ...(s.learning_objective?.trim() ? { learning_objective: s.learning_objective.trim() } : {}) }));
  }
  return settings;
}
function apportion(total, weights, minimum = 0) {
  if (minimum * weights.length > total)
    throw new Error(
      "Increase the question total to cover every required topic.",
    );
  const remaining = total - minimum * weights.length,
    sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (remaining * weight) / sum);
  const quotas = exact.map((value) => Math.floor(value) + minimum);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const leftover = total - quotas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < leftover; i++) quotas[order[i].index]++;
  return quotas;
}
export function calculateAdaptiveTos(
  settings,
  answers,
  { allowBaseline = false } = {},
) {
  const valid = answers.filter(
    (answer) =>
      typeof answer.topic === "string" &&
      answer.topic.trim() &&
      LEVELS.includes(answer.cognitive_level) &&
      [true, false, 0, 1, "true", "false"].includes(
        answer.isCorrect ?? answer.is_correct,
      ),
  );
  if ((!valid.length && !allowBaseline) || valid.length !== answers.length)
    throw new Error(
      "Complete a Practice Quiz with topic and cognitive metadata before taking Main Quiz.",
    );
  const correct = (answer) =>
    [true, 1, "true"].includes(answer.isCorrect ?? answer.is_correct);
  const group = (field) =>
    [...new Set(valid.map((answer) => answer[field].trim()))].map((label) => {
      const rows = valid.filter((answer) => answer[field].trim() === label);
      return {
        label,
        responses: rows.length,
        correct: rows.filter(correct).length,
        percent: (rows.filter(correct).length / rows.length) * 100,
      };
    });
  const lessonTitleKey = String(settings.lessonTitle || "")
    .trim()
    .toLocaleLowerCase();
  const configuredTopics = (settings.topics || []).filter(
    (topic) =>
      typeof topic === "string" &&
      topic.trim() &&
      topic.trim().toLocaleLowerCase() !== lessonTitleKey,
  );
  const observedTopics = group("topic").filter(
    (topic) => topic.label.toLocaleLowerCase() !== lessonTitleKey,
  );
  const topicNames = [
    ...new Set([
      ...configuredTopics.map((topic) => topic.trim()),
      ...(configuredTopics.length ? [] : observedTopics.map((topic) => topic.label)),
    ]),
  ];
  if (!topicNames.length) topicNames.push(settings.lessonTitle?.trim() || "General Concepts");
  const topics = topicNames.map(
    (label) =>
      observedTopics.find((topic) => topic.label === label) || {
        label,
        responses: 0,
        correct: 0,
        percent: null,
      },
  );
  const performance = {
    topics,
    levels: group("cognitive_level"),
    skills: ["LOTS", "HOTS"].map((label) => {
      const rows = valid.filter(
        (answer) => skillForLevel(answer.cognitive_level) === label,
      );
      return {
        label,
        responses: rows.length,
        percent: rows.length
          ? (rows.filter(correct).length / rows.length) * 100
          : null,
      };
    }),
  };
  const quotas = apportion(
    settings.questionCount,
    topics.map(topic => 1 + 2 * (topic.responses - topic.correct + 1) / (topic.responses + 2)),
    settings.questionCount >= topics.length ? 1 : 0,
  );
  // Baseline assesses both skills; weaker skill gains up to 10 percentage points without removing higher-order assessment.
  const low = performance.skills[0].percent ?? 50,
    high = performance.skills[1].percent ?? 50;
  const lotsCount =
    settings.questionCount === 1
      ? 1
      : Math.max(
          settings.questionCount >= 6 ? 3 : 1,
          Math.min(
            settings.questionCount - (settings.questionCount >= 6 ? 3 : 1),
            Math.round(settings.questionCount * (0.5 + (high - low) / 1000)),
          ),
        );
  const levelQuotas = [
    ...apportion(lotsCount, [1, 1, 1]),
    ...apportion(settings.questionCount - lotsCount, [1, 1, 1]),
  ];
  const slots = [];
  const remaining = levelQuotas.slice();
  topics.forEach((topic, index) => {
    for (let n = 0; n < quotas[index]; n++) {
      const levelIndex = remaining.indexOf(Math.max(...remaining));
      remaining[levelIndex]--;
      slots.push({
        topic: topic.label,
        cognitive_level: LEVELS[levelIndex],
        thinking_skill: skillForLevel(LEVELS[levelIndex]),
      });
    }
  });
  const types = [
    ...Array(settings.multipleChoiceCount).fill("multiple_choice"),
    ...Array(settings.identificationCount).fill("identification"),
    ...Array(settings.trueFalseCount).fill("true_false"),
  ];
  slots.forEach((slot, index) => {
    slot.type = types[index];
  });
  const tosDistribution = topics.map((topic, index) => ({
    topic: topic.label,
    question_count: quotas[index],
    practice_percent: topic.percent,
    cognitive_levels: Object.fromEntries(
      LEVELS.map((level) => [
        level,
        slots.filter(
          (slot) =>
            slot.topic === topic.label && slot.cognitive_level === level,
        ).length,
      ]),
    ),
  }));
  return {
    mode: valid.length ? "adaptive" : "baseline",
    practicePerformance: performance,
    tosDistribution,
    slots,
    lotsCount,
    hotsCount: settings.questionCount - lotsCount,
  };
}

export function mainQuizBlueprint(settings, attempt) {
  let answers;
  try {
    answers =
      typeof attempt?.answers_json === "string"
        ? JSON.parse(attempt.answers_json)
        : attempt?.answers_json;
  } catch {
    answers = null;
  }
  const usable =
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.length === Number(attempt.total) &&
    answers.every(
      (answer) =>
        typeof answer.topic === "string" &&
        answer.topic.trim() &&
        LEVELS.includes(answer.cognitive_level) &&
        [true, false, 0, 1, "true", "false"].includes(
          answer.isCorrect ?? answer.is_correct,
        ),
    );
  return {
    blueprint: calculateAdaptiveTos(settings, usable ? answers : [], {
      allowBaseline: true,
    }),
    practiceAttemptId: usable ? attempt.attempts_id : 0,
  };
}

export function mainQuizFromHistory(settings, attempts, { preview = false } = {}) {
  let latest = 0;
  const answers = [], previous = new Set();
  for (const attempt of attempts) {
    let rows;
    try { rows = typeof attempt.answers_json === "string" ? JSON.parse(attempt.answers_json) : attempt.answers_json; } catch { continue; }
    if (!Array.isArray(rows) || rows.length !== Number(attempt.total)) continue;
    for (const row of rows) {
      if (typeof row?.question === "string") previous.add(row.question);
      if (!row?.isSelfAssessed && typeof row?.topic === "string" && row.topic.trim() && LEVELS.includes(row.cognitive_level) &&
          [true, false, 0, 1, "true", "false"].includes(row.isCorrect ?? row.is_correct)) {
        answers.push(row);
        latest ||= attempt.attempts_id;
      }
    }
  }
  const baseline = !preview && settings.baselineQuestions?.length ? settings.baselineQuestions : null;
  const fixed = baseline || settings.tosSlots;
  const blueprint = calculateAdaptiveTos(settings, answers, { allowBaseline: true });
  if (fixed?.length) {
    blueprint.slots = fixed.map(q => {
      const level = LEVELS.includes(q.cognitive_level) ? q.cognitive_level : "Understand";
      return { topic: q.topic || "General Concepts", type: q.type, cognitive_level: level, thinking_skill: skillForLevel(level),
        ...(q.learning_objective ? { learning_objective: q.learning_objective } : {}) };
    });
    blueprint.lotsCount = blueprint.slots.filter(s => s.thinking_skill === "LOTS").length;
    blueprint.hotsCount = blueprint.slots.length - blueprint.lotsCount;
    blueprint.tosDistribution = [...new Set(blueprint.slots.map(s => s.topic))].map(topic => {
      const rows = blueprint.slots.filter(s => s.topic === topic);
      return { topic, question_count: rows.length,
        practice_percent: blueprint.practicePerformance.topics.find(t => t.label === topic)?.percent ?? null,
        cognitive_levels: Object.fromEntries([...new Set(rows.map(s => s.cognitive_level))].map(level => [level, rows.filter(s => s.cognitive_level === level).length])) };
    });
  }
  for (const slot of blueprint.slots) {
    const counts = new Map();
    for (const answer of answers.filter(a => normalizeAnswer(a.topic) === normalizeAnswer(slot.topic))) {
      const objective = answer.learning_objective || answer.learningObjective;
      if (slot.learning_objective && objective && normalizeAnswer(slot.learning_objective) !== normalizeAnswer(objective)) continue;
      const concept = String(answer.concept || answer.subtopic || objective || "").trim();
      if (!concept) continue;
      const tally = counts.get(concept) || { correct: 0, total: 0 };
      tally.total++;
      if ([true, 1, "true"].includes(answer.isCorrect ?? answer.is_correct)) tally.correct++;
      counts.set(concept, tally);
    }
    const weak = [...counts].filter(([, t]) => t.total - t.correct >= 2 && t.correct / t.total < 0.7)
      .sort((a,b) => a[1].correct / a[1].total - b[1].correct / b[1].total);
    if (weak.length) slot.focus = weak[0][0];
  }
  return { blueprint, practiceAttemptId: latest || 0, previous: [...previous] };
}
function similar(a, b) {
  const x = new Set(normalizeAnswer(a).match(/[\p{L}\p{N}]+/gu) || []),
    y = new Set(normalizeAnswer(b).match(/[\p{L}\p{N}]+/gu) || []);
  const union = new Set([...x, ...y]);
  return union.size
    ? [...x].filter((word) => y.has(word)).length / union.size >= 0.85
    : true;
}
export function validateAdaptiveQuestions(questions, slots, previous = []) {
  if (questions.length !== slots.length)
    throw new Error("Wrong adaptive question count.");
  questions.forEach((question, index) => {
    const slot = slots[index];
    for (const field of ["topic", "type", "cognitive_level", "thinking_skill"])
      if (question[field] !== slot[field])
        throw new Error(
          `Question ${index + 1} does not match its TOS ${field}.`,
        );
    if (
      [...previous, ...questions.slice(0, index).map((q) => q.question)].some(
        (text) => similar(text, question.question),
      )
    )
      throw new Error(
        "Duplicate or near-duplicate of another Main or Practice question.",
      );
  });
  return questions;
}

export function shuffleMainQuizQuestions(questions, randomIndex = randomInt) {
  const shuffled = questions.map((question, index) => ({
    ...question,
    source_question_index: index,
  }));
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = randomIndex(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function gradeMainQuiz(questions, answers, passingPercentage) {
  if (
    !Array.isArray(answers) ||
    answers.length !== questions.length ||
    answers.some((answer) => typeof answer !== "string" || answer.length > 500)
  )
    throw new Error("Submit one answer per question.");
  const responses = questions.map((question, index) => ({
    ...question,
    selected_answer: answers[index],
    isCorrect: answersMatchQuestion(answers[index], question),
  }));
  const score = responses.filter((answer) => answer.isCorrect).length,
    total = questions.length,
    requiredCorrect = Math.ceil((total * passingPercentage) / 100);
  return {
    score,
    total,
    percent: (score / total) * 100,
    requiredCorrect,
    passed: score >= requiredCorrect,
    answers: responses,
  };
}
