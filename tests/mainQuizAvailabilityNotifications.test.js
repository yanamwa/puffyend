import test from "node:test";
import assert from "node:assert/strict";
import { quizOpening, checkMainQuizOpenings } from "../src/services/mainQuizAvailabilityNotifications.js";
test("enable, publication, scheduled open and close", () => {
 const now=Date.parse("2026-10-30T10:00:00Z");
 const m={mainQuizSettings:{enabled:true,unlockAt:"2026-10-30T09:00:00Z",lockAt:"2026-10-30T11:00:00Z"}};
 assert.equal(quizOpening(m,now).available,true);
 assert.equal(quizOpening({...m,studentPublished:false},now).available,false);
 assert.equal(quizOpening({mainQuizSettings:{enabled:false}},now).available,false);
 assert.equal(quizOpening(m,now-7200000).available,false);
 assert.equal(quizOpening(m,now+7200000).available,false);
});
test("one notification and email per opening; startup skips existing open quizzes", async()=>{
 let state,delivery,enabled=false,notices=0,emails=0;
 const database={query:async()=>[[{course_id:1,title:"Course",content_modules:JSON.stringify([{id:"m",title:"Module",mainQuizSettings:{enabled}}])}]],execute:async(sql,v)=>{
 if(sql.startsWith("SELECT *"))return [[...(state?[state]:[])]];
 if(sql.startsWith("INSERT IGNORE INTO main_quiz_availability_state"))state={available:v[2],schedule_key:v[3],activation_id:null};
 if(sql.startsWith("UPDATE main_quiz_availability_state"))state={available:v[0],schedule_key:v[1],activation_id:v[2]};
 if(sql.startsWith("SELECT DISTINCT"))return [[{userId:1,email:"student@example.test"}]];
 if(sql.startsWith("INSERT IGNORE INTO main_quiz_availability_delivery"))delivery||={notification_id:null,email_sent:false};
 if(sql.startsWith("SELECT notification_id"))return [[{...delivery}]];
 if(sql.startsWith("UPDATE main_quiz_availability_delivery SET notification_id"))delivery.notification_id=v[0];
 if(sql.startsWith("UPDATE main_quiz_availability_delivery SET email_sent"))delivery.email_sent=true;
 return [{}];}};
 const deps={database,notify:async()=>{notices++;return{notificationId:1};},sendEmail:async()=>{emails++;}};
 await checkMainQuizOpenings(deps);enabled=true;
 await checkMainQuizOpenings(deps);await checkMainQuizOpenings(deps);
 assert.equal(notices,1);assert.equal(emails,1);
 state=undefined;delivery=undefined;await checkMainQuizOpenings(deps);assert.equal(notices,1);
});
