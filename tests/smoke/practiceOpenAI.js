// Opt-in live check: node tests/smoke/practiceOpenAI.js (from the backend).
// The normal test suite never sends a paid request.
import "../../src/environment.js";
import { generateQuizBatch } from "../../src/services/rag/quizRagService.js";
import { generateOpenAIJson } from "../../src/services/rag/openaiJson.js";

const batch = {
  title: "Ordered values",
  objectives: "Identify the median.",
  types: ["multiple_choice"],
  skills: ["LOTS"],
  difficulty: "easy",
  chunks: [{
    chunk_id: "1", source_filename: "Synthetic fixture",
    chunk_text: "The median is the middle value of three numbers arranged from smallest to largest.",
  }],
  preserveValidated: true,
  maxAttempts: 1,
  requestOptions: { timeoutMs: 45_000, deadlineAt: Date.now() + 240_000, signal: AbortSignal.timeout(240_000) },
};
const fixture = { questions: [{
  type: "multiple_choice", question: "What is the middle value of three ordered numbers called?",
  options: ["Median", "Mean", "Mode", "Range"], correct_answer: "Median",
  explanation: "The median is the middle ordered observation.", topic: "Ordered values", concept: "Median",
  cognitive_level: "Remember", thinking_skill: "LOTS", evidence_ids: ["E1"],
}] };
let reviewAttempted = false;
async function live(request) {
  const phase = request.schema.properties.verdicts ? "review" : "generation";
  if (phase === "review") reviewAttempted = true;
  console.info("OpenAI smoke request", phase);
  return generateOpenAIJson(request);
}
function reportFailure(phase, error) {
  // Provider error messages and validation reasons may include source text.
  console.error("OpenAI smoke failed", phase, error.code || "VALIDATION_FAILED", error.statusCode || 0);
  process.exitCode = 1;
}
try {
  const questions = await generateQuizBatch(batch, live);
  if (questions.length !== 1 || !questions[0].source_chunks.length) throw new Error();
  console.info("OpenAI generation and independent review passed.");
} catch (error) {
  reportFailure("end-to-end", error);
  if (!reviewAttempted) {
    try {
      await generateQuizBatch(batch, (request) => request.schema.properties.questions ? fixture : live(request));
      console.info("The independent review accepted the synthetic reference question.");
    } catch (reviewError) {
      reportFailure("independent review", reviewError);
    }
  }
}
