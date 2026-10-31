import axios from "axios";

const quizResponseSchema = {
  type: "OBJECT",

  properties: {
    questions: {
      type: "ARRAY",

      items: {
        type: "OBJECT",

        properties: {
          type: {
            type: "STRING",
            enum: ["multiple_choice", "true_false"],
          },

          question: {
            type: "STRING",
          },

          options: {
            type: "ARRAY",
            items: {
              type: "STRING",
            },
          },

          correct_answer: {
            type: "STRING",
          },

          explanation: {
            type: "STRING",
          },
        },

        required: [
          "type",
          "question",
          "options",
          "correct_answer",
          "explanation",
        ],
      },
    },
  },

  required: ["questions"],
};

function createQuizPrompt({
  lessonTitle,
  lessonContent,
  learningObjectives,
  questionCount,
  trueFalseCount,
  difficulty,
}) {
  const multipleChoiceCount = questionCount - trueFalseCount;

  return `
You are an educational quiz generator.

Generate exactly ${questionCount} questions using only the supplied lesson
content and learning objectives.

Lesson title:
${lessonTitle || "Untitled lesson"}

Learning objectives:
${learningObjectives || "Not provided"}

Lesson content:
${lessonContent}

Requirements:

- Difficulty must be ${difficulty}.
- Generate exactly ${multipleChoiceCount} multiple-choice questions.
- Generate exactly ${trueFalseCount} true-or-false questions.
- Every question must be directly supported by the lesson.
- Avoid duplicate or nearly identical questions.
- Keep every question clear and grammatically correct.
- Keep explanations concise but educational.
- Do not refer to "the text above" or "the provided lesson."

Multiple-choice rules:

- Use exactly four options.
- Only one option may be correct.
- Return plain option text without A., B., C., or D. prefixes.
- Make incorrect options believable but clearly incorrect based on the lesson.

True-or-false rules:

- Use exactly ["True", "False"] as the options.
- The correct_answer must be exactly "True" or "False".

Difficulty guidance:

- easy: direct recall, definitions, and basic recognition.
- medium: understanding, comparison, application, and interpretation.
- hard: analysis, scenarios, reasoning, and relationships between concepts.

Return only the requested JSON object.
`.trim();
}

function cleanQuestion(question) {
  const type =
    question?.type === "true_false" ? "true_false" : "multiple_choice";

  let options = Array.isArray(question?.options)
    ? question.options
        .map((option) =>
          String(option || "")
            .replace(/^[A-D][.)]\s*/i, "")
            .trim(),
        )
        .filter(Boolean)
    : [];

  if (type === "true_false") {
    options = ["True", "False"];
  } else {
    options = options.slice(0, 4);

    while (options.length < 4) {
      options.push("");
    }
  }

  let correctAnswer = String(question?.correct_answer || "")
    .replace(/^[A-D][.)]\s*/i, "")
    .trim();

  if (type === "true_false" && !["True", "False"].includes(correctAnswer)) {
    correctAnswer = "";
  }

  return {
    type,
    question: String(question?.question || "").trim(),

    options,

    correct_answer: correctAnswer,

    explanation: String(question?.explanation || "").trim(),
  };
}

export async function generateQuizWithGemini({
  lessonTitle = "",
  lessonContent = "",
  learningObjectives = "",
  questionCount = 5,
  trueFalseCount = 0,
  difficulty = "medium",
}) {
  const apiKey = process.env.GEMINI_API_KEY;

  const model =
    process.env.GEMINI_QUIZ_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash";

  if (!apiKey) {
    const error = new Error(
      "GEMINI_API_KEY is missing from the backend .env file.",
    );

    error.statusCode = 500;
    throw error;
  }

  const prompt = createQuizPrompt({
    lessonTitle,
    lessonContent,
    learningObjectives,
    questionCount,
    trueFalseCount,
    difficulty,
  });

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: quizResponseSchema,
    },
  };

  const url =
    "https://generativelanguage.googleapis.com/" +
    `v1beta/models/${encodeURIComponent(model)}` +
    ":generateContent";

  let response;

  try {
    response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      timeout: 120_000,
    });
  } catch (error) {
    const status = error.response?.status;

    console.error(
      "Gemini quiz generation error:",
      error.response?.data || error.message,
    );

    let message = "Could not connect to the Gemini API.";

    if (status === 400) {
      message = "Gemini rejected the quiz request.";
    } else if (status === 401 || status === 403) {
      message = "The Gemini API key is invalid or unauthorized.";
    } else if (status === 429) {
      message =
        "The Gemini request limit has been reached. Please try again later.";
    } else if (status && status >= 500) {
      message = "Gemini is temporarily unavailable.";
    }

    const serviceError = new Error(message);

    serviceError.statusCode = status || 503;

    throw serviceError;
  }

  const output = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!output) {
    const error = new Error("Gemini returned no quiz content.");

    error.statusCode = 502;
    throw error;
  }

  const cleanedOutput = String(output)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleanedOutput);
  } catch {
    console.error("Invalid Gemini quiz JSON:", cleanedOutput);

    const error = new Error("Gemini returned invalid quiz data.");

    error.statusCode = 502;
    throw error;
  }

  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .map(cleanQuestion)
        .filter((question) => question.question && question.correct_answer)
        .slice(0, questionCount)
    : [];

  if (questions.length !== questionCount) {
    const error = new Error(
      `Gemini generated ${questions.length} valid questions instead of ${questionCount}. Please try again.`,
    );

    error.statusCode = 502;
    throw error;
  }

  return questions;
}
