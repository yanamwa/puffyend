import test from "node:test";
import assert from "node:assert/strict";
import {generateCatalogModule} from "../../src/services/catalog/catalogLessonGeneration.js";
test("module lessons use reviewed title, remain marked as drafts and reject empty AI output",async()=>{
 const module={title:"Introduction to Programming",source_page:4};
 const result=await generateCatalogModule({code:"DCIT24A",title:"Programming",description:"Basics"},module,async request=>{
  assert.equal(request.data.module_title,module.title);
  return {description:"Introduction",learning_objectives:"Explain variables",topics:["Variables"],lesson_pages:[{title:"Variables",content:"A variable stores a value."}],quiz_items:Array.from({length:5},(_,i)=>({question:`Question ${i+1}`,type:"multiple_choice",options:["A","B","C","D"],correct_answer:"A",explanation:"Explanation"}))};
 });
 assert.equal(result.generated_draft,true);
 assert.equal(result.title,module.title);
 assert.equal(module.lesson_pages,undefined);
 assert.equal(result.lesson_pages.length,1);
 assert.equal(result.quiz_items.length,5);
 await assert.rejects(generateCatalogModule({},module,async()=>({lesson_pages:[]})),/incomplete/);
});
