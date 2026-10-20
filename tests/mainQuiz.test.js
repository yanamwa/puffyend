import { db } from "../src/db.js";
import assert from "node:assert/strict";
import {
  validateMainSettings,
  calculateAdaptiveTos,
  validateAdaptiveQuestions,
  gradeMainQuiz,
} from "../src/services/mainQuizAdaptive.js";
import { createMainQuizPrompt } from "../src/services/mainQuizPrompt.js";
import { generateQuizBatch } from "../src/services/rag/quizRagService.js";
const settings = validateMainSettings({
  question_count: 20,
  multiple_choice_count: 10,
  identification_count: 5,
  true_false_count: 5,
  passing_percentage: 60,
  attempt_limit: 2,
});
for (const change of [
  { question_count: 0 },
  { multiple_choice_count: 9 },
  { passing_percentage: 101 },
])
  assert.throws(() =>
    validateMainSettings({
      question_count: 20,
      multiple_choice_count: 10,
      identification_count: 5,
      true_false_count: 5,
      ...change,
    }),
  );
const answers = [
  {
    question: "Define sunlight.",
    topic: "Light",
    cognitive_level: "Remember",
    isCorrect: true,
  },
  {
    question: "Explain food production.",
    topic: "Photosynthesis",
    cognitive_level: "Analyze",
    isCorrect: false,
  },
];
for (let count = 2; count <= 50; count++) {
  const blueprint = calculateAdaptiveTos(
    {
      ...settings,
      questionCount: count,
      multipleChoiceCount: count,
      identificationCount: 0,
      trueFalseCount: 0,
    },
    answers,
  );
  assert.equal(blueprint.slots.length, count);
  assert.equal(blueprint.lotsCount + blueprint.hotsCount, count);
  assert.equal(
    blueprint.slots.filter((slot) => slot.thinking_skill === "LOTS").length,
    blueprint.lotsCount,
  );
  assert.equal(
    blueprint.tosDistribution.reduce((sum, row) => sum + row.question_count, 0),
    count,
  );
  assert.ok(blueprint.tosDistribution.every((row) => row.question_count > 0));
  assert.ok(
    blueprint.tosDistribution.find((row) => row.topic === "Photosynthesis")
      .question_count >=
      blueprint.tosDistribution.find((row) => row.topic === "Light")
        .question_count,
  );
  if (count >= 6)
    assert.equal(
      new Set(blueprint.slots.map((slot) => slot.cognitive_level)).size,
      6,
    );
}
const shortQuiz = calculateAdaptiveTos(
  {
    ...settings,
    questionCount: 1,
    multipleChoiceCount: 1,
    identificationCount: 0,
    trueFalseCount: 0,
  },
  answers,
);
assert.equal(shortQuiz.slots.length, 1);
assert.equal(shortQuiz.slots[0].topic, "Photosynthesis");
assert.equal(shortQuiz.slots[0].type, "multiple_choice");
const shortBaseline = calculateAdaptiveTos(
  {
    ...settings,
    questionCount: 2,
    multipleChoiceCount: 2,
    identificationCount: 0,
    trueFalseCount: 0,
    topics: ["A", "B", "C", "D"],
  },
  [],
  { allowBaseline: true },
);
assert.equal(shortBaseline.slots.length, 2);
assert.equal(
  shortBaseline.tosDistribution.reduce(
    (sum, row) => sum + row.question_count,
    0,
  ),
  2,
);
assert.throws(() => calculateAdaptiveTos(settings, []));
const question = {
  question: "Plants produce food using sunlight.",
  type: "true_false",
  options: ["True", "False"],
  correct_answer: "True",
  explanation: "Sunlight supports photosynthesis.",
  topic: "Photosynthesis",
  cognitive_level: "Understand",
  thinking_skill: "LOTS",
  evidence_ids: ["c1-e0"],
};
const slot = {
  topic: "Photosynthesis",
  type: "true_false",
  cognitive_level: "Understand",
  thinking_skill: "LOTS",
};
assert.throws(() =>
  validateAdaptiveQuestions([question], [{ ...slot, topic: "Other" }]),
);
assert.throws(() =>
  validateAdaptiveQuestions([question], [slot], [question.question]),
);
assert.equal(
  gradeMainQuiz(
    Array(20).fill(question),
    [...Array(12).fill("True"), ...Array(8).fill("False")],
    60,
  ).passed,
  true,
);
assert.equal(
  gradeMainQuiz(
    Array(20).fill(question),
    [...Array(11).fill("True"), ...Array(9).fill("False")],
    60,
  ).passed,
  false,
);
assert.equal(gradeMainQuiz([question], [" true "], 60).score, 1);
assert.throws(() => gradeMainQuiz([question], [], 60));
let generationCalls = 0;
const prompt = createMainQuizPrompt({
  ...settings,
  lotsCount: 10,
  hotsCount: 10,
  lessonContent: "Plants use sunlight.",
  practicePerformance: {},
  tosDistribution: [slot],
});
assert.match(prompt, /adaptive educational main quiz generator/);
assert.match(prompt, /LOTS count = 10/);
const generated = await generateQuizBatch(
  {
    types: ["true_false"],
    skills: ["LOTS"],
    chunks: [
      {
        chunk_id: 1,
        chunk_text:
          "Plants use sunlight to produce their food through photosynthesis.",
        document_id: 1,
        source_filename: "lesson.txt",
      },
    ],
    mainPrompt: prompt,
    assignedSlots: [slot],
    previousQuestions: [],
  },
  async (request) => {
    if (request.schema.properties.questions) {
      generationCalls++;
      assert.match(request.instruction, /adaptive educational main/);
      assert.deepEqual(request.data.assigned_slots, [slot]);
      return {
        questions: [
          {
            ...question,
            topic: generationCalls === 1 ? "Wrong" : "Photosynthesis",
          },
        ],
      };
    }
    return {
      verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
    };
  },
);
assert.equal(generationCalls, 2);
assert.equal(generated[0].topic, "Photosynthesis");
console.log(
  "Adaptive quotas, coverage, prompt, retries, duplication and server scoring checks passed.",
);

await db.end();
