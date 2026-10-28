import assert from "node:assert/strict";
import { mainQuizBlueprint } from "../src/services/mainQuizAdaptive.js";

const settings = {
  questionCount: 10,
  multipleChoiceCount: 5,
  identificationCount: 3,
  trueFalseCount: 2,
  lessonTitle: "Photosynthesis",
  topics: ["Light", "Plants"],
};
for (const attempt of [
  undefined,
  { total: 2, answers_json: "broken" },
  { total: 2, answers_json: JSON.stringify([{ topic: "Light" }]) },
  {
    total: 1,
    answers_json: JSON.stringify([
      { question: "Legacy question", isCorrect: true },
    ]),
  },
]) {
  const { blueprint, practiceAttemptId } = mainQuizBlueprint(settings, attempt);
  assert.equal(blueprint.mode, "baseline");
  assert.equal(practiceAttemptId, 0);
  assert.equal(blueprint.slots.length, 10);
  assert.equal(blueprint.lotsCount, 5);
  assert.equal(blueprint.hotsCount, 5);
  assert.deepEqual(
    blueprint.tosDistribution.map((row) => row.question_count),
    [5, 5],
  );
  assert.ok(
    blueprint.tosDistribution.every((row) => row.practice_percent === null),
  );
  assert.equal(
    blueprint.slots.filter((slot) => slot.type === "multiple_choice").length,
    5,
  );
}
const baseline = mainQuizBlueprint({ ...settings, topics: [] });
assert.equal(baseline.blueprint.slots[0].topic, "Photosynthesis");
const adaptive = mainQuizBlueprint(settings, {
  attempts_id: 42,
  total: 2,
  answers_json: JSON.stringify([
    { topic: "Light", cognitive_level: "Remember", isCorrect: true },
    { topic: "Plants", cognitive_level: "Analyze", isCorrect: false },
  ]),
});
assert.equal(adaptive.practiceAttemptId, 42);
assert.equal(adaptive.blueprint.mode, "adaptive");
assert.ok(
  adaptive.blueprint.tosDistribution[1].question_count >
    adaptive.blueprint.tosDistribution[0].question_count,
);
console.log(
  "Baseline fallback, missing metadata, topic coverage, distributions, and adaptive practice checks passed.",
);
