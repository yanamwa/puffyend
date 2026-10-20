const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const display = (value) => escape(value).replace(/\r?\n/g, "<br>");

export function renderQuizResultEmail(result) {
  const card =
    "background:#ffffff;border:1px solid #d7e2ef;border-radius:10px;padding:24px;margin-bottom:16px;";
  const label = "font-size:12px;color:#7286a1;";
  const questions = result.answers
    .map((raw, index) => {
      const answer =
        raw && typeof raw === "object" ? raw : { selected_answer: raw };
      const selected =
        answer.selected_answer ??
        answer.selectedAnswer ??
        answer.user_answer ??
        answer.userAnswer ??
        answer.response ??
        answer.answer ??
        "";
      const correct =
        answer.correct_answer ??
        answer.correctAnswer ??
        answer.correct_response ??
        "";
      const normalize = (value) => String(value).trim().toLowerCase();
      const flag = answer.is_correct ?? answer.isCorrect;
      const isCorrect = [true, 1, "true"].includes(flag)
        ? true
        : [false, 0, "false"].includes(flag)
          ? false
          : String(selected).trim() && String(correct).trim()
            ? normalize(selected) === normalize(correct)
            : null;
      const badge =
        isCorrect === true
          ? ["#e6f5ed", "#087b58", "✓ Correct"]
          : isCorrect === false
            ? ["#fff0ee", "#b23c36", "✕ Incorrect"]
            : ["#edf2f8", "#60738d", "Not graded"];
      const options = Array.isArray(answer.options)
        ? answer.options
            .map((option) => {
              const chosen = normalize(option) === normalize(selected);
              const right = normalize(option) === normalize(correct);
              return `<tr><td style="padding:12px;background:${chosen ? (isCorrect === false ? "#fff0ee" : "#e6f5ed") : "#ffffff"};border-radius:6px;">${chosen ? "◉" : "○"}&nbsp; ${display(option)}${chosen ? '<span style="color:#7286a1;font-size:12px;"> &nbsp; · Student answer</span>' : right ? '<span style="color:#087b58;font-size:12px;"> &nbsp; · Correct answer</span>' : ""}</td></tr>`;
            })
            .join("")
        : "";
      return `<tr><td style="padding:0 0 16px;"><div style="${card}">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="${label}">QUESTION ${index + 1}</td><td align="right"><span style="display:inline-block;padding:6px 10px;border-radius:20px;background:${badge[0]};color:${badge[1]};font-size:12px;">${badge[2]}</span></td></tr></table>
      <div style="border-top:1px solid #d7e2ef;margin:16px 0;"></div>
      <p style="font-weight:600;margin:0 0 18px;">${display(answer.question || answer.prompt || `Question ${index + 1}`)}</p>
      ${options ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">${options}</table>` : ""}
      <p style="margin:12px 0;"><strong>Student answer:</strong> ${display(String(selected).trim() ? selected : "No answer")}</p>
      <div style="background:#f5f8fc;border-left:3px solid #a7c3e5;border-radius:6px;padding:16px;"><strong>Correct answer:</strong> ${display(String(correct).trim() ? correct : "Not recorded")}${answer.explanation ? `<p style="margin:12px 0 0;">${display(answer.explanation)}</p>` : ""}</div>
    </div></td></tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Main Quiz results</title></head>
  <body style="margin:0;padding:0;background:#f3f6fa;font-family:Arial,Helvetica,sans-serif;color:#294568;font-size:14px;line-height:1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6fa;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;text-align:left;">
  <tr><td style="padding:0 4px 16px;font-size:18px;font-weight:bold;color:#608ab8;">PuffyBrain</td></tr>
  <tr><td><div style="${card}background:#f7f9fc;">
  <span style="display:inline-block;background:#eaf2ff;color:#3f76b2;padding:4px 10px;border-radius:6px;font-size:12px;">${escape(result.score)} of ${escape(result.total)} points</span>
  <div style="border-top:1px solid #d7e2ef;margin:18px 0;"></div>
  <h1 style="font-size:24px;line-height:1.3;margin:0 0 8px;">${display(result.courseTitle)}</h1><p style="margin:0;color:#7286a1;">Main Quiz · Score &amp; answer key</p></div></td></tr>
  <tr><td><div style="${card}"><span style="${label}">STUDENT DETAILS</span><p style="font-size:17px;margin:10px 0 4px;">${display(result.studentName)}</p><p style="margin:0;color:#7286a1;overflow-wrap:anywhere;">${display(result.email)}</p></div></td></tr>
  ${questions}<tr><td style="padding:8px;color:#7286a1;font-size:12px;text-align:center;">Sent by PuffyBrain · Your individual quiz results and answer key</td></tr>
  </table></td></tr></table></body></html>`;
}
