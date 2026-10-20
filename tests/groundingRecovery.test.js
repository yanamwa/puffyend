import test from "node:test";
import assert from "node:assert/strict";
import { generateGroundedPage } from "../src/services/rag/groundingService.js";
const topic={title:"Roles",key_points:[{id:"p1",text:"First role"},{id:"p2",text:"Second role"}]};
const context=[{chunk_id:1,chunk_text:"The controller determines the purpose. The processor follows instructions."}];
const statement=(id,text)=>({text,point_ids:[id],evidence_ids:["c1-e0"]});
test("repairs only failed points while retaining approved text and verifying the entire final page",async()=>{
 let call=0;
 const result=await generateGroundedPage(topic,context,async request=>{
  call++;
  if(call===1)return {title:"Roles",statements:[statement("p1","The controller determines the purpose."),statement("p2","There are three roles.")]};
  if(call===2)return {verdicts:[{statement_index:0,supported:true,covered_point_ids:["p1"]},{statement_index:1,supported:false,covered_point_ids:[],reason:"Unsupported count"}]};
  if(call===3){assert.deepEqual(request.data.topic.key_points.map(p=>p.id),["p2"]);return {title:"Roles",statements:[statement("p2","The processor follows instructions.")]};}
  assert.equal(request.data.statements.length,2);
  assert.equal(request.data.statements[0].text,"The controller determines the purpose.");
  return {verdicts:[{statement_index:0,supported:true,covered_point_ids:["p1"]},{statement_index:1,supported:true,covered_point_ids:["p2"]}]};
 });
 assert.equal(result.grounding.model_review_passed,true);
 assert.deepEqual(result.covered_point_ids,["p1","p2"]);
 assert.doesNotMatch(result.content,/three roles/);
});
test("exhausted repairs return a short actionable message without accepting unsupported content",async()=>{
 const generate=async request=>request.schema.properties.verdicts?{verdicts:[{statement_index:0,supported:false,covered_point_ids:[],reason:"Unsupported technical details"}]}:{title:"Roles",statements:[{text:"Unsupported claim",point_ids:["p1","p2"],evidence_ids:["c1-e0"]}]};
 await assert.rejects(generateGroundedPage(topic,context,generate),error=>error.statusCode===422&&error.code==="LESSON_GROUNDING_FAILED"&&error.message.includes("uploaded files are still available")&&!error.message.includes("Unsupported technical details"));
});
