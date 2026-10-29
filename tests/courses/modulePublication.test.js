import test from "node:test";
import assert from "node:assert/strict";
import { studentCourseContent } from "../../src/services/courses/modulePublication.js";
test("only uploaded module content reaches students, while module order stays stable",()=>{
 const course={contentModules:[{id:"a",studentPublished:true,lessonPages:[{content:"A"}]},{id:"b",studentPublished:false,lessonPages:[{content:"SECRET"}],quizItems:[{question:"SECRET"}]}],lessonPages:[{moduleId:"a",content:"A"},{moduleId:"b",content:"SECRET"}],quizItems:[{moduleIndex:1,question:"SECRET"}]};
 const result=studentCourseContent(course);
 assert.equal(result.contentModules.length,2);
 assert.equal(result.contentModules[1].id,"b");
 assert.deepEqual(result.contentModules[1].lessonPages,[]);
 assert.equal(result.lessonPages.length,1);
 assert.equal(result.quizItems.length,0);
 assert.ok(!JSON.stringify(result).includes("SECRET"));
 assert.equal(course.contentModules[1].lessonPages.length,1);
});
test("legacy courses retain their content and empty uploaded modules are supported",()=>{
 const legacy={contentModules:[{id:"a",lessonPages:[]}]};
 assert.equal(studentCourseContent(legacy),legacy);
 const result=studentCourseContent({contentModules:[{id:"a",studentPublished:true,lessonPages:[]}]});
 assert.equal(result.contentModules[0].studentPublished,true);
});
