const fail = (message) => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};
const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function calendarDetails(body) {
  const title = String(body.title || "").trim();
  const academic_year = String(body.academic_year || "").trim();
  if (!title || title.length > 200)
    fail("Enter a calendar title of up to 200 characters.");
  if (
    !/^\d{4}-\d{4}$/.test(academic_year) ||
    Number(academic_year.slice(5)) !== Number(academic_year.slice(0, 4)) + 1
  )
    fail("Enter consecutive academic years, such as 2026-2027.");
  let events;
  try {
    events =
      typeof body.events === "string" ? JSON.parse(body.events) : (body.events || []);
  } catch {
    fail("Invalid calendar events.");
  }
  if (!Array.isArray(events) || events.length > 200)
    fail("Add at most 200 calendar events.");
  events = events.map((event) => {
    if (!event || typeof event !== "object") fail("Invalid calendar event.");
    const title = String(event.title || "").trim();
    const start_date = String(event.start_date || "");
    const end_date = String(event.end_date || start_date);
    if (
      !title ||
      title.length > 200 ||
      !validDate(start_date) ||
      !validDate(end_date) ||
      end_date < start_date
    )
      fail("Each event needs a title and a valid date range.");
    const description = String(event.description || "").trim();
    if (description.length > 2000) fail("Event descriptions must be 2000 characters or fewer.");
    return { title, start_date, end_date, description };
  });
  if (![true, false, "true", "false"].includes(body.published))
    fail("Choose whether to publish the calendar.");
  return {
    title,
    academic_year,
    events,
    published: body.published === true || body.published === "true",
  };
}
export function calendarFile(file) {
  if (!file) fail("Upload an academic calendar PDF, PNG or JPEG.");
  const data = file.buffer;
  const pdf = data.subarray(0, 5).toString() === "%PDF-";
  const png = data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg =
    data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  const type = pdf
    ? "application/pdf"
    : png
      ? "image/png"
      : jpg
        ? "image/jpeg"
        : "";
  const extension = /\.([^.]+)$/.exec(file.originalname)?.[1]?.toLowerCase();
  if (
    !type ||
    !{
      "application/pdf": ["pdf"],
      "image/png": ["png"],
      "image/jpeg": ["jpg", "jpeg", "jpe"],
    }[type].includes(extension)
  )
    fail(
      "Only PDF, PNG and JPEG files matching their file type are supported.",
    );
  return {
    filename: file.originalname.replace(/^.*[\\/]/, "").slice(-255),
    mime_type: type,
    document: data,
  };
}
