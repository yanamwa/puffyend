import { db } from '../../db.js';
import { loadChunks } from './vectorRepository.js';
import { retrieveContexts } from './retrievalService.js';
import { buildEvidence } from './evidenceService.js';
import { validateCitation, stringSchema } from './groundingService.js';
import { generateJson } from '../geminiService.js';
import { parallelMap } from './parallelMap.js';
import { assertCourseAccess, requestError } from './courseAccessService.js';

const quizSchema = { type: 'OBJECT', properties: { questions: { type: 'ARRAY', items: {
  type: 'OBJECT', properties: {
    type: { type: 'STRING', enum: ['multiple_choice', 'identification'] },
    question: stringSchema, options: { type: 'ARRAY', items: stringSchema },
    correct_answer: stringSchema, explanation: stringSchema,
    evidence_ids: { type: 'ARRAY', items: stringSchema },
  }, required: ['type', 'question', 'options', 'correct_answer', 'explanation', 'evidence_ids'],
} } }, required: ['questions'] };
const reviewSchema = { type: 'OBJECT', properties: { verdicts: { type: 'ARRAY', items: {
  type: 'OBJECT', properties: { question_index: { type: 'INTEGER' }, supported: { type: 'BOOLEAN' }, reason: stringSchema },
  required: ['question_index', 'supported', 'reason'],
} } }, required: ['verdicts'] };
const normalized = value => String(value).trim().replace(/\s+/g, ' ').toLowerCase();

export function validateQuizSettings(body) {
  const questionCount = Number(body.question_count ?? 5);
  const identificationCount = Number(body.identification_count ?? 0);
  const difficulty = String(body.difficulty || 'medium').toLowerCase();
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) throw requestError('Choose 1 to 50 questions.', 400);
  if (!Number.isInteger(identificationCount) || identificationCount < 0 || identificationCount > questionCount) throw requestError('Identification count must be between zero and the total question count.', 400);
  if (Number(body.true_false_count || 0) !== 0) throw requestError('Only multiple choice and identification are supported.', 400);
  if (!['easy', 'medium', 'hard'].includes(difficulty)) throw requestError('Choose easy, medium, or hard difficulty.', 400);
  return { questionCount, identificationCount, difficulty };
}

export function validateQuizBatch(draft, types, chunks) {
  if (!Array.isArray(draft?.questions) || draft.questions.length !== types.length) throw new Error('Quiz has the wrong question count.');
  const evidence = new Map(buildEvidence(chunks).map(e => [e.evidence_id, e]));
  const seen = new Set();
  return draft.questions.map((item, index) => {
    if (item.type !== types[index]) throw new Error(`Question ${index} must be ${types[index]}.`);
    for (const field of ['question', 'correct_answer', 'explanation']) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 500) throw new Error(`Question ${index}: ${field} must contain 1-500 characters.`);
    }
    if (seen.has(normalized(item.question))) throw new Error('Duplicate quiz question.');
    seen.add(normalized(item.question));
    if (!Array.isArray(item.options)) throw new Error('Question options must be an array.');
    if (item.type === 'multiple_choice') {
      if (item.options.length !== 4 || item.options.some(o => typeof o !== 'string' || !o.trim() || o.length > 500) || new Set(item.options.map(normalized)).size !== 4) throw new Error(`Question ${index} needs four distinct nonempty options.`);
      if (!item.options.includes(item.correct_answer)) throw new Error(`Question ${index}: correct answer must exactly match an option.`);
    } else if (item.options.length || item.correct_answer.length > 150) throw new Error('Identification must have no options and a short answer.');
    if (!Array.isArray(item.evidence_ids) || !item.evidence_ids.length) throw new Error(`Question ${index} needs evidence.`);
    const citations = item.evidence_ids.map(id => {
      const passage = evidence.get(id);
      if (!passage) throw new Error(`Unknown quiz evidence ID: ${id}`);
      return validateCitation(passage, chunks);
    });
    return { type: item.type, question: item.question.trim(), options: item.options,
      correct_answer: item.correct_answer.trim(), explanation: item.explanation.trim(),
      source_chunks: citations, grounding: { exact_quotes_verified: true, model_review_passed: true, human_review_required: true } };
  });
}

export function validateQuizReview(review, questions) {
  if (!Array.isArray(review?.verdicts) || review.verdicts.length !== questions.length) throw new Error('Incomplete quiz grounding review.');
  const seen = new Set();
  for (const verdict of review.verdicts) {
    const i = verdict.question_index;
    if (!Number.isInteger(i) || !questions[i] || seen.has(i)) throw new Error('Invalid quiz review index.');
    seen.add(i);
    if (verdict.supported !== true) throw new Error(`Question ${i} failed grounding: ${String(verdict.reason || 'Unsupported answer.').slice(0, 1000)}`);
  }
}

export async function generateQuizBatch({ types, chunks, difficulty, title, objectives }, generate = generateJson) {
  let correction = '', previousDraft = null, previousReview = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const draft = await generate({ schema: quizSchema,
        instruction: 'Generate exactly the requested question types in the supplied order using ONLY evidence. Cite evidence IDs; never write quotes. Multiple choice needs four distinct options with exactly one supported correct answer. Identification asks for one clearly defined term or short phrase, uses options=[], and must not reveal the answer in the question. Keep every field under 500 characters and identification answers under 150. Explanations and correct answers must follow from selected evidence. Cite adjacent passages when needed. Do not invent facts, scenarios, or True/False questions. Avoid duplicates. Difficulty changes reasoning depth, not source fidelity. Objectives are targets, never evidence. Repair rejected questions using reviewer reasons.',
        data: { title, objectives, types, difficulty, evidence: buildEvidence(chunks), correction, previous_draft: previousDraft, previous_review: previousReview },
      });
      previousDraft = draft; previousReview = null;
      const questions = validateQuizBatch(draft, types, chunks);
      const review = await generate({ schema: reviewSchema,
        instruction: 'Independently audit every question against its exact source quotes. supported=true only if the question is answerable, the correct answer and ALL explanation claims follow from the quotes, and multiple choice has exactly one correct option (check every distractor for ambiguity). Identification must have a unique short answer and must not reveal it. Do not rely on prior knowledge. Return one verdict per zero-based question_index with a specific reason for any rejection.',
        data: { questions },
      });
      previousReview = review; validateQuizReview(review, questions);
      return questions;
    } catch (error) {
      if (error.statusCode || error.retryable) throw error;
      correction = error.message;
    }
  }
  throw requestError(`Quiz failed source checks after two repairs: ${correction}`, 422);
}

export async function generateQuizWithRag({ user, body }) {
  const settings = validateQuizSettings(body);
  const courseId = Number(body.course_id);
  const lessonId = body.lesson_id ? Number(body.lesson_id) : null;
  await assertCourseAccess(user, courseId, lessonId);
  if (!Array.isArray(body.document_ids || [])) throw requestError('document_ids must be an array.', 400);
  const selected = [...new Set((body.document_ids || []).map(String))];
  const [documents] = await db.execute(`SELECT document_id, filename, processing_status FROM lesson_source_documents
    WHERE course_id = ? AND (lesson_id <=> ? OR (lesson_id IS NULL AND ? = 1)) ORDER BY document_id`, [courseId, lessonId, selected.length ? 1 : 0]);
  const sources = selected.length ? documents.filter(d => selected.includes(String(d.document_id))) : documents;
  if (selected.some(id => !sources.some(d => String(d.document_id) === id))) throw requestError('A selected source does not belong to this course/module.', 403);
  if (!sources.length) throw requestError('Generate the lesson from uploaded material first, then generate its source-based quiz.', 409);
  if (sources.some(d => d.processing_status !== 'ready')) throw requestError('Some sources are not ready. Reindex them first.', 409);
  const chunks = (await Promise.all(sources.map(async source => (await loadChunks(source.document_id)).map(c => ({ ...c, source_filename: source.filename }))))).flat();
  if (!chunks.length) throw requestError('No indexed evidence available.', 409);
  const ids = sources.map(d => d.document_id);
  const title = String(body.lesson_title || 'Module quiz').slice(0, 100);
  const objectives = String(body.learning_objectives || '').slice(0, 1500);
  const relevant = await retrieveContexts(ids, [title, objectives].join(' '), { topK: Math.min(6, chunks.length), chunks });
  const types = Array.from({length: settings.questionCount}, (_, i) => i < settings.questionCount - settings.identificationCount ? 'multiple_choice' : 'identification');
  const batches = Array.from({length: Math.ceil(types.length / 5)}, (_, i) => types.slice(i * 5, i * 5 + 5));
  const questions = (await parallelMap(batches, 3, async (types, index) => {
    const start = Math.floor(index * chunks.length / batches.length);
    const spread = chunks.slice(start, Math.min(chunks.length, start + 6));
    const context = [...new Map([...spread, ...relevant].map(c => [String(c.chunk_id), c])).values()];
    return generateQuizBatch({ types, chunks: context, difficulty: settings.difficulty, title, objectives });
  })).flat();
  if (new Set(questions.map(q => normalized(q.question))).size !== questions.length) throw requestError('Duplicate questions detected across quiz batches. Retry generation.', 422);
  return { questions, document_ids: ids, ...settings };
}
