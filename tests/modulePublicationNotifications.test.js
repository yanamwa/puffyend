import test from "node:test";
import assert from "node:assert/strict";
import { checkModulePublications } from "../src/services/modulePublicationNotifications.js";
test("one notification and email per opening; startup skips existing open quizzes", async()=>{
 let state,delivery,enabled=false,notices=0,emails=0;
 const database={query:async()=>[[{course_id:1,title:"Course",content_modules:JSON.stringify([{id:"m",title:"Module",studentPublished:enabled}])}]],execute:async(sql,v)=>{
 if(sql.startsWith("SELECT *"))return [[...(state?[state]:[])]];
 if(sql.startsWith("INSERT IGNORE INTO module_publication_state"))state={available:v[2],schedule_key:v[3],activation_id:null};
 if(sql.startsWith("UPDATE module_publication_state"))state={available:v[0],schedule_key:v[1],activation_id:v[2]};
 if(sql.startsWith("SELECT DISTINCT"))return [[{userId:1,email:"student@example.test"}]];
 if(sql.startsWith("INSERT IGNORE INTO module_publication_delivery"))delivery||={notification_id:null,email_sent:false};
 if(sql.startsWith("SELECT notification_id"))return [[{...delivery}]];
 if(sql.startsWith("UPDATE module_publication_delivery SET notification_id"))delivery.notification_id=v[0];
 if(sql.startsWith("UPDATE module_publication_delivery SET email_sent"))delivery.email_sent=true;
 return [{}];}};
 const deps={database,notify:async()=>{notices++;return{notificationId:1};},sendEmail:async()=>{emails++;}};
 await checkModulePublications(deps);enabled=true;
 await checkModulePublications(deps);await checkModulePublications(deps);
 assert.equal(notices,1);assert.equal(emails,1);
 state=undefined;delivery=undefined;await checkModulePublications({...deps,baseline:true});assert.equal(notices,1);
});
