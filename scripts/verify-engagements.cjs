// Exercises actual Temporal workflows and API decisions in an isolated database schema.
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {Pool}=require('pg');
(async()=>{
 const root=process.env.ENGINE_DIST||'/app/dist';const schema='engagement_check_'+Date.now();const admin=new Pool({connectionString:process.env.DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
 for(const t of tables)await admin.query(`CREATE TABLE ${schema}."${t.tablename}" (LIKE public."${t.tablename}" INCLUDING ALL)`);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();process.env.TEMPORAL_TASK_QUEUE=schema;
 const {pool}=require(root+'/packages/database/src');const {Client,Connection,WorkflowExecutionAlreadyStartedError}=require('@temporalio/client');const {Worker,NativeConnection}=require('@temporalio/worker');const {createActivities}=require(root+'/packages/temporal/src/activities');const {ToolRegistry,MockModelProvider}=require(root+'/packages/engine/src');const {tickEngagement,isRunPaused,shouldImportRun}=require(root+'/packages/engine/src/engagement');const {createWorkspaceActivities}=require(root+'/packages/temporal/src/activities/workspace');
 const connection=await Connection.connect({address:process.env.TEMPORAL_ADDRESS}),native=await NativeConnection.connect({address:process.env.TEMPORAL_ADDRESS}),client=new Client({connection});
 const app=require('fastify')();require(root+'/apps/api/src/engagements').registerEngagements(app,client);await app.ready();
 async function api(path,body,status=200){const r=await app.inject({url:path,method:body?'POST':'GET',payload:body});assert.equal(r.statusCode,status,r.body);return r.json()}
 const org=randomUUID(),customer=randomUUID(),agent=randomUUID(),skill=randomUUID(),sv=randomUUID();
 await pool.query("INSERT INTO organization(id,name,kind) VALUES($1,'Fixture platform','platform'),($2,'Fixture customer','customer')",[org,customer]);
 await pool.query("INSERT INTO agent(id,organization_id,name,instructions) VALUES($1,$2,'Fixture','Use fixture data')",[agent,org]);
 await pool.query("INSERT INTO skill(id,organization_id,name,slug) VALUES($1,$2,'Fixture','fixture')",[skill,org]);
 await pool.query("INSERT INTO skill_version(id,skill_id,version,instructions,execution_type,configuration) VALUES($1,$2,1,'Fixture','llm',$3)",[sv,skill,JSON.stringify({mockResponse:{summary:'Synthetic findings'}})]);
 const stages=[];
 for(const name of ['Understand','Research']){const w=randomUUID(),v=randomUUID();await pool.query('INSERT INTO workflow(id,organization_id,name,slug) VALUES($1,$2,$3,$4)',[w,org,name,'stage-'+w]);await pool.query("INSERT INTO workflow_version(id,workflow_id,version,goal,sop_markdown,created_by,input_schema,output_schema) VALUES($1,$2,1,'Fixture','Fixture','test',$3,$3)",[v,w,JSON.stringify({type:'object'})]);await pool.query('UPDATE workflow SET current_version_id=$2 WHERE id=$1',[w,v]);await pool.query("INSERT INTO workflow_step(workflow_version_id,key,name,position,type,skill_version_id,configuration) VALUES($1,'fixture','Fixture',0,'skill',$2,$3)",[v,sv,JSON.stringify({builderAgentId:agent})]);stages.push({name,workflowId:w});}
 const t=await api('/engagement-templates',{organizationId:org,name:'Isolated chain',stages});
 let imported=0;const workspace=createWorkspaceActivities();const worker=await Worker.create({connection:native,taskQueue:schema,workflowsPath:root+'/packages/temporal/src/workflows/agent-run.js',activities:{...createActivities(new ToolRegistry(),new MockModelProvider()),resolveRunOrganization:async()=>({state:'resolved'}),tickEngagement,isRunPaused,shouldImportRun,prepareRunKnowledgeJob:workspace.prepareRunKnowledgeJob,executeWorkspaceJob:async id=>{imported++;await pool.query("UPDATE workspace_job SET state='completed',result=$2 WHERE id=$1",[id,JSON.stringify({count:1,proposalIds:[]})])},failWorkspaceJob:workspace.failWorkspaceJob}});
 let timer;const dispatch=async()=>{for(const r of (await pool.query("SELECT * FROM run WHERE status='pending'")).rows){try{await client.workflow.start('AgentRunWorkflow',{workflowId:r.temporal_workflow_id,taskQueue:schema,args:[{runId:r.id,input:r.input,workflowVersionId:r.workflow_version_id}],workflowIdReusePolicy:'REJECT_DUPLICATE'})}catch(e){if(!(e instanceof WorkflowExecutionAlreadyStartedError))throw e}}};
 async function wait(id,predicate){for(let i=0;i<180;i++){await dispatch();const e=await api('/engagements/'+id);if(predicate(e))return e;await new Promise(r=>setTimeout(r,500))}throw Error('Timed out waiting for engagement')}
 try{await worker.runUntil(async()=>{
 const e=await api('/engagements',{templateId:t.id,name:'Isolated check',input:{company_name:'Fixture'},customerOrganizationId:customer});
 let state=await wait(e.id,x=>x.state==='awaiting_approval');assert.equal(imported,0,'Unapproved results must not be imported');let a=state.attempts.at(-1);const oldId=a.id;
 await api('/engagements/'+e.id+'/decision',{attemptId:a.id,action:'pause'});assert.equal(await isRunPaused(a.run_id),true);
 await api('/engagements/'+e.id+'/decision',{attemptId:a.id,action:'approve'},400);
 await api('/engagements/'+e.id+'/decision',{attemptId:a.id,action:'resume'});
 await api('/engagements/'+e.id+'/decision',{attemptId:a.id,action:'revise',feedback:'Use a narrower customer segment',source:'customer'});
 state=await wait(e.id,x=>x.state==='awaiting_approval'&&x.attempts.length===2);a=state.attempts.at(-1);assert.equal(a.revision,2);
 const r=(await pool.query('SELECT input,customer_organization_id,workflow_version_id FROM run WHERE id=$1',[a.run_id])).rows[0];assert.equal(r.customer_organization_id,customer);assert.equal(r.input.engagement.feedback[0].source,'customer');assert.equal(r.input.engagement.revisionOf.runId,state.attempts[0].run_id);
 await api('/engagements/'+e.id+'/decision',{attemptId:oldId,action:'approve'},400);
 const decision={attemptId:a.id,action:'approve'};await api('/engagements/'+e.id+'/decision',decision);await api('/engagements/'+e.id+'/decision',decision);
 state=await wait(e.id,x=>x.stage_index===1&&x.state==='awaiting_approval');assert.equal(state.attempts.length,3);assert.equal(imported,1);a=state.attempts.at(-1);
 const next=(await pool.query('SELECT input,customer_organization_id FROM run WHERE id=$1',[a.run_id])).rows[0];assert.equal(next.customer_organization_id,customer);assert.equal(next.input.engagement.approvedPreviousStage.runId,state.attempts[1].run_id);
 await api('/engagements/'+e.id+'/decision',{attemptId:a.id,action:'approve'});state=await wait(e.id,x=>x.state==='completed');assert.equal(imported,2);
 await client.workflow.getHandle('engagement:'+e.id).result();console.log('PASS Temporal chaining, revision history, pause/resume, stale approval rejection, duplicate approval dedupe, customer binding and knowledge-before-handoff');
 });}finally{await app.close();await connection.close();await native.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
})().catch(e=>{console.error(e);process.exitCode=1});
