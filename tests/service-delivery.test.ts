import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceConfigSchema, releaseNamespace, codingBudgetSchema } from "../packages/shared/src/service-delivery";
import { renderRuntime, renderBuildWorkflow, deliveryToken, deploymentMatchesRelease, publicDeliveryError } from "../packages/engine/src/service-delivery";
import { kelosTask } from "../packages/engine/src/kelos";
const productId="a5b01a52-5bb5-466c-b9f8-1b8b8faf5820", organizationId="571879a5-b597-4894-ae94-b62df69e5367", releaseId="db4b0d25-a086-4d5b-a497-64ae41f584cc";
const image="registry.example/revos/product@sha256:"+"a".repeat(64);
const config=()=>serviceConfigSchema.parse({previewHost:"preview.example",liveHost:"live.example",database:{secret:"product-database"},migrationCommand:["python","migrate.py"]});
test("service manifests pin image and separate preview/live database namespaces without secret values",()=>{
  const runtime=renderRuntime({productId,organizationId,releaseId,environment:"preview",image,configuration:config()});
  const deployment=runtime.resources.find(x=>x.kind==='Deployment');
  assert.equal(deployment.spec.template.spec.containers[0].image,image);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken,false);
  assert.deepEqual(deployment.spec.template.spec.containers[0].env.find((x:any)=>x.name==='DATABASE_URL'),{name:"DATABASE_URL",valueFrom:{secretKeyRef:{name:"product-database",key:"DATABASE_URL"}}});
  assert.notEqual(runtime.namespace,releaseNamespace(productId,"live"));
  assert.equal(runtime.resources.find(x=>x.kind==='Job').metadata.annotations['argocd.argoproj.io/hook'],'PreSync');
  assert.throws(()=>renderRuntime({productId,organizationId,releaseId,environment:"preview",image:"registry.example/revos:latest",configuration:config()}));
});
test("external GitOps migrations block application startup and require database references",()=>{
  const c={...config(),provider:"external_gitops" as const};
  const runtime=renderRuntime({productId,organizationId,releaseId,environment:"preview",image,configuration:c});
  assert.deepEqual(runtime.resources.find(x=>x.kind==='Deployment').spec.template.spec.initContainers[0].command,['python','migrate.py']);
  assert.equal(runtime.resources.some(x=>x.kind==='Job'),false);
  assert.throws(()=>serviceConfigSchema.parse({previewHost:"x",migrationCommand:['python','migrate.py']}));
  assert.throws(()=>serviceConfigSchema.parse({...config(),secretRefs:[{env:'KEY',secret:'api-key',key:'key',value:'raw-secret'}]}));
});
test("CI runs exact source, tests before pushing and authenticates scoped digest reporting",()=>{
  const ci=JSON.parse(renderBuildWorkflow({releaseId,productId,sourceCommit:'a'.repeat(40),configuration:config(),callbackUrl:'http://api-next:3000',registry:'registry.example/revos'}));
  assert.equal(ci.jobs.build.steps[0].with.ref,'a'.repeat(40));
  assert.equal(ci.jobs.build.steps[0].with['persist-credentials'],false);
  assert.deepEqual(ci.jobs.build.steps.map((s:any)=>s.name),['Checkout exact source','Build and test','Push image','Report tested image']);
  assert.match(ci.jobs.build.steps[3].env.CALLBACK_URL,new RegExp(releaseId));
  assert.match(ci.jobs.build.steps[3].env.DELIVERY_TOKEN,/secrets.REVOS_DELIVERY_TOKEN/);
  assert.notEqual(deliveryToken(productId,'k'.repeat(32)),deliveryToken(organizationId,'k'.repeat(32)));
  assert.throws(()=>deliveryToken(productId,'short'));
});
test("a release is healthy only for its exact digest, generation, available replica and release identity",()=>{
  const release={id:releaseId,image};
  const deployment={metadata:{generation:3,annotations:{'revos.release':releaseId}},spec:{replicas:1,template:{spec:{containers:[{name:'app',image}]}}},status:{observedGeneration:3,availableReplicas:1,updatedReplicas:1}};
  assert.equal(deploymentMatchesRelease(deployment,release),true);
  for(const modified of [{...deployment,status:{...deployment.status,observedGeneration:2}},{...deployment,status:{...deployment.status,updatedReplicas:0}},{...deployment,metadata:{...deployment.metadata,annotations:{'revos.release':productId}}}]) assert.equal(deploymentMatchesRelease(modified,release),false);
  assert.equal(deploymentMatchesRelease(deployment,{id:releaseId,image:image.replace(/a$/,'b')}),false);
});
test("Kelos tasks reuse the build PVC and custom OpenHands protocol without repository credentials",()=>{
  const task=kelosTask({id:productId,attempt:2,image:'revos-openhands-kelos:test',model:'openai/gpt-6-astra',maxSeconds:3600,maxIterations:200});
  assert.equal(task.apiVersion,'kelos.dev/v1alpha2');
  assert.equal(task.spec.worker.credentials.type,'none');
  assert.equal(task.spec.worker.podOverrides.volumeMounts[0].subPath,'jobs/'+productId);
  assert.equal(task.spec.worker.podOverrides.serviceAccountName,'product-builder');
  assert.equal(task.spec.worker.podOverrides.env.some(e=>e.name.includes('FORGEJO')),false);
  assert.throws(()=>codingBudgetSchema.parse({chunkTurns:200,totalTurns:100}));
  assert.equal(codingBudgetSchema.parse({}).totalTurns,2000);
});
test("public errors redact bearer tokens and credentialed URLs",()=>{
  assert.equal(publicDeliveryError(Error('Bearer abcsecret at http://user:password@example/path')),'Error: Bearer [redacted] at http://[redacted]@example/path');
});

test('release waiting for approval performs no deployment or credential writes',async t=>{
  const {pool}=await import('../packages/database/src');
  const {tickServiceRelease,releaseStatus}=await import('../packages/engine/src/service-delivery');
  const r={id:releaseId,product_id:productId,organization_id:organizationId,environment:'preview',state:'awaiting_approval',url:'http://not-yet-live.example'};
  t.mock.method(pool,'query',(async(sql:string)=>{assert.match(sql,/^SELECT \* FROM product_release/);return{rows:[r]};}) as any);
  assert.deepEqual(await tickServiceRelease(releaseId),releaseStatus(r));
  assert.equal(releaseStatus(r).url,undefined);
  assert.equal(releaseStatus({...r,state:'healthy'}).url,r.url);
});
test('release inspection refuses a different organization before reading its config',async t=>{
  const {pool}=await import('../packages/database/src');
  const {ToolRegistry}=await import('../packages/engine/src');
  const {registerServiceTools}=await import('../packages/engine/src/service-delivery');
  t.mock.method(pool,'query',(async(sql:string)=>{
    if(sql.includes('JOIN run r'))return{rows:[{id:releaseId,org:organizationId}]};
    if(sql.includes('FROM platform_product'))return{rows:[{id:productId,organization_id:productId}]};
    throw Error('Configuration must not be read');
  }) as any);
  const tools=new ToolRegistry();registerServiceTools(tools);
  await assert.rejects(tools.resolve('openhands.inspect_delivery')({productId},{},{idempotencyKey:releaseId+':1'}),/another customer/);
});
test('declined release is terminal and retains the human reason',async t=>{
  const {pool}=await import('../packages/database/src');
  const {rejectServiceRelease,tickServiceRelease}=await import('../packages/engine/src/service-delivery');
  let row:any={id:releaseId,product_id:productId,organization_id:organizationId,environment:'preview',state:'awaiting_approval'};
  t.mock.method(pool,'query',(async(sql:string,p:any[])=>{
    if(sql.startsWith('UPDATE')){assert.match(sql,/state='awaiting_approval'/);row={...row,state:'failed',error:p[1]};}
    return{rows:[row]};
  }) as any);
  await rejectServiceRelease(releaseId,'Need a privacy review');
  const result=await tickServiceRelease(releaseId);
  assert.equal(result.state,'failed');assert.match(result.error||'',/Need a privacy review/);
});
test('local public port belongs in preview link, not Kubernetes hostname',()=>{
  const c={...config(),publicPort:3006};
  const runtime=renderRuntime({productId,organizationId,releaseId,environment:'preview',image,configuration:c});
  assert.equal(runtime.url,'http://preview.example:3006');
  assert.equal(runtime.resources.find(x=>x.kind==='Ingress').spec.rules[0].host,'preview.example');
  assert.throws(()=>serviceConfigSchema.parse({...c,publicPort:0}));
});
