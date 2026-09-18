// Isolated database contract checks: no customer changes or external model calls.
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {Pool}=require('pg');
(async()=>{
 const root=process.env.ENGINE_DIST||'/app/dist',schema='products_check_'+Date.now(),admin=new Pool({connectionString:process.env.DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();
 const {pool}=require(root+'/packages/database/src');
 let committed='';const forgejo=require(root+'/packages/engine/src/forgejo');forgejo.commitDocument=async(org,id,text)=>{committed=text;return {fileSha:'fixture-file',commitSha:'fixture-commit',path:'documents/'+id+'.md'}};
 const {createChange,applyChange,workspaceContext}=require(root+'/packages/engine/src/workspace-service');const {organizationProducts,requireProduct}=require(root+'/packages/engine/src/organization-products');
 const org=randomUUID(),other=randomUUID(),platform=randomUUID();
 try{
 await pool.query("INSERT INTO organization(id,name,kind) VALUES($1,'Fixture A','customer'),($2,'Fixture B','customer'),($3,'Fixture platform','platform')",[org,other,platform]);
 const proposal=await createChange({organizationId:org,kind:'product',title:'Fixture product',reason:'Synthetic test',body:{name:'Fixture calculator',brief:'Synthetic calculator',productId:null}});
 await assert.rejects(applyChange(proposal.id,org),/Approve/);
 await pool.query("UPDATE workspace_change SET state='approved' WHERE id=$1",[proposal.id]);
 await applyChange(proposal.id,org);await applyChange(proposal.id,org);
 let products=await organizationProducts(org);assert.equal(products.length,1);const productId=products[0].id;
 assert.equal(products[0].latestBuild.state,'pending');assert.equal((await organizationProducts(other)).length,0);
 await assert.rejects(requireProduct(other,productId),/not found/);
 await assert.rejects(createChange({organizationId:other,kind:'product',title:'Invalid',reason:'Test',body:{name:'Invalid',brief:'Test',productId}}),/not found/);
 await assert.rejects(createChange({organizationId:platform,kind:'product',title:'Invalid',reason:'Test',body:{name:'Invalid',brief:'Test'}}),/customer organization/);
 await pool.query("UPDATE code_build SET state='completed',result=$2 WHERE id=$1",[productId,JSON.stringify({previewUrl:'http://localhost:3002/'+productId+'/'})]);
 const revision=await createChange({organizationId:org,kind:'product',title:'Revise',reason:'Feedback',body:{name:'Fixture calculator',brief:'Add a reset button',productId}});
 const stale=await createChange({organizationId:org,kind:'product',title:'Stale',reason:'Feedback',body:{name:'Fixture calculator',brief:'Different revision',productId}});
 await pool.query("UPDATE workspace_change SET state='approved' WHERE id=ANY($1::uuid[])",[[revision.id,stale.id]]);
 await applyChange(revision.id,org);await applyChange(revision.id,org);
 await assert.rejects(applyChange(stale.id,org),/Product changed/);
 products=await organizationProducts(org);assert.equal(products.length,1);assert.equal(products[0].versions.length,2);assert.equal(products[0].previewBuild.id,productId);
 const noteBody={title:'Product feedback',category:'notes',content:'Please add a reset button.',evidence:'customer_confirmed',relatedIds:[],productId};
 await assert.rejects(createChange({organizationId:other,kind:'knowledge',title:'Wrong org',reason:'Test',body:noteBody}),/not found/);
 const note=await createChange({organizationId:org,kind:'knowledge',title:'Feedback',reason:'Customer request',body:noteBody});await pool.query("UPDATE workspace_change SET state='approved' WHERE id=$1",[note.id]);await applyChange(note.id,org);
 const context=await workspaceContext(org);const doc=context.documents.find(d=>d.id===note.targetId);assert.equal(doc.provenance.productId,productId);assert.match(committed,new RegExp(productId));
 const kb=(await pool.query('SELECT metadata FROM knowledge WHERE id=$1',[note.targetId])).rows[0];assert.equal(kb.metadata.provenance.productId,productId);
 if(process.env.VERIFY_PRODUCT_MODEL==='1') {
  const thread=randomUUID(),message=randomUUID(),job=randomUUID();
  await pool.query("INSERT INTO workspace_thread(id,organization_id,title,scope) VALUES($1,$2,'Synthetic product check','knowledge')",[thread,org]);
  await pool.query("INSERT INTO workspace_message(id,thread_id,role,content) VALUES($1,$2,'user',$3)",[message,thread,'Use only this synthetic fixture data. Show the existing product preview link. Capture a NEW note for the selected product: a reset button is wanted. Also propose a NEW separate product named Fixture tip calculator: a static page with bill amount and tip percentage inputs, calculate button, visible tip and total, and synthetic labeling. Do not revise the pending product or replace existing documents.']);
  const {assistantTurn}=require(root+'/packages/engine/src/workspace-assistant');
  await assistantTurn(org,job,{threadId:thread,messageId:message,productId},AbortSignal.timeout(120000));
  const answer=(await pool.query("SELECT content,metadata FROM workspace_message WHERE thread_id=$1 AND role='assistant'",[thread])).rows[0];
  assert.equal(answer.metadata.proposalErrors.length,0,JSON.stringify(answer.metadata.proposalErrors));
  const changes=(await pool.query("SELECT kind,body FROM workspace_change WHERE source_key LIKE $1",['assistant:'+job+':%'])).rows;
  assert(changes.some(c=>c.kind==='product'&& !c.body.productId));
  assert(changes.some(c=>c.kind==='knowledge'&&c.body.productId===productId));
  assert(answer.metadata.productIds.includes(productId),'Assistant must attach the selected product preview card');
  console.log('PASS live assistant: grounded product preview card, new product proposal, and product-linked knowledge capture. Synthetic data only.');
 }
 console.log('PASS: approval gating, build deduplication, organization isolation, immutable version grouping, stale revision rejection, retained preview, and canonical product feedback in organization knowledge + Forgejo markdown.');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
})().catch(e=>{console.error(e);process.exitCode=1});
