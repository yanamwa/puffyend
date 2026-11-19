import {
  normalizeAnswer,
  validateAdaptiveQuestions,
} from "../quizzes/mainQuizAdaptive.js";
import {
  DUPLICATE_QUIZ_QUESTION,
  validateKnownAnswerKey,
  validateQuizUniqueness,
} from "../quizzes/quizValidation.js";
import { db } from "../../db.js";
import { loadChunks } from "./vectorRepository.js";
import { retrieveContexts } from "./retrievalService.js";
import { buildEvidence } from "./evidenceService.js";
import { validateCitation, stringSchema } from "./groundingService.js";
import { generateJson } from "../ai/geminiService.js";
import { parallelMap } from "./parallelMap.js";
import { assertCourseAccess, requestError } from "./courseAccessService.js";

const cognitiveLevels = {
  LOTS: ["Remember", "Understand", "Apply"],
  HOTS: ["Analyze", "Evaluate", "Create"],
};
const ansiSparcTopic = /\b(?:ANSI\W+(?:X3\W+)?SPARC|three[- ]schema architecture)\b/i;

function preferredPracticeWording(index) {
  // Spread the roughly three optional cases per ten across the full quiz.
  const scenarioShare = 0.3;
  const casesBefore = Math.round(index * scenarioShare);
  const casesThroughSlot = Math.round((index + 1) * scenarioShare);
  return casesThroughSlot > casesBefore ? "scenario_if_useful" : "direct";
}

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
  concept: stringSchema,
  cognitive_level: {
    type: "STRING",
    enum: Object.values(cognitiveLevels).flat(),
  },
  thinking_skill: { type: "STRING", enum: ["LOTS", "HOTS"] },
});
practiceItem.required.push(
  "topic",
  "concept",
  "cognitive_level",
  "thinking_skill",
);
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

export function validateQuizBatch(
  draft,
  types,
  chunks,
  skills = [],
  previousQuestions = [],
  { practiceFocus, shortAnswer, rejectedSlots, passages } = {},
) {
  if (
    !Array.isArray(draft?.questions) ||
    (!rejectedSlots && draft.questions.length !== types.length)
  )
    throw new Error("Quiz has the wrong question count.");
  const evidence = new Map(
    (passages || buildEvidence(chunks)).map((e) => [e.evidence_id, e]),
  );
  function validateQuestion(item, index) {
    if (!item || typeof item !== "object")
      throw new Error(`Question ${index + 1} is missing from the draft.`);
    validateKnownAnswerKey(item);
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
    if (!Array.isArray(item.options))
      throw new Error("Question options must be an array.");
    if (item.type === "multiple_choice") {
      if (
        item.options.length !== 4 ||
        item.options.some(
          (o) => typeof o !== "string" || !o.trim() || o.length > 500,
        )
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
      throw Object.assign(new Error(`Question ${index + 1} needs evidence.`), {
        code: "QUIZ_EVIDENCE_INVALID",
      });
    const citations = item.evidence_ids.map((id) => {
      const passage = evidence.get(id);
      if (!passage)
        throw Object.assign(new Error(`Unknown quiz evidence ID: ${id}`), {
          code: "QUIZ_EVIDENCE_INVALID",
        });
      return validateCitation(passage, chunks);
    });
    const question = {
      ...(skills.length
        ? {
            topic: item.topic.trim(),
            concept:
              typeof item.concept === "string"
                ? item.concept.trim().slice(0, 100)
                : item.topic.trim(),
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
    for (const [field, assigned] of [
      ["topic", practiceFocus?.target_topics?.[index]],
      ["concept", practiceFocus?.target_concepts?.[index]],
    ]) {
      if (!assigned) continue;
      if (normalizeAnswer(question[field]) !== normalizeAnswer(assigned))
        throw Object.assign(
          new Error(
            `Question ${index + 1} must assess assigned ${field === "topic" ? "weak topic" : "missed concept"} ${assigned}.`,
          ),
          { code: "QUIZ_FOCUS_MISMATCH" },
        );
      question[field] = assigned;
    }
    if (
      shortAnswer &&
      (!question.question.endsWith("?") ||
        /\b(?:of (?:the following|these|those)|(?:options|choices|statements) (?:above|below)|(?:choose|select) (?:the |an? )?(?:(?:correct|best) )?(?:option|answer|statement)|(?:true or false|yes or no))\b/i.test(
          question.question,
        ) ||
        /^(?:true|false|yes|no)[.!?]?$/i.test(question.correct_answer))
    )
      throw new Error(
        "Q&A questions must stand alone and ask for a short typed answer. Remove references to choices or binary answers.",
      );
    return question;
  }
  if (!rejectedSlots)
    return validateQuizUniqueness(
      draft.questions.map(validateQuestion),
      previousQuestions,
    );

  // Review the usable slots even when a sibling has a bad key, repeated stem,
  // missing citation, or incorrect assignment. Only reviewed slots can be saved.
  const questions = [];
  const stems = [...previousQuestions];
  for (const index of types.keys()) {
    try {
      const question = validateQuestion(draft.questions[index], index);
      validateQuizUniqueness([question], stems);
      questions.push(question);
      stems.push(question.question);
    } catch (error) {
      rejectedSlots.set(index, error);
    }
  }
  return questions;
}

function quizReviewVerdicts(review, questions) {
  if (
    !Array.isArray(review?.verdicts) ||
    review.verdicts.length !== questions.length
  )
    throw Object.assign(new Error("Incomplete quiz grounding review."), {
      code: "QUIZ_REVIEW_INCOMPLETE",
    });
  const seen = new Set();
  for (const verdict of review.verdicts) {
    const i = verdict?.question_index;
    if (!Number.isInteger(i) || !questions[i] || seen.has(i))
      throw Object.assign(new Error("Invalid quiz review index."), {
        code: "QUIZ_REVIEW_INCOMPLETE",
      });
    seen.add(i);
  }
  return review.verdicts;
}

function rejectedVerdict(verdict) {
  return Object.assign(
    new Error(
      `Question ${verdict.question_index} failed grounding: ${String(verdict.reason || "Unsupported answer.").slice(0, 1000)}`,
    ),
    { code: "QUIZ_REVIEW_REJECTED" },
  );
}

export function validateQuizReview(review, questions) {
  for (const verdict of quizReviewVerdicts(review, questions)) {
    if (verdict.supported !== true)
      throw rejectedVerdict(verdict);
  }
}

export function selectPracticeFocus(focus, indexes) {
  if (!focus) return undefined;
  const targeted = indexes.filter((index) => index < focus.target_count);
  return {
    ...focus,
    target_count: targeted.length,
    target_topics:
      focus.target_topics &&
      targeted.map((index) => focus.target_topics[index]),
    target_concepts:
      focus.target_concepts &&
      targeted.map((index) => focus.target_concepts[index]),
  };
}

function partialPracticeError(rejectedSlots, validatedQuestions = []) {
  const first = rejectedSlots.values().next().value;
  return Object.assign(new Error(first.message), {
    code: first.code,
    validatedQuestions,
    rejectedSlots,
  });
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
    promptPreviousQuestions = previousQuestions,
    practiceFocus,
    practiceSlotIndexes,
    shortAnswer = false,
    onValidated,
    maxAttempts = 3,
    preserveValidated = false,
    initialCorrection = "",
    requestOptions,
  },
  generate = generateJson,
) {
  const isPractice = skills.length > 0 && !mainPrompt;
  const reviewObjectives = (isPractice || preserveValidated) && objectives;
  const slots = mainPrompt
    ? assignedSlots
    : types.map((type, index) => ({
        question_number: index + 1,
        type,
        ...(practiceFocus?.target_topics?.[index]
          ? { topic: practiceFocus.target_topics[index] }
          : {}),
        ...(practiceFocus?.target_concepts?.[index]
          ? { concept: practiceFocus.target_concepts[index] }
          : {}),
        ...(skills.length
          ? {
              thinking_skill: skills[index],
              allowed_cognitive_levels: cognitiveLevels[skills[index]],
              preferred_wording: preferredPracticeWording(
                practiceSlotIndexes?.[index] ?? index,
              ),
              topic_max_characters: 100,
            }
          : {}),
      }));
  const schema = structuredClone(skills.length ? practiceSchema : quizSchema);
  schema.properties.questions.items.properties.type.enum = [...new Set(types)];
  const evidence = buildEvidence(chunks);
  if (preserveValidated && evidence.length) {
    // Short IDs are local to this request. Citations still resolve to the
    // original saved lesson chunks, including modules with UUID identifiers.
    evidence.forEach((passage, index) => {
      passage.evidence_id = `E${index + 1}`;
    });
    schema.properties.questions.items.properties.evidence_ids.items = {
      type: "STRING",
      enum: evidence.map((passage) => passage.evidence_id),
    };
  }
  if (skills.length) {
    schema.properties.questions.items.properties.thinking_skill.enum = [
      ...new Set(skills),
    ];
    schema.properties.questions.items.properties.cognitive_level.enum = [
      ...new Set(skills.flatMap((skill) => cognitiveLevels[skill])),
    ];
  }
  let correction = initialCorrection,
    lastFailure,
    previousDraft = null,
    previousReview = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const draft = await generate({
        ...requestOptions,
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
          : isPractice
            ? [
                `You are an educational practice quiz generator.`,
                `Generate exactly ${types.length} questions in the assigned types and thinking_skills order for this batch; the quiz-wide distribution is supplied separately.`,
                `Use ONLY retrieved source evidence and lesson content supported by that evidence.`,
                `Objectives are learning targets, never evidence.`,
                `When lesson content contains Practice Activity prompts, use those activities to guide source-supported practice questions. Convert reflections into objectively answerable questions; never grade personal opinions as facts.`,
                `Every question must be directly supported by cited evidence_ids.`,
                "For comparisons, rankings or predictions, cite the facts needed for every side of the reasoning. When the lesson supports only one fact, choose a different learning check that the available evidence can answer.",
                "Choose wording that tests the current lesson objective. When objectives are absent, use the skill taught by the cited passage.",
                "Ask directly by default. Include essential values, conditions or excerpts in the question. For HOTS, a direct comparison, prediction or judgment can test the required reasoning.",
                "preferred_wording is a flexible guide across the whole quiz. In a scenario_if_useful slot, use a brief scenario only if its details are needed to answer the question. Every slot may be direct. If an objective specifically requires interpreting a case, give just the details needed in any slot.",
                "Omit a story if removing it leaves the same reasoning and answer. Avoid duplicate or nearly identical questions, including previous_questions. Avoid recycling a setup just to ask for a different label.",
                `Keep grammar clear and explanations concise and educational.`,
                `Do not refer to the text above or the provided lesson.`,
                `LOTS assesses Remember, Understand, Apply; HOTS assesses Analyze, Evaluate, Create.`,
                `Each question needs exactly one matching cognitive_level and thinking_skill.`,
                `Assign a short consistent topic supported by the source; use the same topic name for the same concept. Include concept: a specific sub-concept tested, not just the module title.`,
                `If assigned_slots specifies a topic, use that exact topic and test it meaningfully. Do not merely relabel a question about another topic.`,
                `If assigned_slots specifies a concept, assess that exact missed concept and use its exact concept label. When it recurs, test a different distinction, relationship, step or application supported by the lesson.`,
                `Multiple choice: exactly four distinct plain options without letter prefixes, one correct answer, believable but clearly incorrect distractors.`,
                `Identification: options=[], one unique short expected answer, do not reveal it in the question.`,
                `True/False: options exactly ["True", "False"], correct_answer exactly True or False.`,
                `Return question, type, options, correct_answer, explanation, topic, cognitive_level, thinking_skill, evidence_ids in valid JSON.`,
                `Keep fields under 500 characters and identification answers under 150.`,
                `Repair rejected questions using reviewer reasons.`,
                ...(shortAnswer
                  ? [
                      "Students type an answer with no options on screen. Write each question as a standalone question ending in a question mark, with enough context to answer it on its own.",
                      "Ask for one specific term, short phrase, or fact. Avoid lists of possible answers, 'which of the following', references to choices, and True/False or Yes/No prompts.",
                      "Use direct questions like 'What is the first step in [named process]?' or 'What term describes [specific concept]?' These templates are style guides, never evidence.",
                    ]
                  : []),
                ...(practiceFocus
                  ? [
                      "Use practice_focus.target_count questions to check the concepts described by practice_focus.missed_concepts. Use the remaining questions to review other concepts where the supplied evidence covers them.",
                      "If none of the missed concepts appear in the supplied evidence, cover other concepts supported by the supplied evidence.",
                      "Use fresh wording for missed questions. Missed concepts are learning targets and never evidence.",
                      "Revisit missed concepts with short, direct sentences. Make these questions clearer and easier to understand. Use an example only if it contributes information the student must apply.",
                      "Keep the remaining questions at the supplied baseline difficulty. Do not increase difficulty or reasoning depth merely because previous answers were correct.",
                      "Use concise explanations to clarify each missed concept and why the answer is correct.",
                      "Contrast the student's selected wrong answer with the source-supported correct answer when the evidence supports that distinction. Do not copy an incorrect answer as evidence.",
                      "For isSelfAssessed=true, userAnswer is a flashcard rating, not a factual response. Use the rated-difficult concept for review without interpreting the rating as a misconception.",
                      "Repeated practice on a weak topic must test different sub-concepts or genuinely different applications. Rephrasing the same fact is a duplicate.",
                    ]
                  : []),
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
                "Avoid duplicates, including previous_questions.",
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
          previous_questions: [...promptPreviousQuestions],
          ...(skills.length
            ? {
                thinking_skills: skills,
                lesson_content: lessonContent,
                quiz_distribution: distribution,
                ...(practiceFocus ? { practice_focus: practiceFocus } : {}),
              }
            : {}),
          evidence,
          correction,
          previous_draft: previousDraft,
          previous_review: previousReview,
        },
      });
      previousDraft = draft;
      previousReview = null;
      const rejectedSlots = preserveValidated ? new Map() : undefined;
      const questions = validateQuizBatch(
        draft,
        types,
        chunks,
        skills,
        previousQuestions,
        { practiceFocus, shortAnswer, rejectedSlots, passages: evidence },
      );
      if (rejectedSlots?.size && !questions.length)
        throw partialPracticeError(rejectedSlots);
      const reviewIndexes = types
        .map((_, i) => i)
        .filter((i) => !rejectedSlots?.has(i));
      const reviewSlots = preserveValidated
        ? reviewIndexes.map((index, question_index) => {
            const { question_number, ...assignment } = slots[index];
            return { question_index, ...assignment };
          })
        : slots;
      const reviewFocus = rejectedSlots?.size
        ? selectPracticeFocus(practiceFocus, reviewIndexes)
        : practiceFocus;
      if (mainPrompt)
        validateAdaptiveQuestions(questions, assignedSlots, previousQuestions);
      const review = await generate({
        ...requestOptions,
        schema: reviewSchema,
        instruction: [
          "Independently audit every question against its exact source quotes.",
          "supported=true only if the question is answerable, the correct answer and ALL explanation claims follow from the quotes, and multiple choice has exactly one correct option (check every distractor for ambiguity).",
          "Identification must have a unique short answer and must not reveal it.",
          ...(shortAnswer
            ? [
                "Reject any question a student cannot answer without choices, and any question that only asks for a True/False or Yes/No response.",
              ]
            : []),
          "For True/False, check the truth value from evidence.",
          "Check for contradictions between the keyed answer and explanation, and check every answer option independently. Never accept an answer merely because the generator selected it.",
          "Verify the lesson's labels for concepts, roles and levels against their definitions in the quotes. Reject swapped labels or conflicting explanations.",
          ...(questions.some(
            (item) =>
              ansiSparcTopic.test(item.question) ||
              item.source_chunks.some(({ quote }) => ansiSparcTopic.test(quote)),
          )
            ? [
                "For ANSI-SPARC questions, distinguish the internal physical-storage level from external user views and verify the level against the quotes.",
              ]
            : []),
          "Reject duplicate learning checks within the batch or previous_questions, including semantic paraphrases of the same fact. Allow the exact same missed concept when a different inference, distinction, or application is needed to answer. Changing a name or rewording a definition alone is a duplicate.",
          "For each assigned topic and concept, verify the question actually assesses the specific missed concept using practice_focus, rather than just using its label or testing another part of the general topic.",
          "For practice questions also verify that the topic is supported and the cognitive level reflects the actual reasoning required, with LOTS=Remember/Understand/Apply and HOTS=Analyze/Evaluate/Create.",
          ...(isPractice
            ? [
                "For a practice scenario, identify the detail the student must use for the objective. If removing the story leaves the same task, request a direct rewrite of that question.",
                "For comparisons and rankings, check that the cited passages support the facts on each side and the conclusion. Reject only the unsupported slots.",
                "Flag a repeated setup that only asks for a new label. A shared passage or dataset is fine when different reasoning is required. Accept a fully direct quiz. Never reject a question solely because of the suggested wording mix.",
              ]
            : []),
          ...(reviewObjectives
            ? [
                "Check that each question assesses a relevant lesson objective. Objectives describe what to assess; only the cited lesson passages support the answer.",
              ]
            : []),
          "Do not rely on prior knowledge.",
          "Return one verdict per zero-based question_index with a specific reason for any rejection.",
        ].join(" "),
        data: {
          questions: preserveValidated
            ? questions.map((question, question_index) => ({
                question_index,
                ...question,
              }))
            : questions,
          previous_questions: [...(preserveValidated ? previousQuestions : promptPreviousQuestions)],
          ...(reviewObjectives ? { objectives: reviewObjectives } : {}),
          assigned_slots: reviewSlots,
          ...(reviewFocus ? { practice_focus: reviewFocus } : {}),
        },
      });
      previousReview = review;
      if (preserveValidated) {
        const approved = [];
        for (const verdict of quizReviewVerdicts(review, questions)) {
          const position = verdict.question_index;
          const index = reviewIndexes[position];
          if (verdict.supported === true)
            approved.push({ index, question: questions[position] });
          else rejectedSlots.set(index, rejectedVerdict(verdict));
        }
        if (rejectedSlots.size)
          throw partialPracticeError(rejectedSlots, approved);
      } else validateQuizReview(review, questions);
      onValidated?.(questions);
      return questions;
    } catch (error) {
      if (error.statusCode || error.retryable) throw error;
      correction = error.message;
      lastFailure = error;
    }
  }
  const error = requestError(
    `Generated quiz did not pass validation${maxAttempts === 3 ? " after two repair attempts" : ""}: ${correction}`,
    422,
  );
  if (preserveValidated) {
    error.code = lastFailure?.code || "QUIZ_QUESTION_FORMAT";
    error.validatedQuestions = lastFailure?.validatedQuestions || [];
    error.rejectedSlots = lastFailure?.rejectedSlots;
  } else if (lastFailure?.code === DUPLICATE_QUIZ_QUESTION) {
    error.code = DUPLICATE_QUIZ_QUESTION;
  }
  throw error;
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
    WHERE course_id = ? AND (lesson_id IS NOT DISTINCT FROM ? OR (lesson_id IS NULL AND ? = 1)) ORDER BY document_id`,
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
  const batchSize = 5;
  const batches = Array.from({ length: Math.ceil(types.length / batchSize) }, (_, i) =>
    types.slice(i * batchSize, (i + 1) * batchSize),
  );
  const acceptedQuestions = [];
  const questions = (
    await parallelMap(batches, 3, async (types, index) => {
      const firstSlot = index * batchSize;
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
        skills: skills.slice(firstSlot, firstSlot + types.length),
        practiceSlotIndexes: types.map((_, position) => firstSlot + position),
        lessonContent: String(body.lesson_content || "").slice(0, 30000),
        distribution: settings,
        previousQuestions: acceptedQuestions,
        onValidated: (batch) => {
          validateQuizUniqueness(batch, acceptedQuestions);
          acceptedQuestions.push(...batch.map((question) => question.question));
        },
      });
    })
  ).flat();
  validateQuizUniqueness(questions);
  return { questions, document_ids: ids, ...settings };
}
