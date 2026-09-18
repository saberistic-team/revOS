import { z } from "zod";
import { kubernetes, buildNamespace } from "./kubernetes";
import { buildJobName } from "./build-attempt";

const path=()=>`/apis/kelos.dev/v1alpha2/namespaces/${buildNamespace()}/tasks`;
export function kelosTask(input:{id:string;attempt:number;image:string;model:string;maxSeconds:number;maxIterations:number}) {
  return {apiVersion:"kelos.dev/v1alpha2",kind:"Task",metadata:{name:buildJobName(input.id,input.attempt),labels:{"revos-build":input.id}},spec:{
    prompt:`Resume or start revOS build ${z.uuid().parse(input.id)} from /workspace/request.json.`,
    // Kelos's provider enum names the launch protocol. This custom image runs
    // OpenHands and injects its own credential, without a GitHub workspace.
    worker:{type:"codex",credentials:{type:"none"},image:input.image,model:input.model,podOverrides:{
      activeDeadlineSeconds:input.maxSeconds+120,
      env:[{name:"OPENAI_API_KEY",valueFrom:{secretKeyRef:{name:"openai-secrets",key:"OPENAI_API_KEY"}}},{name:"OPENHANDS_MODEL",value:input.model},{name:"OPENHANDS_MAX_ITERATIONS",value:String(input.maxIterations)}],
      serviceAccountName:"product-builder",podSecurityContext:{runAsUser:1000,runAsGroup:1000,fsGroup:1000},
      containerSecurityContext:{allowPrivilegeEscalation:false,capabilities:{drop:["ALL"]}},
      resources:{requests:{cpu:"100m",memory:"256Mi"},limits:{cpu:"2",memory:"2Gi"}},
      volumes:[{name:"build-data",persistentVolumeClaim:{claimName:"build-data"}}],volumeMounts:[{name:"build-data",mountPath:"/workspace",subPath:"jobs/"+input.id}]
    }}}};
}
export async function getKelosBuild(id:string,attempt:number) {
  const task=await kubernetes(`${path()}/${buildJobName(id,attempt)}`);
  if (!task) return null;
  return {metadata:task.metadata,status:{active:["Pending","Running","Waiting"].includes(task.status?.phase) || !task.status?.phase ? 1:0,succeeded:task.status?.phase==="Succeeded"?1:0,failed:task.status?.phase==="Failed"?1:0},kelos:task.status};
}
export async function startKelosBuild(input:Parameters<typeof kelosTask>[0]) {
  if(process.env.KELOS_ENABLED!=="true") throw Error("Kelos is selected but is not provisioned. Install the Kelos CRDs/controller and apply the product builder permissions first.");
  return kubernetes(path(),"POST",kelosTask(input));
}
