export const DUPLICATE_QUIZ_QUESTION = "DUPLICATE_QUIZ_QUESTION";

// Conservative guard for direct ANSI-SPARC level questions. Complex questions
// about mappings/independence are left to the source-based grounding review.
// Reference: Teradata Database Design, ANSI/X3/SPARC Three Schema Architecture.
export function validateKnownAnswerKey(item) {
  const question = normalizeQuizText(item.question);
  if (
    !/\b(?:ansi|sparc|database|three.schema)\b/.test(question) ||
    !/\b(?:level|schema)\b/.test(question) ||
    /\b(?:not|except|independen\w*|mapping\w*|between|change\w*|separat\w*|affect\w*)\b/.test(
      question,
    )
  )
    return;
  const storage =
    /\b(?:physical (?:data )?storage|stored physically|storage (?:structure|media)|disk|file organi[sz]ation)\b/.test(
      question,
    );
  const views =
    /\b(?:(?:user|users|individual|application)(?:.specific)? views?|views? (?:of|for|seen by) (?:the )?(?:users?|applications?))\b/.test(
      question,
    );
  if (storage === views) return;
  const expected = storage ? "internal" : "external";
  const key = normalizeQuizText(item.correct_answer).match(
    /^(?:the )?(internal|external|conceptual)(?: (?:level|schema))?[.!]?$/,
  )?.[1];
  const claimed = question.match(
    /\b(internal|external|conceptual) (?:level|schema)\b/,
  )?.[1];
  if (
    (/^(?:which|what)\b/.test(question) && key && key !== expected) ||
    (item.type === "true_false" &&
      claimed &&
      normalizeQuizText(item.correct_answer) !== String(claimed === expected))
  ) {
    throw Object.assign(
      new Error(
        `Inconsistent ANSI-SPARC answer key: ${expected} level is required by this question.`,
      ),
      { code: "INVALID_ANSWER_KEY" },
    );
  }
}

function questionTokens(value) {
  return new Set(normalizeQuestion(value).match(/[\p{L}\p{N}+#]+/gu) || []);
}

function nearlyIdentical(first, second) {
  const a = questionTokens(first),
    b = questionTokens(second);
  if (Math.min(a.size, b.size) < 8) return false;
  // Preserve negation and contrasting level names rather than treating them as
  // harmless stop words. Short questions are assessed by the semantic reviewer.
  for (const word of ["not", "except", "internal", "external", "conceptual"])
    if (a.has(word) !== b.has(word)) return false;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / (a.size + b.size - intersection) >= 0.88;
}

function normalizeQuizText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeQuestion(value) {
  return normalizeQuizText(value)
    .replace(/^(?:question\s+\d+[:.)]|\d+[.)])\s+/, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function validateQuizUniqueness(questions, previousQuestions = []) {
  const seen = new Set(previousQuestions.map(normalizeQuestion));
  const stems = [...previousQuestions];
  for (const [index, item] of questions.entries()) {
    const question = normalizeQuestion(item.question);
    if (
      seen.has(question) ||
      stems.some((previous) => nearlyIdentical(previous, item.question))
    )
      throw Object.assign(
        new Error(`Duplicate quiz question at position ${index + 1}.`),
        { code: DUPLICATE_QUIZ_QUESTION },
      );
    seen.add(question);
    stems.push(item.question);
    if (item.type === "multiple_choice") {
      const options = item.options.map((option) =>
        normalizeQuizText(option.trim().replace(/^[A-D][.)]\s*/i, "")),
      );
      if (options.some((option) => !option) || new Set(options).size !== 4)
        throw new Error(
          `Question ${index + 1} needs four distinct nonempty options.`,
        );
    }
  }
  return questions;
}
