import test from "node:test";
import assert from "node:assert/strict";
import { extractAcademicCalendar } from "../../src/services/calendar/academicCalendarExtraction.js";
const event = {
  title: "Semestral break",
  description: "Classes resume after the break.",
  start_date: "2026-12-14",
  end_date: "2027-01-10",
};
test("image import keeps cross-year date ranges, descriptions, undated entries and removes duplicates", async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const result = await extractAcademicCalendar(
      { mime_type: "image/png", document: Buffer.from("test-image") },
      "2026-2027",
      async (url, body) => {
        assert.equal(
          body.contents[0].parts[1].inlineData.mimeType,
          "image/png",
        );
        assert.equal(
          body.contents[0].parts[1].inlineData.data,
          Buffer.from("test-image").toString("base64"),
        );
        assert.match(
          body.systemInstruction.parts[0].text,
          /untrusted evidence/,
        );
        return {
          data: {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: "CvSU Academic Calendar",
                        academic_year: "2026-2027",
                        events: [event, { ...event }],
                        undated: ["Graduation day — TBA"],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        };
      },
    );
    assert.deepEqual(result.events, [event]);
    assert.deepEqual(result.undated, ["Graduation day — TBA"]);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});
test("missing import configuration explains manual entry instead of inventing dates", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(extractAcademicCalendar({}), /Add dates manually/);
  } finally {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  }
});
