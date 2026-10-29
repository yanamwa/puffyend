// Remove an inline activity section, stopping at the next paragraph/heading.
export function removeLessonPracticeActivities(value) {
  return String(value || "").replace(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Practice\s+Activit(?:y|ies)(?:\*\*)?[ \t]*:?(?:\*\*)?[^\n]*(?:\n(?![ \t]*\n|[ \t]*#{1,6}\s|[ \t]*(?:\*\*)?(?:Example|Lesson|Summary|Conclusion)\b)[^\n]*)*/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
