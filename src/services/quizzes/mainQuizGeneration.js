import {
  array,
  integer,
  object,
  reviewedItems,
  runAcademicWorkflow,
  string,
} from "../rag/academicWorkflow.js";
import { rankAcademicEvidence } from "../rag/academicEvidence.js";
import { buildEvidence } from "../rag/evidenceService.js";
import { validateQuizBatch } from "../rag/quizRagService.js";
import { validateAdaptiveQuestions } from "./mainQuizAdaptive.js";

const schema = object({
  items: array(
    object({
      id: integer,
      type: string,
      topic: string,
      concept: string,
      question: string,
      learning_objective: string,
      cognitive_level: string,
      thinking_skill: string,
      options: array(string),
      correct_answer: string,
      explanation: string,
      evidence_ids: array(string),
    }),
  ),
});

export async function generateReviewedMainQuiz(
  config,
  blueprint,
  chunks,
  previous,
  options,
) {
  return runAcademicWorkflow(
    "main",
    { count: blueprint.slots.length, ...options },
    async (session) => {
      const questions = [];
      const objectives = String(config.learningObjectives || "")
        .split(/[\n;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const slots = blueprint.slots.map((slot, i) => ({ ...slot, id: i + 1 }));
      for (let start = 0; start < slots.length; start += 6) {
        const group = slots.slice(start, start + 6);
        const contexts = new Map(
          group.map((slot) => [
            slot.id,
            rankAcademicEvidence(
              chunks,
              [slot.topic, slot.learning_objective, slot.focus]
                .filter(Boolean)
                .join(" "),
            ),
          ]),
        );
        const seen = [...previous, ...questions.map((q) => q.question)];
        const checked = await reviewedItems(session, group, {
          draft(pending, accepted) {
            return {
              schema,
              instruction:
                "Write only the numbered Main Quiz slots requested, using each slot's approved lesson evidence. Follow the exact TOS topic, type, thinking skill and Bloom level; test the reasoning the level demands. Use the assigned learning_objective verbatim, otherwise choose a relevant listed objective or derive one from lesson evidence if none are listed. Practice focus identifies concepts to revisit within the assignment. Avoid previously tested questions and semantic duplicates. After rejection use a different grounded distinction if necessary. Use four distinct options for multiple_choice, [] and one unambiguous short answer for identification, and [True, False] as strings for true_false. Return evidence_ids from that slot. Keep text fields under 500 characters.",
              data: {
                title: config.lessonTitle,
                objectives,
                items: pending.map((s) => ({
                  ...s,
                  evidence: buildEvidence(contexts.get(s.id)),
                })),
                previous_questions: [
                  ...seen,
                  ...accepted.map((q) => q.question),
                ],
              },
            };
          },
          validate(row, slot, siblings) {
            const objective = slot.learning_objective || row.learning_objective;
            if (
              typeof objective !== "string" ||
              !objective.trim() ||
              objective.length > 500 ||
              (!slot.learning_objective &&
                objectives.length &&
                !objectives.includes(objective))
            )
              throw new Error(
                "Use an assigned module learning objective verbatim.",
              );
            const prior = [...seen, ...siblings.map((q) => q.question)];
            const [q] = validateQuizBatch(
              { questions: [row] },
              [slot.type],
              contexts.get(slot.id),
              [slot.thinking_skill],
              prior,
              {
                slots: [
                  {
                    ...slot,
                    question_number: slot.id,
                    learning_objective: objective,
                  },
                ],
              },
            );
            validateAdaptiveQuestions([q], [slot], prior);
            return q;
          },
          review: (items, accepted) => ({
            instruction:
              "Independently solve each item using only its cited approved lesson quotations. Check correctness, every distractor, unique answer, explanation, clarity, TOS topic, objective and actual Bloom demand and LOTS/HOTS. Reject semantic duplicates within this batch and against earlier stems. Keep the first valid item of a duplicate pair. Reject a focus mismatch if the assigned focus can be tested within the topic. Never use a practice response as lesson evidence.",
            data: {
              items,
              previous_questions: [...seen, ...accepted.map((q) => q.question)],
            },
          }),
          failureMessage:
            "Some Main Quiz questions could not be verified against the lesson and Table of Specifications. Review the assigned topics and lesson evidence, then retry.",
        });
        for (const q of checked) q.grounding.model_review_passed = true;
        questions.push(...checked);
      }
      return validateAdaptiveQuestions(questions, blueprint.slots, previous);
    },
  );
}
