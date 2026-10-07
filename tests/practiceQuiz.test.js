import assert from 'node:assert/strict';
import { validateQuizSettings, validateQuizBatch, generateQuizBatch } from '../src/services/rag/quizRagService.js';
const settings = { assessment_type: 'practice', question_count: 20, multiple_choice_count: 10, identification_count: 5, true_false_count: 5, lots_count: 12, hots_count: 8 };
assert.equal(validateQuizSettings(settings).hotsCount, 8);
for (const change of [{ multiple_choice_count: 9 }, { lots_count: 11 }, { hots_count: -1 }, { true_false_count: 4.5 }]) assert.throws(() => validateQuizSettings({ ...settings, ...change }));
assert.deepEqual(validateQuizSettings({}), { questionCount: 5, identificationCount: 0, difficulty: 'medium' });
const chunks = [{ chunk_id: 1, chunk_text: 'Plants use sunlight to produce their food through photosynthesis.', document_id: 1, source_filename: 'lesson.txt' }];
const question = { type: 'true_false', question: 'Plants use sunlight to produce food.', options: ['True', 'False'], correct_answer: 'True', explanation: 'Photosynthesis uses sunlight.', topic: 'Photosynthesis', cognitive_level: 'Understand', thinking_skill: 'LOTS', evidence_ids: ['c1-e0'] };
assert.equal(validateQuizBatch({ questions: [question] }, ['true_false'], chunks, ['LOTS'])[0].topic, 'Photosynthesis');
for (const change of [{ options: ['False', 'True'] }, { correct_answer: 'yes' }, { thinking_skill: 'HOTS' }, { cognitive_level: 'Evaluate' }, { topic: '' }, { evidence_ids: ['unknown'] }]) assert.throws(() => validateQuizBatch({ questions: [{ ...question, ...change }] }, ['true_false'], chunks, ['LOTS']));
let calls = 0;
const generated = await generateQuizBatch({ types: ['true_false'], skills: ['LOTS'], chunks, title: 'Plants', objectives: 'Understand photosynthesis' }, async request => {
 calls++;
 if (request.schema.properties.questions) { assert.match(request.instruction, /educational practice quiz generator/); return { questions: [question] }; }
 return { verdicts: [{ question_index: 0, supported: true, reason: 'Supported' }] };
});
assert.equal(calls, 2);
assert.equal(generated[0].thinking_skill, 'LOTS');
console.log('Practice settings, metadata, True/False, evidence, and generation/review checks passed.');

