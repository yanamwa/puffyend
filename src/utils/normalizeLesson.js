export function normalizeTextValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (
          item !== null &&
          typeof item === "object"
        ) {
          return JSON.stringify(item);
        }

        return String(item ?? "").trim();
      })
      .filter(Boolean)
      .join("\n");
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return JSON.stringify(value);
  }

  return String(value ?? "").trim();
}

export function normalizeLessonPages(lessonPages) {
  if (!Array.isArray(lessonPages)) {
    return [];
  }

  return lessonPages
    .filter((page) => {
      return (
        page !== null &&
        typeof page === "object" &&
        !Array.isArray(page)
      );
    })
    .map((page) => ({
      title: normalizeTextValue(page.title),
      content: normalizeTextValue(page.content),
    }));
}

export function cleanJsonOutput(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}