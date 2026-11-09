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
  for (const [index, item] of questions.entries()) {
    const question = normalizeQuestion(item.question);
    if (seen.has(question))
      throw new Error(`Duplicate quiz question at position ${index + 1}.`);
    seen.add(question);
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
