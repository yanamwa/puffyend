import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../../src/controllers/courseController.js",import.meta.url),"utf8");
const start = source.indexOf("function validateCourse(fields)");
const end = source.indexOf("function duplicateCourseCode",start);
const validate = vm.runInNewContext(`(${source.slice(start,end).trim()})`);
const course = {courseCode:"PB-TEST",title:"Course",summary:"Description",subject:"Subject",status:"published",learningObjectives:"",lessonPages:[],contentModules:[{title:"Module 1",learningObjectives:"",lessonPages:[]},{title:"Module 2",learningObjectives:"",lessonPages:[]}]};
test("published courses accept empty modules and progressive lesson uploads",()=>{
 assert.equal(validate(course),"");
 assert.equal(validate({...course,lessonPages:[{content:"Lesson"}],contentModules:[{...course.contentModules[0],lessonPages:[{content:"Lesson"}]},course.contentModules[1]]}),"");
});
test("publication still requires basic course details and module titles",()=>{
 assert.match(validate({...course,title:""}),/title/);
 assert.match(validate({...course,summary:""}),/description/);
 assert.match(validate({...course,contentModules:[{title:""}]}),/module.*title/);
});
