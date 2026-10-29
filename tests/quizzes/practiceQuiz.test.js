import assert from "node:assert/strict";
import { db } from "../../src/db.js";
import {
  validateQuizSettings,
  validateQuizBatch,
  generateQuizBatch,
} from "../../src/services/rag/quizRagService.js";
const settings = {
  assessment_type: "practice",
  question_count: 20,
  multiple_choice_count: 10,
  identification_count: 5,
  true_false_count: 5,
  lots_count: 12,
  hots_count: 8,
};
assert.equal(validateQuizSettings(settings).hotsCount, 8);
for (const change of [
  { multiple_choice_count: 9 },
  { lots_count: 11 },
  { hots_count: -1 },
  { true_false_count: 4.5 },
])
  assert.throws(() => validateQuizSettings({ ...settings, ...change }));
assert.deepEqual(validateQuizSettings({}), {
  questionCount: 5,
  identificationCount: 0,
  difficulty: "medium",
});
const chunks = [
  {
    chunk_id: 1,
    chunk_text:
      "Plants use sunlight to produce their food through photosynthesis.",
    document_id: 1,
    source_filename: "lesson.txt",
  },
];
const question = {
  type: "true_false",
  question: "Plants use sunlight to produce food.",
  options: ["True", "False"],
  correct_answer: "True",
  explanation: "Photosynthesis uses sunlight.",
  topic: "Photosynthesis",
  cognitive_level: "Understand",
  thinking_skill: "LOTS",
  evidence_ids: ["c1-e0"],
};
assert.equal(
  validateQuizBatch({ questions: [question] }, ["true_false"], chunks, [
    "LOTS",
  ])[0].topic,
  "Photosynthesis",
);
for (const change of [
  { options: ["False", "True"] },
  { correct_answer: "yes" },
  { thinking_skill: "HOTS" },
  { cognitive_level: "Evaluate" },
  { topic: "" },
  { evidence_ids: ["unknown"] },
])
  assert.throws(() =>
    validateQuizBatch(
      { questions: [{ ...question, ...change }] },
      ["true_false"],
      chunks,
      ["LOTS"],
    ),
  );
let calls = 0;
const generated = await generateQuizBatch(
  {
    types: ["true_false"],
    skills: ["LOTS"],
    chunks,
    title: "Plants",
    objectives: "Understand photosynthesis",
  },
  async (request) => {
    calls++;
    if (request.schema.properties.questions) {
      assert.match(request.instruction, /educational practice quiz generator/);
      return { questions: [question] };
    }
    return {
      verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
    };
  },
);
assert.equal(calls, 2);
assert.equal(generated[0].thinking_skill, "LOTS");
const normalized = validateQuizBatch(
  {
    questions: [
      {
        ...question,
        thinking_skill: " lots ",
        cognitive_level: " understand ",
      },
    ],
  },
  ["true_false"],
  chunks,
  ["LOTS"],
);
assert.equal(normalized[0].thinking_skill, "LOTS");
assert.equal(normalized[0].cognitive_level, "Understand");
let drafts = 0;
const repaired = await generateQuizBatch(
  { types: ["true_false"], skills: ["LOTS"], chunks },
  async (request) => {
    if (!request.schema.properties.questions)
      return {
        verdicts: [{ question_index: 0, supported: true, reason: "Supported" }],
      };
    drafts++;
    assert.deepEqual(request.data.assigned_slots[0].allowed_cognitive_levels, [
      "Remember",
      "Understand",
      "Apply",
    ]);
    assert.deepEqual(
      request.schema.properties.questions.items.properties.thinking_skill.enum,
      ["LOTS"],
    );
    if (drafts === 1)
      return {
        questions: [
          { ...question, thinking_skill: "HOTS", cognitive_level: "Analyze" },
        ],
      };
    assert.match(
      request.data.correction,
      /Question 1: assigned thinking_skill is LOTS/,
    );
    return { questions: [question] };
  },
);
assert.equal(drafts, 2);
assert.equal(repaired[0].thinking_skill, "LOTS");
await assert.rejects(
  () =>
    generateQuizBatch(
      { types: ["true_false"], skills: ["LOTS"], chunks },
      async () => ({
        questions: [{ ...question, cognitive_level: "Analyze" }],
      }),
    ),
  /did not pass validation.*Question 1: cognitive_level must be Remember, Understand, Apply/,
);
console.log(
  "Practice settings, metadata, True/False, evidence, and generation/review checks passed.",
);
await db.end();
