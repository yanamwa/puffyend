import { validateAdaptiveQuestions } from "../mainQuizAdaptive.js";
import { db } from "../../db.js";
import { loadChunks } from "./vectorRepository.js";
import { retrieveContexts } from "./retrievalService.js";
import { buildEvidence } from "./evidenceService.js";
import { validateCitation, stringSchema } from "./groundingService.js";
import { generateJson } from "../geminiService.js";
import { parallelMap } from "./parallelMap.js";
import { assertCourseAccess, requestError } from "./courseAccessService.js";

const cognitiveLevels = {
  LOTS: ["Remember", "Understand", "Apply"],
  HOTS: ["Analyze", "Evaluate", "Create"],
};
const quizSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["multiple_choice", "identification"] },
          question: stringSchema,
          options: { type: "ARRAY", items: stringSchema },
          correct_answer: stringSchema,
          explanation: stringSchema,
          evidence_ids: { type: "ARRAY", items: stringSchema },
        },
        required: [
          "type",
          "question",
          "options",
          "correct_answer",
          "explanation",
          "evidence_ids",
        ],
      },
    },
  },
  required: ["questions"],
};
const practiceSchema = structuredClone(quizSchema);
const practiceItem = practiceSchema.properties.questions.items;
practiceItem.properties.type.enum.push("true_false");
Object.assign(practiceItem.properties, {
  topic: stringSchema,
  cognitive_level: {
    type: "STRING",
    enum: Object.values(cognitiveLevels).flat(),
  },
  thinking_skill: { type: "STRING", enum: ["LOTS", "HOTS"] },
});
practiceItem.required.push("topic", "cognitive_level", "thinking_skill");
const reviewSchema = {
  type: "OBJECT",
  properties: {
    verdicts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question_index: { type: "INTEGER" },
          supported: { type: "BOOLEAN" },
          reason: stringSchema,
        },
        required: ["question_index", "supported", "reason"],
      },
    },
  },
  required: ["verdicts"],
};
const normalized = (value) =>
  String(value).trim().replace(/\s+/g, " ").toLowerCase();

export function validateQuizSettings(body) {
  const questionCount = Number(body.question_count ?? 5);
  const identificationCount = Number(body.identification_count ?? 0);
  const difficulty = String(body.difficulty || "medium").toLowerCase();
  if (
    !Number.isInteger(questionCount) ||
    questionCount < 1 ||
    questionCount > 100
  )
    throw requestError("Choose 1 to 100 questions.", 400);
  if (
    !Number.isInteger(identificationCount) ||
    identificationCount < 0 ||
    identificationCount > questionCount
  )
    throw requestError(
      "Identification count must be between zero and the total question count.",
      400,
    );
  if (body.assessment_type === "practice") {
    const trueFalseCount = Number(body.true_false_count ?? 0);
    const multipleChoiceCount = Number(
      body.multiple_choice_count ??
        questionCount - identificationCount - trueFalseCount,
    );
    const lotsCount = Number(
      body.lots_count ?? Math.round(questionCount * 0.6),
    );
    const hotsCount = Number(body.hots_count ?? questionCount - lotsCount);
    if (
      [multipleChoiceCount, trueFalseCount, lotsCount, hotsCount].some(
        (n) => !Number.isInteger(n) || n < 0 || n > questionCount,
      )
    )
      throw requestError(
        "Distribution counts must be whole numbers between zero and the total.",
        400,
      );
    if (
      multipleChoiceCount + identificationCount + trueFalseCount !==
      questionCount
    )
      throw requestError("Question type counts must equal the total.", 400);
    if (lotsCount + hotsCount !== questionCount)
      throw requestError("LOTS and HOTS counts must equal the total.", 400);
    return {
      assessmentType: "practice",
      questionCount,
      multipleChoiceCount,
      identificationCount,
      trueFalseCount,
      lotsCount,
      hotsCount,
    };
  }
  if (Number(body.true_false_count || 0) !== 0)
    throw requestError(
      "Only multiple choice and identification are supported.",
      400,
    );
  if (!["easy", "medium", "hard"].includes(difficulty))
    throw requestError("Choose easy, medium, or hard difficulty.", 400);
  return { questionCount, identificationCount, difficulty };
}

export function validateQuizBatch(draft, types, chunks, skills = []) {
  if (
    !Array.isArray(draft?.questions) ||
    draft.questions.length !== types.length
  )
    throw new Error("Quiz has the wrong question count.");
  const evidence = new Map(
    buildEvidence(chunks).map((e) => [e.evidence_id, e]),
  );
  const seen = new Set();
  return draft.questions.map((item, index) => {
    if (skills.length) {
      const skill =
        typeof item.thinking_skill === "string"
          ? item.thinking_skill.trim().toUpperCase()
          : item.thinking_skill;
      const level = Object.values(cognitiveLevels)
        .flat()
        .find(
          (level) =>
            typeof item.cognitive_level === "string" &&
            level.toLowerCase() === item.cognitive_level.trim().toLowerCase(),
        );
      item = {
        ...item,
        thinking_skill: skill,
        cognitive_level: level || item.cognitive_level,
      };
    }
    if (item.type !== types[index])
      throw new Error(`Question ${index} must be ${types[index]}.`);
    for (const field of ["question", "correct_answer", "explanation"]) {
      if (
        typeof item[field] !== "string" ||
        !item[field].trim() ||
        item[field].length > 500
      )
        throw new Error(
          `Question ${index}: ${field} must contain 1-500 characters.`,
        );
    }
    if (seen.has(normalized(item.question)))
      throw new Error("Duplicate quiz question.");
    seen.add(normalized(item.question));
    if (!Array.isArray(item.options))
      throw new Error("Question options must be an array.");
    if (item.type === "multiple_choice") {
      if (
        item.options.length !== 4 ||
        item.options.some(
          (o) => typeof o !== "string" || !o.trim() || o.length > 500,
        ) ||
        new Set(item.options.map(normalized)).size !== 4
      )
        throw new Error(
          `Question ${index} needs four distinct nonempty options.`,
        );
      if (!item.options.includes(item.correct_answer))
        throw new Error(
          `Question ${index}: correct answer must exactly match an option.`,
        );
    } else if (item.type === "true_false") {
      if (
        JSON.stringify(item.options) !== JSON.stringify(["True", "False"]) ||
        !item.options.includes(item.correct_answer)
      )
        throw new Error(
          "True/False requires exactly True and False options and answer.",
        );
    } else if (item.options.length || item.correct_answer.length > 150)
      throw new Error(
        "Identification must have no options and a short answer.",
      );
    if (skills.length) {
      const prefix = `Question ${index + 1}`;
      if (item.thinking_skill !== skills[index])
        throw new Error(
          `${prefix}: assigned thinking_skill is ${skills[index]}, but received ${JSON.stringify(item.thinking_skill) ?? "missing"}. Rewrite this question for the assigned skill.`,
        );
      if (!cognitiveLevels[skills[index]]?.includes(item.cognitive_level))
        throw new Error(
          `${prefix}: cognitive_level must be ${cognitiveLevels[skills[index]].join(", ")} for ${skills[index]}, but received ${JSON.stringify(item.cognitive_level) ?? "missing"}. Rewrite the reasoning and classification together.`,
        );
      if (
        typeof item.topic !== "string" ||
        !item.topic.trim() ||
        item.topic.trim().length > 100
      )
        throw new Error(
          `${prefix}: topic must be a nonempty lesson-supported label of at most 100 characters.`,
        );
    }
    if (!Array.isArray(item.evidence_ids) || !item.evidence_ids.length)
      throw new Error(`Question ${index} needs evidence.`);
    const citations = item.evidence_ids.map((id) => {
      const passage = evidence.get(id);
      if (!passage) throw new Error(`Unknown quiz evidence ID: ${id}`);
      return validateCitation(passage, chunks);
    });
    return {
      ...(skills.length
        ? {
            topic: item.topic.trim(),
            cognitive_level: item.cognitive_level,
            thinking_skill: item.thinking_skill,
          }
        : {}),
      type: item.type,
      question: item.question.trim(),
      options: item.options,
      correct_answer: item.correct_answer.trim(),
      explanation: item.explanation.trim(),
      source_chunks: citations,
      grounding: {
        exact_quotes_verified: true,
        model_review_passed: true,
        human_review_required: true,
      },
    };
  });
}

export function validateQuizReview(review, questions) {
  if (
    !Array.isArray(review?.verdicts) ||
    review.verdicts.length !== questions.length
  )
    throw new Error("Incomplete quiz grounding review.");
  const seen = new Set();
  for (const verdict of review.verdicts) {
    const i = verdict.question_index;
    if (!Number.isInteger(i) || !questions[i] || seen.has(i))
      throw new Error("Invalid quiz review index.");
    seen.add(i);
    if (verdict.supported !== true)
      throw new Error(
        `Question ${i} failed grounding: ${String(verdict.reason || "Unsupported answer.").slice(0, 1000)}`,
      );
  }
}

export async function generateQuizBatch(
  {
    types,
    chunks,
    difficulty,
    title,
    objectives,
    skills = [],
    lessonContent = "",
    distribution,
    mainPrompt,
    assignedSlots = [],
    previousQuestions = [],
  },
  generate = generateJson,
) {
  const slots = mainPrompt
    ? assignedSlots
    : types.map((type, index) => ({
        question_number: index + 1,
        type,
        ...(skills.length
          ? {
              thinking_skill: skills[index],
              allowed_cognitive_levels: cognitiveLevels[skills[index]],
              topic_max_characters: 100,
            }
          : {}),
      }));
  const schema = structuredClone(skills.length ? practiceSchema : quizSchema);
  schema.properties.questions.items.properties.type.enum = [...new Set(types)];
  if (skills.length) {
    schema.properties.questions.items.properties.thinking_skill.enum = [
      ...new Set(skills),
    ];
    schema.properties.questions.items.properties.cognitive_level.enum = [
      ...new Set(skills.flatMap((skill) => cognitiveLevels[skill])),
    ];
  }
  let correction = "",
    previousDraft = null,
    previousReview = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const draft = await generate({
        schema,
        instruction: mainPrompt
          ? mainPrompt +
            [
              "\nThis is a batch of the full quiz: generate only the assigned slots in order.",
              "Each slot fixes topic, type, cognitive_level and thinking_skill.",
              "Include evidence_ids for each question from the supplied evidence.",
              "Do not repeat previous_questions.",
              "Keep fields under 500 characters.",
              "Repair rejected questions using correction and reviewer reasons.",
            ].join(" ")
          : skills.length
            ? [
                `You are an educational practice quiz generator.`,
                `Generate exactly ${types.length} questions in the assigned types and thinking_skills order for this batch; the quiz-wide distribution is supplied separately.`,
                `Use ONLY retrieved source evidence and lesson content supported by that evidence.`,
                `Objectives are learning targets, never evidence.`,
                `When lesson content contains Practice Activity prompts, use those activities to guide source-supported practice questions. Convert reflections into objectively answerable questions; never grade personal opinions as facts.`,
                `Every question must be directly supported by cited evidence_ids.`,
                `Avoid duplicate or nearly identical questions.`,
                `Keep grammar clear and explanations concise and educational.`,
                `Do not refer to the text above or the provided lesson.`,
                `LOTS assesses Remember, Understand, Apply; HOTS assesses Analyze, Evaluate, Create.`,
                `Each question needs exactly one matching cognitive_level and thinking_skill.`,
                `Assign a short consistent topic supported by the source; use the same topic name for the same concept.`,
                `Multiple choice: exactly four plain options without letter prefixes, one correct answer, believable but clearly incorrect distractors.`,
                `Identification: options=[], one unique short expected answer, do not reveal it in the question.`,
                `True/False: options exactly ["True", "False"], correct_answer exactly True or False.`,
                `Return question, type, options, correct_answer, explanation, topic, cognitive_level, thinking_skill, evidence_ids in valid JSON.`,
                `Keep fields under 500 characters and identification answers under 150.`,
                `Repair rejected questions using reviewer reasons.`,
              ].join(" ")
            : [
                "Generate exactly the requested question types in the supplied order using ONLY evidence.",
                "Cite evidence IDs; never write quotes.",
                "Multiple choice needs four distinct options with exactly one supported correct answer.",
                "Identification asks for one clearly defined term or short phrase, uses options=[], and must not reveal the answer in the question.",
                "Keep every field under 500 characters and identification answers under 150.",
                "Explanations and correct answers must follow from selected evidence.",
                "Cite adjacent passages when needed.",
                "Do not invent facts, scenarios, or True/False questions.",
                "Avoid duplicates.",
                "Difficulty changes reasoning depth, not source fidelity.",
                "Objectives are targets, never evidence.",
                "Repair rejected questions using reviewer reasons.",
              ].join(" "),
        data: {
          title,
          objectives,
          types,
          difficulty,
          assigned_slots: slots,
          slot_instruction: [
            "Return questions in assigned_slots order.",
            "Each slot fixes the type and thinking_skill; use only its allowed cognitive levels.",
            "topic must be a short source-supported label (1–100 characters).",
            "Do not replace assigned skills with your preferred distribution.",
          ].join(" "),
          ...(mainPrompt ? { previous_questions: previousQuestions } : {}),
          ...(skills.length
            ? {
                thinking_skills: skills,
                lesson_content: lessonContent,
                quiz_distribution: distribution,
              }
            : {}),
          evidence: buildEvidence(chunks),
          correction,
          previous_draft: previousDraft,
          previous_review: previousReview,
        },
      });
      previousDraft = draft;
      previousReview = null;
      const questions = validateQuizBatch(draft, types, chunks, skills);
      if (mainPrompt)
        validateAdaptiveQuestions(questions, assignedSlots, previousQuestions);
      const review = await generate({
        schema: reviewSchema,
        instruction: [
          "Independently audit every question against its exact source quotes.",
          "supported=true only if the question is answerable, the correct answer and ALL explanation claims follow from the quotes, and multiple choice has exactly one correct option (check every distractor for ambiguity).",
          "Identification must have a unique short answer and must not reveal it.",
          "For True/False, check the truth value from evidence.",
          "For practice questions also verify that the topic is supported and the cognitive level reflects the actual reasoning required, with LOTS=Remember/Understand/Apply and HOTS=Analyze/Evaluate/Create.",
          "Do not rely on prior knowledge.",
          "Return one verdict per zero-based question_index with a specific reason for any rejection.",
        ].join(" "),
        data: { questions },
      });
      previousReview = review;
      validateQuizReview(review, questions);
      return questions;
    } catch (error) {
      if (error.statusCode || error.retryable) throw error;
      correction = error.message;
    }
  }
  throw requestError(
    `Generated quiz did not pass validation after two repair attempts: ${correction}`,
    422,
  );
}

export async function generateQuizWithRag({ user, body }) {
  const settings = validateQuizSettings(body);
  const courseId = Number(body.course_id);
  const lessonId = body.lesson_id ? Number(body.lesson_id) : null;
  await assertCourseAccess(user, courseId, lessonId);
  if (!Array.isArray(body.document_ids || []))
    throw requestError("document_ids must be an array.", 400);
  const selected = [...new Set((body.document_ids || []).map(String))];
  const [documents] = await db.execute(
    `SELECT document_id, filename, processing_status FROM lesson_source_documents
    WHERE course_id = ? AND (lesson_id <=> ? OR (lesson_id IS NULL AND ? = 1)) ORDER BY document_id`,
    [courseId, lessonId, selected.length ? 1 : 0],
  );
  const sources = selected.length
    ? documents.filter((d) => selected.includes(String(d.document_id)))
    : documents;
  if (selected.some((id) => !sources.some((d) => String(d.document_id) === id)))
    throw requestError(
      "A selected source does not belong to this course/module.",
      403,
    );
  if (!sources.length)
    throw requestError(
      "Generate the lesson from uploaded material first, then generate its source-based quiz.",
      409,
    );
  if (sources.some((d) => d.processing_status !== "ready"))
    throw requestError("Some sources are not ready. Reindex them first.", 409);
  const chunks = (
    await Promise.all(
      sources.map(async (source) =>
        (await loadChunks(source.document_id)).map((c) => ({
          ...c,
          source_filename: source.filename,
        })),
      ),
    )
  ).flat();
  if (!chunks.length) throw requestError("No indexed evidence available.", 409);
  const ids = sources.map((d) => d.document_id);
  const title = String(body.lesson_title || "Module quiz").slice(0, 100);
  const objectives = String(body.learning_objectives || "").slice(0, 1500);
  const relevant = await retrieveContexts(ids, [title, objectives].join(" "), {
    topK: Math.min(6, chunks.length),
    chunks,
  });
  const types =
    settings.assessmentType === "practice"
      ? [
          ...Array(settings.multipleChoiceCount).fill("multiple_choice"),
          ...Array(settings.identificationCount).fill("identification"),
          ...Array(settings.trueFalseCount).fill("true_false"),
        ]
      : Array.from({ length: settings.questionCount }, (_, i) =>
          i < settings.questionCount - settings.identificationCount
            ? "multiple_choice"
            : "identification",
        );
  const skills =
    settings.assessmentType === "practice"
      ? types.map((_, i) =>
          Math.floor(((i + 1) * settings.hotsCount) / types.length) >
          Math.floor((i * settings.hotsCount) / types.length)
            ? "HOTS"
            : "LOTS",
        )
      : [];
  const batches = Array.from({ length: Math.ceil(types.length / 5) }, (_, i) =>
    types.slice(i * 5, i * 5 + 5),
  );
  const questions = (
    await parallelMap(batches, 3, async (types, index) => {
      const start = Math.floor((index * chunks.length) / batches.length);
      const spread = chunks.slice(start, Math.min(chunks.length, start + 6));
      const context = [
        ...new Map(
          [...spread, ...relevant].map((c) => [String(c.chunk_id), c]),
        ).values(),
      ];
      return generateQuizBatch({
        types,
        chunks: context,
        difficulty: settings.difficulty,
        title,
        objectives,
        skills: skills.slice(index * 5, index * 5 + types.length),
        lessonContent: String(body.lesson_content || "").slice(0, 30000),
        distribution: settings,
      });
    })
  ).flat();
  if (
    new Set(questions.map((q) => normalized(q.question))).size !==
    questions.length
  )
    throw requestError(
      "Duplicate questions detected across quiz batches. Retry generation.",
      422,
    );
  return { questions, document_ids: ids, ...settings };
}
