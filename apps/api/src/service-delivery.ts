import type { FastifyInstance } from "fastify";
import { Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";
import { taskQueue } from "../../../packages/temporal/src/config";
import { serviceDeliveryView, saveServiceConfig, startServiceBuild, createServiceRelease, promoteServiceRelease, recordReleaseImage, reconcileServiceRelease, publicDeliveryError, provisionProductDatabase, productDatabaseStatus, tickServiceRelease, rejectServiceRelease } from "../../../packages/engine/src/service-delivery";
import { pool } from "../../../packages/database/src";
import { resumeCodeBuild } from "../../../packages/engine/src/code-builds";
import { buildAttempt, buildWorkflowId } from "../../../packages/engine/src/build-attempt";
import { codingBudgetSchema } from "../../../packages/shared/src/service-delivery";

export function registerServiceDelivery(app: FastifyInstance, client: Client) {
  const wrap=(f:(r:any)=>Promise<any>)=>async(r:any,reply:any)=>{try{return await f(r);}catch(e){return reply.code(400).send({error:publicDeliveryError(e)});}};
  app.get("/products/:id/service-delivery",wrap(r=>serviceDeliveryView(z.uuid().parse(r.params.id))));
  app.put("/products/:id/service-delivery",wrap(r=>saveServiceConfig(z.uuid().parse(r.params.id),r.body)));
  app.post("/products/:id/service-database",wrap(r=>provisionProductDatabase(z.uuid().parse(r.params.id),z.object({environment:z.enum(['preview','live'])}).strict().parse(r.body).environment)));
  app.get("/products/:id/service-database",wrap(r=>productDatabaseStatus(z.uuid().parse(r.params.id),z.enum(['preview','live']).parse(r.query.environment || 'preview'))));
  app.post("/products/:id/service-builds",wrap(async r=>{
    const b=await startServiceBuild(z.uuid().parse(r.params.id),r.body);
    try { await client.workflow.start("CodeBuildWorkflow",{workflowId:"build:"+b.codeBuildId,taskQueue,args:[b.codeBuildId],workflowIdReusePolicy:"REJECT_DUPLICATE"}); }
    catch(e){if(!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;}
    return b;
  }));
  app.post("/products/:id/service-builds/:buildId/resume",wrap(async r=>{
    const productId=z.uuid().parse(r.params.id),id=z.uuid().parse(r.params.buildId);
    const input=z.object({requestId:z.uuid(),budget:codingBudgetSchema}).strict().parse(r.body);
    if(!(await pool.query("SELECT id FROM code_build WHERE id=$1 AND product_id=$2",[id,productId])).rowCount) throw Error("Build not found in this product");
    const b=await resumeCodeBuild(id,input.requestId,input.budget);
    try { await client.workflow.start("CodeBuildWorkflow",{workflowId:buildWorkflowId(id,buildAttempt(b)),taskQueue,args:[id,buildAttempt(b)],workflowIdReusePolicy:"REJECT_DUPLICATE"}); }
    catch(e){if(!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;}
    return {id:b.id,state:b.state,attempt:buildAttempt(b)};
  }));
  app.post("/products/:id/releases",wrap(r=>createServiceRelease(z.uuid().parse(r.params.id),r.body)));
  app.post("/service-delivery/releases/:id/approve",wrap(async r=>{
    z.object({approved:z.literal(true)}).strict().parse(r.body);
    return promoteServiceRelease(z.uuid().parse(r.params.id));
  }));
  app.post("/service-delivery/releases/:id/reject",wrap(r=>rejectServiceRelease(z.uuid().parse(r.params.id),z.object({reason:z.string().trim().min(1).max(1000)}).strict().parse(r.body).reason)));
  app.post("/service-delivery/releases/:id/refresh",wrap(r=>reconcileServiceRelease(z.uuid().parse(r.params.id))));
  app.post("/service-delivery/releases/:id/image",async(r:any,reply)=>{
    try { return await recordReleaseImage(z.uuid().parse(r.params.id),r.body,String(r.headers.authorization||"").replace(/^Bearer /,"")); }
    catch(e){return reply.code(400).send({error:publicDeliveryError(e)});}
  });
  let busy=false;
  const timer=setInterval(async()=>{
    if(process.env.PLATFORM_DISPATCH_ENABLED!=="true" || busy) return;
    busy=true;
    try {
      const releases=(await pool.query("SELECT * FROM product_release WHERE state IN ('ci_pending','publishing','syncing') ORDER BY created_at LIMIT 20")).rows;
      for(const r of releases) {
        try {
          await tickServiceRelease(r.id);
        } catch(e) { app.log.warn({releaseId:r.id,error:publicDeliveryError(e)},"Delivery reconciliation is waiting"); }
      }
    } catch(e) { app.log.warn({error:publicDeliveryError(e)},"Delivery status refresh failed"); }
    finally {busy=false;}
  },15000);
  timer.unref();
  app.addHook("onClose",async()=>clearInterval(timer));
}
