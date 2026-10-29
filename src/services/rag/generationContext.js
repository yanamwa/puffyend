export function generationContext(value) {
  if (!value) return null;
  let context;
  try { context = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw Object.assign(new Error("Invalid lesson coverage."), { statusCode: 400 }); }
  if (!context || typeof context !== "object" || Array.isArray(context))
    throw Object.assign(new Error("Invalid lesson coverage."), { statusCode: 400 });
  const result = {};
  for (const [key, limit] of [["module_title", 255], ["learning_objectives", 15000], ["instructions", 15000]]) {
    if (context[key] != null && (typeof context[key] !== "string" || context[key].length > limit))
      throw Object.assign(new Error("Lesson coverage is too long or invalid."), { statusCode: 400 });
    result[key] = (context[key] || "").trim();
  }
  const topics = context.topics || [];
  if (!Array.isArray(topics) || topics.length > 100 || topics.some(t => typeof t !== "string" || t.length > 500))
    throw Object.assign(new Error("Use at most 100 topics of 500 characters each."), { statusCode: 400 });
  result.topics = topics.map(t => t.trim()).filter(Boolean);
  return result;
}
