/** Synthetic local smoke test. Run inside the new API pod; no real contacts or model requests. */
const assert = require('node:assert/strict');
const {Client,Connection}=require('@temporalio/client');
const {connectionOptions,namespace}=require('../packages/temporal/src/config');
const org='a78a95d8-c6f4-4a84-9eaa-a383981145f9';
const base='http://api-next:3000',portal='http://customer-portal:3000',mail='http://mailpit:8025';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function req(origin,path,body,headers={}) {
 const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const value=await r.json();assert(r.ok,JSON.stringify({path,status:r.status,error:value.error}));return {r,value};
}
(async()=>{
 const state=(await req(base,`/participation/${org}`)).value;
 let person=state.people.find(p=>p.email==='demo.contact@example.invalid');
 if(!person) person=(await req(base,`/participation/${org}/people`,{name:'Demo Contact',email:'demo.contact@example.invalid',role:'Primary contact',primaryContact:true,evidence:'Synthetic local demonstration.'})).value;
 const question=(await req(base,`/participation/${org}/questions`,{title:'What should the demonstration product help your team do?',detail:'This is a synthetic local check of the invitation and review flow.',why:'Verify the workflow waits for reviewed customer input.',assignedPersonId:person.id,priority:'high'})).value;
 const connection=await Connection.connect(connectionOptions());const client=new Client({connection,namespace});
 const handle=await client.workflow.start('WaitForParticipationQuestionWorkflow',{workflowId:'portal-smoke:'+question.id,taskQueue:'agent-engine-platform',args:[{questionId:question.id,organizationId:org}]});
 const invitation=(await req(base,`/participation/${org}/people/${person.id}/send-invite`,{})).value;
 let message;
 for(let i=0;i<25;i++){
   const fresh=(await req(base,`/participation/${org}`)).value;
   if(fresh.deliveries.find(x=>x.id===invitation.id)?.state==='sent'){
     const messages=(await req(mail,'/api/v1/messages')).value.messages;
     const found=messages.find(x=>x.To?.some(p=>p.Address==='demo.contact@example.invalid'));
     if(found){message=(await req(mail,'/api/v1/message/'+found.ID)).value;break;}
   }
   await pause(1000);
 }
 assert(message,'Mailpit did not capture invitation');
 const invitationUrl=message.Text.match(/http:\/\/localhost:3005\/customer#invite=[A-Za-z0-9_-]+/)?.[0];assert(invitationUrl,'Mailpit invitation link missing');
 const token=new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('invite');
 const redeemed=await req(portal,'/customer-api/redeem',{token});
 const cookies=redeemed.r.headers.getSetCookie().map(c=>c.split(';')[0]);
 const csrf=cookies.find(c=>c.startsWith('revos_customer_csrf=')).split('=')[1];
 const headers={cookie:cookies.join('; '),'x-csrf-token':csrf,origin:'http://localhost:3005'};
 const customer=(await req(portal,'/customer-api/me',undefined,headers)).value;
 assert(customer.questions.some(q=>q.id===question.id));
 assert.equal((await fetch(portal+'/workflows')).status,404);
 assert.equal((await fetch(portal+'/workspace/'+org+'/state')).status,404);
 const denied=await fetch(portal+'/customer-api/questions/'+question.id+'/answer',{method:'POST',headers:{'content-type':'application/json',cookie:headers.cookie},body:JSON.stringify({content:'Must be rejected without CSRF',questionRevision:1})});assert.equal(denied.status,403);
 assert.equal((await handle.describe()).status.name,'RUNNING');
 const answer=(await req(portal,'/customer-api/questions/'+question.id+'/answer',{content:'Help the team collect stakeholder feedback and track reviewed requirements. This is synthetic demo data.',questionRevision:1},headers)).value;
 assert.equal((await handle.describe()).status.name,'RUNNING','Submission alone must not resume workflow');
 await req(base,`/participation/${org}/questions/${question.id}/review`,{action:'accept',answerId:answer.id,expectedRevision:1,reviewer:'Local demo reviewer',comment:'Verified synthetic demonstration answer.'});
 const reviewed=await handle.result();assert.equal(reviewed.state,'accepted');assert.equal(reviewed.answer.id,answer.id);assert.equal(reviewed.answer.personId,person.id);
 let saved;
 for(let i=0;i<25;i++){const fresh=(await req(base,`/participation/${org}`)).value;saved=fresh.questions.find(q=>q.id===question.id);if(saved.knowledge_state==='applied')break;await pause(1000);}
 assert.equal(saved.knowledge_state,'applied','Accepted answer should reach Forgejo-backed knowledge');
 const replay=await fetch(portal+'/customer-api/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});assert.equal(replay.status,401);
 console.log(JSON.stringify({passed:true,organizationId:org,personId:person.id,questionId:question.id,checks:['Mailpit capture','private portal','CSRF','one-use link','durable review wait','attributed resume','Forgejo knowledge publication']}));
 await connection.close();
})().catch(e=>{console.error(e.message);process.exitCode=1;});
