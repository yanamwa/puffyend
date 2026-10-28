export const normalizeCatalogCode = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toUpperCase();
export function catalogDetails(body) {
  const code = String(body.code || "")
    .trim()
    .replace(/\s+/g, " ");
  const title = String(body.title || "").trim();
  const normalizedCode = normalizeCatalogCode(code);
  const programs = [
    ...new Set(Array.isArray(body.programs) ? body.programs : []),
  ];
  const units =
    body.units === "" || body.units == null ? null : Number(body.units);
  if (!code || !title)
    throw Object.assign(new Error("Course code and title are required."), {
      statusCode: 400,
    });
  if (
    code.length > 50 ||
    normalizedCode.length > 50 ||
    !/^[A-Z0-9._/-]+$/.test(normalizedCode) ||
    title.length > 255
  )
    throw Object.assign(
      new Error(
        "Use a course code of up to 50 letters, numbers, spaces, dots, slashes, underscores or hyphens, and a title of up to 255 characters.",
      ),
      { statusCode: 400 },
    );
  if (programs.some((p) => !["BSIT", "BSCS"].includes(p)))
    throw Object.assign(
      new Error("Applicable programs must be BSIT or BSCS."),
      { statusCode: 400 },
    );
  if (units !== null && (!Number.isFinite(units) || units < 0 || units > 99))
    throw Object.assign(new Error("Credit units must be between 0 and 99."), {
      statusCode: 400,
    });
  const description = String(body.description || "").trim();
  if (description.length > 15000)
    throw Object.assign(new Error("Description is too long."), {
      statusCode: 400,
    });
  return { code, normalizedCode, title, description, units, programs };
}
// Labels may occupy separate table cells/lines and need not include a colon.
export function parseSyllabus(text) {
  const labels = {
    code: "course\\s+code|subject\\s+code",
    title: "course\\s+title|descriptive\\s+title|subject\\s+title",
    description: "course\\s+description|subject\\s+description",
    units: "credit\\s+units?|units?",
    academic_year:
      "academic\\s+year|school\\s+year|a\\.?\\s*y\\.?|s\\.?\\s*y\\.?",
    semester: "semester|term",
  };
  const boundary =
    Object.values(labels).join("|") +
    "|type|pre\\s*[-–]?\\s*requisites?|course\\s+schedule|core\\s+values|course\\s+outcomes|course\\s+coverage";
  const field = (key) => {
    const stop =
      key === "description"
        ? "pre\\s*[-–]?\\s*requisites?|course\\s+schedule|core\\s+values|course\\s+outcomes|course\\s+coverage"
        : boundary;
    const match = text.match(
      new RegExp(
        "\\b(?:" +
          labels[key] +
          ")\\b\\s*[:：–-]?\\s*([\\s\\S]*?)(?=\\b(?:" +
          stop +
          ")\\b|$)",
        "i",
      ),
    );
    return (match?.[1] || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[;,]+$/, "");
  };
  const code =
    field("code").match(/^[A-Z][A-Z0-9._/-]*(?:\s+[A-Z0-9._/-]+)*/i)?.[0] || "";
  const year =
    text.match(
      /\b(?:academic\s+year|school\s+year|a\.?\s*y\.?|s\.?\s*y\.?)\s*[:：,–-]?\s*(\d{4}\s*[-–/]\s*\d{4})/i,
    )?.[1] || "";
  const semester =
    text.match(
      /\b((?:\d+\s*(?:st|nd|rd|th)|first|second|third|summer)\s+semester)\b/i,
    )?.[1] || field("semester").split(/\n/)[0];
  return {
    code: code.slice(0, 50),
    title: field("title").slice(0, 255),
    description: field("description").slice(0, 15000),
    units: field("units").match(/^\d+(?:\.\d+)?\b/)?.[0] || "",
    programs: ["BSIT", "BSCS"].filter(
      (p) =>
        new RegExp("\\b" + p + "\\b", "i").test(text) ||
        (p === "BSIT"
          ? /\bBS\s+Information\s+Technology\b/i
          : /\bBS\s+Computer\s+Science\b/i
        ).test(text),
    ),
    academic_year: year.replace(/\s/g, ""),
    semester: semester.slice(0, 30),
  };
}

export function validateCoverageModules(value = []) {
  if (!Array.isArray(value) || value.length > 150)
    throw Object.assign(
      new Error("Course coverage must contain at most 150 module titles."),
      { statusCode: 400 },
    );
  return value.map((item) => {
    const title = String(item?.title || "").trim();
    const page = item?.source_page == null ? null : Number(item.source_page);
    if (
      !title ||
      title.length > 255 ||
      (page !== null && (!Number.isSafeInteger(page) || page < 1))
    )
      throw Object.assign(
        new Error(
          "Every coverage module needs a title of 1–255 characters and a valid source page.",
        ),
        { statusCode: 400 },
      );
    return { title, source_page: page };
  });
}
