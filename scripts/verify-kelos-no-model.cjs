// Run inside worker-platform with explicit synthetic identity; never contacts a model.
// kubectl exec -i deployment/worker-platform -- node - ORG PRODUCT < this-file
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {pool}=require(process.cwd()+'/dist/packages/database/src');
const {createCodeBuild}=require(process.cwd()+'/dist/packages/engine/src/code-builds');
const {saveServiceConfig}=require(process.cwd()+'/dist/packages/engine/src/service-delivery');
const {Connection,Client}=require('@temporalio/client');
const {connectionOptions,namespace,taskQueue}=require(process.cwd()+'/dist/packages/temporal/src/config');
async function main(){
 const [org,product]=process.argv.slice(2);if(!org||!product)throw Error('Supply a synthetic organization and product UUID');
 const p=(await pool.query('SELECT * FROM platform_product WHERE id=$1 AND organization_id=$2',[product,org])).rows[0];
 assert(p&&p.name==='Backend Delivery Fixture','Only the named synthetic fixture is allowed');
 const prior=(await pool.query('SELECT * FROM product_delivery_config WHERE product_id=$1',[product])).rows[0];
 const budget={chunkTurns:10,totalTurns:10,maxSeconds:60,maxStalledChunks:2};
 await saveServiceConfig(product,{revision:prior?.revision||0,configuration:{...(prior?.configuration||{previewHost:'backend-fixture.localhost',publicPort:3006,ingressClass:'revos-products',database:{secret:'product-database'},migrationCommand:['python','migrate.py']}),executor:'kelos',budget}});
 const b=await createCodeBuild(org,null,'kelos-no-model-smoke:'+randomUUID(),'Synthetic zero-model checkpoint test; budget is already exhausted. Do not run an LLM.',undefined,{productId:product});
 const folder=path.join(process.env.BUILD_DATA_DIR||'/build-data','jobs',b.codeBuildId);await fs.mkdir(path.join(folder,'site'),{recursive:true});
 await fs.writeFile(path.join(folder,'site','sentinel.txt'),'Persisted before Kelos execution.\n');
 await fs.writeFile(path.join(folder,'budget-checkpoint.json'),JSON.stringify({allocatedTurns:10,activeSeconds:0,chunks:1,stalledChunks:0}));
 const conn=await Connection.connect(connectionOptions());
 try{
  const client=new Client({connection:conn,namespace});
  const h=await client.workflow.start('CodeBuildWorkflow',{workflowId:'build:'+b.codeBuildId,taskQueue,args:[b.codeBuildId],workflowIdReusePolicy:'REJECT_DUPLICATE'});
  console.log(JSON.stringify({phase:'started',buildId:b.codeBuildId,workflowId:h.workflowId}));
  await h.result();
  const done=(await pool.query('SELECT state,error,result FROM code_build WHERE id=$1',[b.codeBuildId])).rows[0];
  assert.equal(done.state,'paused',done.error);assert.equal(done.result.usage.inputTokens,0);assert.equal(done.result.usage.outputTokens,0);
  assert.equal(await fs.readFile(path.join(folder,'site','sentinel.txt'),'utf8'),'Persisted before Kelos execution.\n');
  assert.equal(done.result.checkpoint.allocatedTurns,10);
  const conversation=path.join(folder,'conversation',b.codeBuildId.replaceAll('-',''),'base_state.json');await fs.access(conversation);
  console.log(JSON.stringify({phase:'passed',buildId:b.codeBuildId,state:done.state,inputTokens:done.result.usage.inputTokens,outputTokens:done.result.usage.outputTokens,preservedWorkspace:true,persistedConversation:true,reason:done.error}));
 }finally{await conn.close();await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;pool.end().catch(()=>{});});
