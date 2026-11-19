// Build learner-facing feedback from the saved answers and lesson explanations.
export const LEARNING_FEEDBACK_VERSION = 4;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const key = (value) => clean(value).toLowerCase();
const list = (items) => new Intl.ListFormat("en").format(items);
const shortTerm = (value) => {
  const term = clean(value).replace(/^[A-D][.)]\s*/i, "");
  return term.length <= 90 && term.split(" ").length <= 8 && /\p{L}/u.test(term) &&
    !/[?!]/.test(term) && !/^(true|false|yes|no|no answer|unanswered|wrong|incorrect|easy|good|hard|again|[A-D])[.!]?$/i.test(term) ? term : "";
};

function mentions(text, term) {
  const words = (value) => key(value).match(/[\p{L}\p{N}+#]+/gu)?.join(" ") || "";
  const label = words(term);
  return Boolean(label && (" " + words(text) + " ").includes(" " + label + " "));
}

export function buildConceptReview(miss, fallbackTopic = "Module concepts", repeated = false) {
  const topic = clean(miss.concept || miss.subtopic || miss.topic) || fallbackTopic;
  const question = clean(miss.question);
  const answer = clean(miss.userAnswer || miss.selectedAnswer);
  const selected = shortTerm(answer);
  const expected = shortTerm(miss.correctAnswer || miss.correct_answer || miss.answer);
  const saved = clean(miss.explanation).replace(/^You answered "[^"]*"; the saved correct answer is "[^"]*"\.\s*/i, "");
  const evidence = saved && ![key(question), key(expected)].includes(key(saved)) ? saved : "";
  const unanswered = !answer || /^(no answer|unanswered)$/i.test(answer);
  const context = question + " " + evidence;
  const comparison = !miss.isSelfAssessed && !unanswered && selected && expected &&
    key(selected) !== key(expected) && mentions(context, selected) && mentions(context, expected);
  const level = key(miss.cognitive_level || miss.cognitiveLevel);
  const explanation = [
    unanswered && !miss.isSelfAssessed ? "This question was left unanswered." : "",
    evidence || "Revisit the lesson example for " + topic + " and identify the feature that explains the answer.",
  ].filter(Boolean).join(" ");
  let studyTip, selfCheck;
  if (miss.isSelfAssessed) {
    studyTip = "Cover the answer and recall " + topic + " aloud. Check which details you missed against the card.";
    selfCheck = "Can you explain " + topic + " from memory and then verify it with a graded question?";
  } else if (repeated) {
    studyTip = "Rework the missed example of " + topic + ". Choose a different example from the lesson and explain whether the same reasoning applies.";
    selfCheck = "What clue would help you recognize " + topic + " in a fresh example?";
  } else if (/\b(next step|first step|last step|sequence|in order|before|after which|which step|what step)\b/i.test(question)) {
    studyTip = "Write the steps involving " + topic + " in order. Mark the step the question asks about and check what must happen immediately before it.";
    selfCheck = "What would change if you skipped that step in the lesson example?";
  } else if (/^(analyze|evaluate|create)$/.test(level) || /\b(analy[sz]e|evaluate|justify|best explains|most likely cause)\b/i.test(question)) {
    studyTip = "Mark the details in the question that support the answer about " + topic + ". Explain which detail rules out another interpretation.";
    selfCheck = "Which detail is the strongest evidence for your conclusion about " + topic + "?";
  } else if (level === "apply" || /\b(scenario|suppose|in this situation|would you use|should .+ use)\b/i.test(question)) {
    studyTip = "Work through a practical example of " + topic + " from the lesson. Change one condition and decide whether your answer changes.";
    selfCheck = "When would you apply " + topic + ", and what feature of the situation tells you to use it?";
  } else if (comparison) {
    studyTip = "Compare " + selected + " with " + expected + ". Find a lesson example of each and name the detail that distinguishes them.";
    selfCheck = "Which feature points to " + expected + " in the original question?";
  } else if (miss.type === "true_false" || /^(true|false)$/i.test(clean(miss.correctAnswer))) {
    studyTip = "Underline the detail that makes the statement true or false. Rewrite the statement about " + topic + " so its truth value changes.";
    selfCheck = "Can you justify the revised statement using a line from the lesson?";
  } else {
    studyTip = "Explain " + topic + " in your own words and illustrate it with an example from the lesson. Then check the defining detail in your explanation.";
    selfCheck = "How would you recognize " + topic + " in another example?";
  }
  return {topic, question, explanation, studyTip, selfCheck};
}

// Keep one card per concept. Current misses take priority over earlier ones.
export function buildReviewCards(current, previous = []) {
  const byConcept = new Map();
  for (const miss of [...current, ...previous]) {
    const name = key(miss.concept || miss.topic);
    if (!name) continue;
    const entry = byConcept.get(name) || { miss, current: false, previous: false, attempts: new Set() };
    if (!entry.miss.explanation && miss.explanation) entry.miss = miss;
    if (miss.priorAttempt != null) entry.attempts.add(miss.priorAttempt);
    byConcept.set(name, entry);
  }
  for (const miss of current) {
    const entry = byConcept.get(key(miss.concept || miss.topic));
    if (entry) entry.current = true;
  }
  for (const miss of previous) {
    const entry = byConcept.get(key(miss.concept || miss.topic));
    if (entry) entry.previous = true;
  }
  return [...byConcept.values()].map((entry) => {
    const repeated = (entry.current && entry.previous && !entry.miss.isSelfAssessed) || entry.attempts.size > 1;
    return {...buildConceptReview(entry.miss, undefined, repeated), historicalOnly: !entry.current, repeated};
  }).sort((a,b) => Number(a.historicalOnly) - Number(b.historicalOnly) || Number(b.repeated) - Number(a.repeated));
}

export function buildLearningPlan({topic, reviews, latestTotal, latestCorrect, selfAssessed, recallPercentage, earlierMistakes, foundation}) {
  const current = reviews.filter((review) => !review.historicalOnly);
  const assessed = selfAssessed ? recallPercentage != null : latestTotal > 0;
  let understanding, recommendation;
  if (!assessed) {
    understanding = "Not Assessed";
    recommendation = "This attempt did not cover " + topic + ". Earlier graded answers provide the review context.";
  } else if (selfAssessed) {
    understanding = "Self-assessed Recall";
    recommendation = "Your card ratings describe how easily you recalled " + topic + ". A graded response can verify that understanding.";
  } else if (latestCorrect < latestTotal) {
    understanding = "Needs More Practice";
    recommendation = "You missed " + (latestTotal - latestCorrect) + " of the " + latestTotal + " most recent " + (latestTotal === 1 ? "question" : "questions") + " on " + topic + ".";
  } else if (earlierMistakes) {
    understanding = "Improving";
    recommendation = "You answered correctly on " + topic + " this time after earlier misses. Another example can confirm the improvement.";
  } else {
    understanding = latestTotal === 1 ? "Needs Verification" : "Demonstrated Understanding";
    recommendation = latestTotal === 1 ? "You answered one question correctly on " + topic + ". Try a different example to check consistency." : "You answered every question on " + topic + " correctly in this attempt.";
  }
  const focus = current.length ? current : reviews;
  const primary = focus[0];
  let adaptiveRecommendation;
  if (primary) {
    const reason = primary.repeated ? "it has come up in more than one attempt" : primary.historicalOnly ? "an earlier graded response missed it" : selfAssessed ? "you marked it for more recall practice" : "your latest response missed it";
    adaptiveRecommendation = "Start with " + primary.topic + " because " + reason + ".";
    if (focus.length > 1) adaptiveRecommendation += " Then revisit " + list(focus.slice(1, 3).map(r => r.topic)) + ".";
    const earlier = current.length && reviews.find(r => r.historicalOnly);
    if (earlier) adaptiveRecommendation += " Return to " + earlier.topic + " afterward to check the earlier difficulty.";
  } else if (earlierMistakes) {
    adaptiveRecommendation = "Revisit " + topic + " in a different lesson example to check whether the earlier difficulty has been resolved.";
  } else {
    adaptiveRecommendation = "Check " + topic + " in a different lesson example before moving on.";
  }
  return {understanding, recommendation, adaptiveRecommendation, difficulty: selfAssessed ? "Recall Review" : foundation && current.length ? "Foundation Practice" : reviews.length ? "Focused Practice" : "Reinforcement"};
}

export function buildNextGoal({score, total, masteryTarget}, topic, {selfAssessed, assessed = true} = {}) {
  if (selfAssessed) return "Answer a graded practice quiz question about " + topic + " without using the card.";
  if (!assessed) return "Check " + topic + " with a fresh graded question in a future attempt.";
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(score) || score < 0 || score > total || !Number.isFinite(masteryTarget) || masteryTarget <= 0 || masteryTarget > 100)
    return "Answer a new question about " + topic + " and support your answer with an example from the lesson.";
  const required = Math.ceil(total * masteryTarget / 100);
  const goal = Math.min(required, score + 1);
  return score >= required
    ? "Maintain at least " + required + "/" + total + " on a comparable graded quiz to meet the " + masteryTarget + "% target."
    : "Aim for " + goal + "/" + total + " on a comparable graded quiz, up from " + score + "/" + total + ". The " + masteryTarget + "% target requires " + required + "/" + total + ".";
}
