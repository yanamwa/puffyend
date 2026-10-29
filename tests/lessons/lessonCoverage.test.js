import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoverageModules } from '../../src/services/catalog/catalogRules.js';
import { generationContext } from '../../src/services/rag/generationContext.js';
test('reviewed coverage preserves topics and objectives and rejects malformed topics', () => {
 const input = [{title:'Programming', topics:[' Variables ', ''], learning_objectives:' Explain variables '}];
 assert.deepEqual(validateCoverageModules(input), [{title:'Programming',source_page:null,topics:['Variables'],learning_objectives:'Explain variables'}]);
 assert.throws(() => validateCoverageModules([{title:'Programming',topics:[{}]}]));
});
test('generation coverage is bounded and independent of reference evidence', () => {
 assert.deepEqual(generationContext('{"module_title":" Programming ","topics":[" Variables "]}'), {module_title:'Programming',topics:['Variables'],learning_objectives:'',instructions:''});
 for (const value of ['{', '[]', '{"topics":[5]}', JSON.stringify({instructions:'x'.repeat(15001)})]) assert.throws(() => generationContext(value), {statusCode:400});
 assert.equal(generationContext(null), null);
});
