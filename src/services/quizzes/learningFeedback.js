// Explain learning gaps using saved lesson evidence, without inferring why a learner chose an answer.
export const LEARNING_FEEDBACK_VERSION = 2;

const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const normalize = (value) => clean(value).toLowerCase();
const list = (items) =>
  new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(items);
const shortTerm = (value) => {
  const text = clean(value).replace(/^[A-D][.)]\s*/i, "");
  return text &&
    text.length <= 90 &&
    text.split(" ").length <= 8 &&
    /\p{L}/u.test(text) &&
    !/[?!]/.test(text) &&
    !/^(?:true|false|yes|no|no answer|unanswered|wrong|incorrect|easy|good|hard|again|[A-D])[.!]?$/i.test(
      text,
    )
    ? text
    : "";
};

export function buildConceptReview(miss, fallbackTopic = "Module concepts") {
  const topic =
    clean(miss.concept || miss.subtopic || miss.topic) || fallbackTopic;
  const rawSelected = clean(miss.userAnswer || miss.selectedAnswer);
  const key = clean(miss.correctAnswer || miss.correct_answer || miss.answer);
  const selected = shortTerm(rawSelected);
  const expected = shortTerm(key);
  const comparison =
    selected && expected && normalize(selected) !== normalize(expected);
  const answered =
    rawSelected && !/^(?:no answer|unanswered)$/i.test(rawSelected);
  const savedExplanation = clean(miss.explanation).replace(
    /^You answered "[^"]*"; the saved correct answer is "[^"]*"\.\s*/i,
    "",
  );
  const evidence =
    savedExplanation &&
    ![normalize(miss.question), normalize(key)].includes(
      normalize(savedExplanation),
    )
      ? savedExplanation
      : "";
  const introduction = miss.isSelfAssessed
    ? "You marked this concept for more recall practice."
    : !answered
      ? "This question was left unanswered; it does not show which part was unclear."
      : comparison
        ? `Your answer suggests possible confusion between ${selected} and ${expected}.`
        : `Your response suggests that the defining features of ${topic} need more review.`;
  const explanation = `${introduction} ${evidence || `Revisit the lesson's definition and examples of ${topic}, paying attention to what distinguishes it from related concepts.`}`;
  const trueFalse =
    miss.type === "true_false" || /^(?:true|false)[.!]?$/i.test(key);
  const studyTip = miss.isSelfAssessed
    ? `Explain ${topic} without looking at the card, check the lesson, then answer a graded question to verify your understanding.`
    : comparison
      ? `Make a two-column comparison of ${selected} and ${expected}. Describe each concept's purpose and add an example from the lesson. Then classify a fresh example and explain your choice.`
      : trueFalse
        ? `Rewrite the statement about ${topic} in your own words. Identify the detail that makes it true or false, check the lesson, then evaluate a new statement.`
        : `Describe ${topic} in your own words and add an example from the lesson. Then explain how it applies to a different situation without looking at your notes.`;
  return { topic, explanation, studyTip, question: clean(miss.question) };
}

export function buildLearningPlan({
  topic,
  strongConcepts = [],
  currentWeakConcepts = [],
  weakConcepts = [],
  selfAssessed = false,
  hasCurrentAnswers = true,
  recurring = false,
  foundation = false,
  questionCount = 10,
}) {
  const strengths = strongConcepts.slice(0, 2);
  const currentGaps = currentWeakConcepts.slice(0, 3);
  const focus = list(weakConcepts.slice(0, 3)) || topic;
  const summary = [];
  if (selfAssessed) {
    summary.push(
      "Your card ratings identify concepts to revisit, but do not verify your understanding.",
    );
  } else {
    if (strengths.length)
      summary.push(
        `Your correct responses show understanding of ${list(strengths)} in this attempt.`,
      );
    if (currentGaps.length)
      summary.push(
        `Your responses suggest gaps in ${list(currentGaps)}. Focus on the defining features and differences between these concepts.`,
      );
    else if (weakConcepts.length)
      summary.push(
        `${hasCurrentAnswers ? "Your latest responses show progress, but earlier" : "Earlier"} mistakes suggest that ${focus} should be revisited to check consistency.`,
      );
    else
      summary.push(
        "No specific missed concepts were recorded for this topic in this attempt. Check your understanding with fresh examples.",
      );
  }
  const approach = selfAssessed
    ? `Review ${focus} using the lesson, then try graded practice to check your understanding beyond recall ratings.`
    : weakConcepts.length
      ? `Review ${focus} with ${foundation ? "simpler explanations" : "clear explanations"}. Compare related concepts using examples from the lesson, then explain a new example in your own words. Your next ${questionCount}-question practice should revisit these gaps with clearer wording and fresh examples.${recurring ? " Revisit recurring gaps over more than one practice session to check consistency." : ""}`
      : "Continue practicing with fresh examples at the same baseline difficulty. Explain the reasoning behind each answer and revisit any earlier weak topics that reappear.";
  return {
    recommendation: summary.join(" "),
    adaptiveRecommendation: approach,
    difficulty: selfAssessed
      ? "Recall Review"
      : foundation
        ? "Foundation Practice"
        : weakConcepts.length
          ? "Focused Practice"
          : "Steady Practice",
  };
}
