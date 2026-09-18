import { createHmac, timingSafeEqual, randomUUID, randomBytes } from "node:crypto";
import { pool } from "../../database/src";
import { forgejo } from "./forgejo";
import { kubernetes } from "./kubernetes";
import { createCodeBuild } from "./code-builds";
import { serviceConfigSchema, type ServiceConfig, releaseNamespace, immutableImage, releaseReportSchema, sourceCommit, serviceBuildSchema, releaseRequestSchema } from "../../shared/src/service-delivery";
import { z } from "zod";

export const serviceRepositoryName = (productId: string) => `product-${z.uuid().parse(productId)}`;
const owner = () => process.env.FORGEJO_OWNER || "revos";
export const serviceRepoApi = (productId: string) => `/repos/${encodeURIComponent(owner())}/${serviceRepositoryName(productId)}`;
export const serviceRepositoryUrl = (productId: string) => `${process.env.FORGEJO_PUBLIC_URL || "http://localhost:3001"}/${owner()}/${serviceRepositoryName(productId)}`;
const gitopsName = (id: string) => `delivery-${z.uuid().parse(id)}`;
const gitopsApi = (id: string) => `/repos/${encodeURIComponent(owner())}/${gitopsName(id)}`;
const internalRepoUrl = (name: string) => `${process.env.FORGEJO_GITOPS_URL || "http://forgejo.agent-engine-local.svc.cluster.local:3000"}/${owner()}/${name}.git`;

export async function ensureServiceRepository(productId: string) {
  if (!(await forgejo(serviceRepoApi(productId)))) {
    try { await forgejo("/user/repos", "POST", { name: serviceRepositoryName(productId), private: true, auto_init: true, default_branch: "main" }); }
    catch (e) { if (!(await forgejo(serviceRepoApi(productId)))) throw e; }
  }
  await pool.query("UPDATE platform_product SET repository_url=$2,updated_at=now() WHERE id=$1",[productId,serviceRepositoryUrl(productId)]);
}
export async function productRecord(id: string) {
  const p = (await pool.query("SELECT * FROM platform_product WHERE id=$1", [z.uuid().parse(id)])).rows[0];
  if (!p) throw Error("Product not found");
  return p;
}
export async function provisionProductDatabase(productId:string, environment:"preview"|"live") {
  const p=await productRecord(productId),namespace=releaseNamespace(productId,environment);
  const oldNamespace=await kubernetes(`/api/v1/namespaces/${namespace}`);
  if(oldNamespace && oldNamespace.metadata?.labels?.['revos.product']!==productId) throw Error("Namespace belongs to another product");
  const labels={"revos.product":productId,"revos.organization":p.organization_id,"app":"product-database"};
  if(!oldNamespace) await kubernetes('/api/v1/namespaces','POST',{apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels}});
  // Preserve database credentials and PVC across retries and every application release.
  if(!(await kubernetes(`/api/v1/namespaces/${namespace}/secrets/product-database`))) {
    const password=randomBytes(32).toString('hex');
    await kubernetes(`/api/v1/namespaces/${namespace}/secrets`,'POST',{apiVersion:'v1',kind:'Secret',metadata:{name:'product-database',namespace,labels},type:'Opaque',stringData:{POSTGRES_PASSWORD:password,DATABASE_URL:`postgresql://product:${password}@product-database:5432/product`}});
  }
  const resources:any[]=[
    {apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:{name:'product-database',namespace,labels},spec:{accessModes:['ReadWriteOnce'],resources:{requests:{storage:'5Gi'}}}},
    {apiVersion:'v1',kind:'Service',metadata:{name:'product-database',namespace,labels},spec:{selector:{app:'product-database'},ports:[{port:5432,targetPort:5432}]}},
    {apiVersion:'apps/v1',kind:'StatefulSet',metadata:{name:'product-database',namespace,labels},spec:{serviceName:'product-database',replicas:1,selector:{matchLabels:{app:'product-database'}},template:{metadata:{labels},spec:{automountServiceAccountToken:false,containers:[{name:'postgres',image:'postgres:17',ports:[{containerPort:5432}],env:[{name:'POSTGRES_USER',value:'product'},{name:'POSTGRES_DB',value:'product'},{name:'PGDATA',value:'/var/lib/postgresql/data/pgdata'},{name:'POSTGRES_PASSWORD',valueFrom:{secretKeyRef:{name:'product-database',key:'POSTGRES_PASSWORD'}}}],readinessProbe:{exec:{command:['pg_isready','-U','product']},initialDelaySeconds:5},resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'512Mi'}},volumeMounts:[{name:'data',mountPath:'/var/lib/postgresql/data'}]}],volumes:[{name:'data',persistentVolumeClaim:{claimName:'product-database'}}]}}}}
  ];
  for(const r of resources) {
    const resource=r.kind==='PersistentVolumeClaim'?'persistentvolumeclaims':r.kind==='Service'?'services':'statefulsets';
    const base=r.apiVersion==='v1'?'/api/v1':'/apis/apps/v1',endpoint=`${base}/namespaces/${namespace}/${resource}`;
    const old=await kubernetes(`${endpoint}/product-database`);
    if(old && old.metadata?.labels?.['revos.product']!==productId) throw Error("Database resource belongs to another product");
    if(!old) await kubernetes(endpoint,'POST',r);
  }
  await pool.query("UPDATE product_delivery_config SET configuration=jsonb_set(configuration,'{database}',$2::jsonb),revision=revision+1,updated_at=now() WHERE product_id=$1 AND configuration->'database' IS DISTINCT FROM $2::jsonb",[productId,JSON.stringify({secret:'product-database',key:'DATABASE_URL'})]);
  return productDatabaseStatus(productId,environment);
}
export async function productDatabaseStatus(productId:string,environment:"preview"|"live") {
  await productRecord(productId);
  const namespace=releaseNamespace(productId,environment),state=await kubernetes(`/apis/apps/v1/namespaces/${namespace}/statefulsets/product-database`);
  return {environment,state:!state?'not_provisioned':state.status?.readyReplicas>=1?'ready':'provisioning',namespace,secretReference:{secret:'product-database',key:'DATABASE_URL'},storage:'5Gi',notice:'Local PostgreSQL uses persistent storage. Production backup and high availability are configured separately.'};
}
export async function saveServiceConfig(productId: string, body: unknown) {
  const { revision, configuration } = z.object({ revision: z.number().int().min(0), configuration: serviceConfigSchema }).strict().parse(body);
  const p = await productRecord(productId);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const existing = (await c.query("SELECT * FROM product_delivery_config WHERE product_id=$1 FOR UPDATE", [productId])).rows[0];
    if ((existing?.revision || 0) !== revision) throw Error("Delivery settings changed; reload before saving");
    const result = (await c.query(`INSERT INTO product_delivery_config(product_id,organization_id,configuration) VALUES($1,$2,$3)
      ON CONFLICT(product_id) DO UPDATE SET configuration=$3,revision=product_delivery_config.revision+1,updated_at=now() RETURNING *`, [productId,p.organization_id,JSON.stringify(configuration)])).rows[0];
    await c.query("UPDATE platform_product SET runtime_kind='service',updated_at=now() WHERE id=$1", [productId]);
    await c.query("COMMIT");
    return result;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
export async function startServiceBuild(productId: string, body: unknown) {
  const input = serviceBuildSchema.parse(body), p = await productRecord(productId);
  const settings = (await pool.query("SELECT * FROM product_delivery_config WHERE product_id=$1", [productId])).rows[0];
  if (!settings) throw Error("Configure hosting before building a backend service");
  const config = serviceConfigSchema.parse(settings.configuration);
  if (input.parentBuildId && !(await pool.query("SELECT id FROM code_build WHERE id=$1 AND product_id=$2 AND state='completed'", [input.parentBuildId,productId])).rowCount)
    throw Error("Revision source must be a completed build of this product");
  await ensureServiceRepository(productId);
  return createCodeBuild(p.organization_id, null, `service:${productId}:${input.requestId}`, input.brief, input.parentBuildId, { productId, runtime: "service", service: config, executor: config.executor, budget: config.budget });
}

/** Runtime manifests contain only secret references, and always use an image digest. */
export function renderRuntime(input: { productId: string; organizationId: string; releaseId: string; environment: "preview"|"live"; image: string; configuration: ServiceConfig }) {
  const c = serviceConfigSchema.parse(input.configuration), image = immutableImage.parse(input.image);
  const namespace = releaseNamespace(input.productId,input.environment), name = "app";
  const host = input.environment === "live" ? c.liveHost : c.previewHost;
  if (!host) throw Error("Live hostname is not configured");
  const labels = { "app.kubernetes.io/name": name, "revos.product": input.productId, "revos.organization": z.uuid().parse(input.organizationId), "revos.environment": input.environment };
  const env: any[] = [{name:"PORT",value:String(c.port)}, ...c.secretRefs.map(r=>({name:r.env,valueFrom:{secretKeyRef:{name:r.secret,key:r.key}}}))];
  if (c.database) env.push({name:"DATABASE_URL",valueFrom:{secretKeyRef:{name:c.database.secret,key:c.database.key}}});
  const podSpec: any = { automountServiceAccountToken: false, securityContext: {runAsNonRoot:true,runAsUser:1000,fsGroup:1000,seccompProfile:{type:"RuntimeDefault"}},
    ...(c.imagePullSecret ? {imagePullSecrets:[{name:c.imagePullSecret}]} : {}),
    containers:[{name,image,env,ports:[{name:"http",containerPort:c.port}],resources:{requests:{cpu:"100m",memory:"128Mi"},limits:{cpu:c.cpu,memory:c.memory}},
      securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:["ALL"]}},
      readinessProbe:{httpGet:{path:c.healthPath,port:"http"},initialDelaySeconds:3,periodSeconds:5},
      livenessProbe:{httpGet:{path:c.healthPath,port:"http"},initialDelaySeconds:20,periodSeconds:15},
      startupProbe:{httpGet:{path:c.healthPath,port:"http"},failureThreshold:30,periodSeconds:5}}] };
  const resources: any[] = [
    {apiVersion:"v1",kind:"Namespace",metadata:{name:namespace,labels:{"revos.product":input.productId,"revos.organization":input.organizationId}}},
    {apiVersion:"apps/v1",kind:"Deployment",metadata:{name,namespace,labels,annotations:{"revos.release":z.uuid().parse(input.releaseId)}},spec:{replicas:c.replicas,revisionHistoryLimit:5,selector:{matchLabels:{"app.kubernetes.io/name":name}},template:{metadata:{labels,annotations:{"revos.release":input.releaseId}},spec:podSpec}}},
    {apiVersion:"v1",kind:"Service",metadata:{name,namespace,labels},spec:{selector:{"app.kubernetes.io/name":name},ports:[{port:80,targetPort:"http"}]}},
    {apiVersion:"networking.k8s.io/v1",kind:"Ingress",metadata:{name,namespace,labels},spec:{ingressClassName:c.ingressClass,...(c.tlsSecretName ? {tls:[{hosts:[host],secretName:c.tlsSecretName}]} : {}),rules:[{host,http:{paths:[{path:"/",pathType:"Prefix",backend:{service:{name,port:{number:80}}}}]}}]}}
  ];
  if (c.migrationCommand) {
    const migration={...podSpec.containers[0],name:"migration",command:c.migrationCommand,ports:undefined,readinessProbe:undefined,livenessProbe:undefined,startupProbe:undefined};
    if(c.provider==='external_gitops') podSpec.initContainers=[migration];
    else resources.push({apiVersion:"batch/v1",kind:"Job",metadata:{name:"migration-"+input.releaseId,namespace,labels,annotations:{"argocd.argoproj.io/hook":"PreSync","argocd.argoproj.io/hook-delete-policy":"BeforeHookCreation,HookSucceeded"}},spec:{backoffLimit:0,activeDeadlineSeconds:600,template:{metadata:{labels},spec:{...podSpec,restartPolicy:"Never",containers:[migration]}}}});
  }
  return {namespace,url:`${c.tlsSecretName ? "https" : "http"}://${host}${c.publicPort && c.publicPort!==(c.tlsSecretName?443:80) ? ":"+c.publicPort : ""}`,resources};
}

export function deliveryToken(productId: string, key = process.env.SERVICE_DELIVERY_CALLBACK_KEY) {
  if (!key || key.length < 32) throw Error("Delivery callback key is not configured");
  return createHmac("sha256",key).update("product-delivery:"+z.uuid().parse(productId)).digest("hex");
}
export function verifyDeliveryToken(productId: string, supplied: string) {
  const expected = Buffer.from(deliveryToken(productId));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}

/** A per-release workflow checks out the immutable source, tests, builds and reports its digest. */
export function renderBuildWorkflow(input: {releaseId: string; productId: string; sourceCommit: string; configuration: ServiceConfig; callbackUrl: string; registry: string}) {
  const id=z.uuid().parse(input.releaseId), product=z.uuid().parse(input.productId), commit=sourceCommit.parse(input.sourceCommit), config=serviceConfigSchema.parse(input.configuration);
  const url=new URL(input.callbackUrl); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error("Invalid callback URL");
  const registry=z.string().regex(/^[a-z0-9][a-z0-9.:/-]*$/).parse(input.registry);
  // JSON is valid YAML. Commands are fixed; user test commands are an exec-form JSON array run inside the built image.
  const steps = [
    {name:"Checkout exact source",uses:"actions/checkout@v4",with:{ref:commit,"persist-credentials":false,"github-server-url":process.env.FORGEJO_CI_URL || "http://forgejo.agent-engine-local.svc.cluster.local:3000"}},
    {name:"Build and test",env:{SOURCE_COMMIT:commit,IMAGE_NAME:`${registry}/${product}`,TEST_COMMAND:JSON.stringify(config.testCommand)},run:'set -eu\ndocker build --label org.opencontainers.image.revision="$SOURCE_COMMIT" -t "$IMAGE_NAME:$SOURCE_COMMIT" .\npython3 - <<\'PY\'\nimport json,os,subprocess\nsubprocess.run(["docker","run","--rm","--network","none",os.environ["IMAGE_NAME"]+":"+os.environ["SOURCE_COMMIT"],*json.loads(os.environ["TEST_COMMAND"])],check=True)\nPY'},
    {name:"Push image",env:{REGISTRY_USER:"${{ secrets.REGISTRY_USER }}",REGISTRY_PASSWORD:"${{ secrets.REGISTRY_PASSWORD }}",REGISTRY:registry.split('/')[0],SOURCE_COMMIT:commit,IMAGE_NAME:`${registry}/${product}`},run:'set -eu\nif [ -n "$REGISTRY_PASSWORD" ]; then printf "%s" "$REGISTRY_PASSWORD" | docker login "$REGISTRY" --username "$REGISTRY_USER" --password-stdin; fi\ndocker push "$IMAGE_NAME:$SOURCE_COMMIT"\npython3 - <<\'PY\'\nimport json,os,subprocess,pathlib\nname=os.environ["IMAGE_NAME"]\ninfo=json.loads(subprocess.check_output(["docker","inspect",name+":"+os.environ["SOURCE_COMMIT"]]))[0]\ndigest=next(d for d in info["RepoDigests"] if d.startswith(name+"@sha256:"))\nsubprocess.run(["docker","pull",digest],check=True)\npathlib.Path("image-digest.txt").write_text(digest)\nPY'},
    {name:"Report tested image",env:{CALLBACK_URL:new URL(`/service-delivery/releases/${id}/image`,url).href,DELIVERY_TOKEN:"${{ secrets.REVOS_DELIVERY_TOKEN }}",SOURCE_COMMIT:commit},run:'set -eu\npython3 - <<\'PY\'\nimport json,os,pathlib,urllib.request\nbody=json.dumps({"sourceCommit":os.environ["SOURCE_COMMIT"],"image":pathlib.Path("image-digest.txt").read_text().strip(),"testsPassed":True}).encode()\nr=urllib.request.Request(os.environ["CALLBACK_URL"],data=body,headers={"Content-Type":"application/json","Authorization":"Bearer "+os.environ["DELIVERY_TOKEN"]},method="POST")\nurllib.request.urlopen(r,timeout=30).read()\nPY'}
  ];
  return JSON.stringify({name:`Release ${id}`,on:{push:{branches:[`release-${id}`]}},jobs:{build:{"runs-on":process.env.PRODUCT_CI_RUNNER_LABEL || "docker",steps}}},null,2);
}
async function repositoryFile(api: string, branch: string, filename: string, content: string) {
  const old=await forgejo(`${api}/contents/${filename}?ref=${encodeURIComponent(branch)}`);
  if (old?.content && Buffer.from(old.content,"base64").toString("utf8")===content) return old.last_commit_sha;
  const result=await forgejo(`${api}/contents/${filename}`,old ? "PUT":"POST",{branch,message:`revOS delivery: ${filename}`,content:Buffer.from(content).toString("base64"),...(old?{sha:old.sha}:{})});
  return sourceCommit.parse(result.commit.sha);
}
export async function createServiceRelease(productId: string, body: unknown) {
  const input=releaseRequestSchema.parse(body), p=await productRecord(productId);
  const callbackUrl=process.env.SERVICE_DELIVERY_CALLBACK_URL, registry=process.env.PRODUCT_IMAGE_REGISTRY;
  if (!callbackUrl || !registry || !process.env.SERVICE_DELIVERY_CALLBACK_KEY) throw Error("Service CI is not configured; set the registry, callback URL and scoped delivery credentials first");
  const existing=(await pool.query("SELECT * FROM product_release WHERE product_id=$1 AND request_id=$2",[productId,input.requestId])).rows[0];
  let release=existing;
  if (!release) {
    const b=(await pool.query("SELECT * FROM code_build WHERE id=$1 AND product_id=$2 AND organization_id=$3 AND state='completed'",[input.buildId,productId,p.organization_id])).rows[0];
    if (!b || b.result?._config?.runtime!=="service") throw Error("A completed backend build of this product is required");
    const configRow=(await pool.query("SELECT * FROM product_delivery_config WHERE product_id=$1",[productId])).rows[0];
    const config=serviceConfigSchema.parse(configRow?.configuration);
    if (input.environment==='live' && !config.liveHost) throw Error("Set a live hostname before preparing a release");
    const id=randomUUID();
    release=(await pool.query(`INSERT INTO product_release(id,product_id,organization_id,build_id,request_id,environment,source_commit,repository_url,configuration,config_revision,ci_branch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(product_id,request_id) DO UPDATE SET request_id=excluded.request_id RETURNING *`,[id,productId,p.organization_id,b.id,input.requestId,input.environment,sourceCommit.parse(b.result.commit),serviceRepositoryUrl(productId),JSON.stringify(config),configRow.revision,`release-${id}`])).rows[0];
  }
  if (release.state!=="ci_pending") return release;
  const api=serviceRepoApi(productId);
  // Each repository receives only its own derived callback credential.
  await forgejo(`${api}/actions/secrets/REVOS_DELIVERY_TOKEN`,"PUT",{data:deliveryToken(productId)});
  await forgejo(api,"PATCH",{has_actions:true});
  if (!(await forgejo(`${api}/branches/${release.ci_branch}`))) await forgejo(`${api}/branches`,"POST",{new_branch_name:release.ci_branch,old_ref_name:release.source_commit});
  const workflow=renderBuildWorkflow({releaseId:release.id,productId,sourceCommit:release.source_commit,configuration:release.configuration,callbackUrl,registry});
  await repositoryFile(api,release.ci_branch,".forgejo/workflows/release.yaml",workflow);
  return release;
}
export async function recordReleaseImage(id: string, body: unknown, token: string) {
  const input=releaseReportSchema.parse(body);
  const r=(await pool.query("SELECT * FROM product_release WHERE id=$1",[z.uuid().parse(id)])).rows[0];
  if (!r || !verifyDeliveryToken(r.product_id,token)) throw Error("Invalid delivery credential");
  if (r.source_commit!==input.sourceCommit) throw Error("CI source does not match this release");
  if (r.image && r.image!==input.image) throw Error("Release image is immutable");
  return (await pool.query("UPDATE product_release SET image=$2,state=CASE WHEN state='ci_pending' THEN 'awaiting_approval' ELSE state END,updated_at=now() WHERE id=$1 RETURNING *",[id,input.image])).rows[0];
}
export async function promoteServiceRelease(id: string) {
  const lock=await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))",["release:"+id]);
    const r=(await lock.query("SELECT * FROM product_release WHERE id=$1",[z.uuid().parse(id)])).rows[0];
    if (!r) throw Error("Release not found");
    if (["syncing","healthy"].includes(r.state)) return r;
    if (!["awaiting_approval","publishing","failed"].includes(r.state) || !r.image) throw Error("A tested immutable image is required before release approval");
    const config=serviceConfigSchema.parse(r.configuration), rendered=renderRuntime({productId:r.product_id,organizationId:r.organization_id,releaseId:r.id,environment:r.environment,image:r.image,configuration:config});
    await lock.query("UPDATE product_release SET state='publishing',approved_at=coalesce(approved_at,now()),error=NULL WHERE id=$1",[id]);
    const api=gitopsApi(r.product_id);
    if (!(await forgejo(api))) await forgejo("/user/repos","POST",{name:gitopsName(r.product_id),private:true,auto_init:true,default_branch:"main"});
    const folder=`environments/${r.environment}`;
    await repositoryFile(api,"main",`${folder}/resources.json`,JSON.stringify({apiVersion:"v1",kind:"List",items:rendered.resources},null,2));
    await repositoryFile(api,"main",`${folder}/kustomization.yaml`,JSON.stringify({apiVersion:"kustomize.config.k8s.io/v1beta1",kind:"Kustomization",resources:["resources.json"]}));
    const head=await forgejo(`${api}/branches/main`), gitopsCommit=sourceCommit.parse(head.commit.id);
    if (config.provider==='argocd') {
      const ns=process.env.ARGOCD_NAMESPACE || "argocd", project=process.env.ARGOCD_PRODUCT_PROJECT || "revos-products";
      const endpoint=`/apis/argoproj.io/v1alpha1/namespaces/${ns}/applications`, name=rendered.namespace;
      const prior=await kubernetes(`${endpoint}/${name}`);
      const app={apiVersion:"argoproj.io/v1alpha1",kind:"Application",metadata:{name,namespace:ns,...(prior?{resourceVersion:prior.metadata.resourceVersion}:{})},spec:{project,source:{repoURL:internalRepoUrl(gitopsName(r.product_id)),targetRevision:gitopsCommit,path:folder},destination:{server:"https://kubernetes.default.svc",namespace:rendered.namespace},syncPolicy:{automated:{prune:false,selfHeal:true},syncOptions:["CreateNamespace=true"]}}};
      await kubernetes(prior ? `${endpoint}/${name}` : endpoint,prior ? "PUT":"POST",app);
    }
    return (await lock.query("UPDATE product_release SET state='syncing',gitops_commit=$2,url=$3,error=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id,gitopsCommit,rendered.url])).rows[0];
  } catch(e) {
    await lock.query("UPDATE product_release SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='publishing'",[id,publicDeliveryError(e)]); throw e;
  } finally { await lock.query("SELECT pg_advisory_unlock(hashtext($1))",["release:"+id]); lock.release(); }
}
export function deploymentMatchesRelease(deployment: any, release: any): boolean {
  return !!deployment && deployment.metadata?.annotations?.["revos.release"]===release.id && deployment.spec?.template?.spec?.containers?.some((c:any)=>c.name==='app' && c.image===release.image)
    && deployment.status?.observedGeneration>=deployment.metadata.generation && deployment.status?.availableReplicas>=deployment.spec.replicas && deployment.status?.updatedReplicas>=deployment.spec.replicas;
}
export async function reconcileServiceRelease(id: string) {
  const r=(await pool.query("SELECT * FROM product_release WHERE id=$1",[z.uuid().parse(id)])).rows[0];
  if (!r || r.state!=="syncing") return r;
  const ns=releaseNamespace(r.product_id,r.environment);
  const deployment=await kubernetes(`/apis/apps/v1/namespaces/${ns}/deployments/app`);
  if (!deploymentMatchesRelease(deployment,r)) return r;
  if (r.configuration.provider==='argocd') {
    const app=await kubernetes(`/apis/argoproj.io/v1alpha1/namespaces/${process.env.ARGOCD_NAMESPACE || "argocd"}/applications/${ns}`);
    if (app?.status?.sync?.revision!==r.gitops_commit || app?.status?.sync?.status!=="Synced" || app?.status?.health?.status!=="Healthy") return r;
  }
  await pool.query("UPDATE product_release SET state='healthy',error=NULL,updated_at=now() WHERE id=$1",[id]);
  await pool.query("UPDATE platform_product SET state=$2,repository_url=$3,updated_at=now() WHERE id=$1",[r.product_id,r.environment==='live'?'live':'preview',r.repository_url]);
  await pool.query("UPDATE code_build SET result=result||$2::jsonb WHERE id=$1",[r.build_id,JSON.stringify({previewUrl:r.url,releaseId:r.id})]);
  return {...r,state:'healthy'};
}
export function publicDeliveryError(e: unknown) { return String(e).replace(/Bearer\s+\S+/gi,"Bearer [redacted]").replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g,"$1[redacted]@").slice(0,1000); }
export async function serviceDeliveryView(id: string) {
  const product=await productRecord(id), configuration=(await pool.query("SELECT * FROM product_delivery_config WHERE product_id=$1",[id])).rows[0] || null;
  const releases=(await pool.query("SELECT * FROM product_release WHERE product_id=$1 ORDER BY created_at DESC LIMIT 30",[id])).rows;
  return {product,configuration,releases,capabilities:{ciConfigured:!!(process.env.PRODUCT_IMAGE_REGISTRY && process.env.SERVICE_DELIVERY_CALLBACK_URL && process.env.SERVICE_DELIVERY_CALLBACK_KEY),executor:configuration?.configuration?.executor || "openhands",kelosConfigured:process.env.KELOS_ENABLED==='true',gitopsProvider:configuration?.configuration?.provider || null},instruction:"Only healthy releases have a verified running service. CI and cluster provisioning must be configured separately."};
}

export function releaseStatus(r: any): import("../../shared/src/service-delivery").ServiceReleaseStatus {
  return { serviceReleaseId:r.id, productId:r.product_id, organizationId:r.organization_id,
    environment:r.environment, state:r.state, ...(r.state==='healthy' && r.url ? {url:r.url}:{}), ...(r.error ? {error:publicDeliveryError(r.error)}:{}) };
}
/** All retryable work is replay-safe. Approval is exclusively a human API action. */
export async function tickServiceRelease(id: string) {
  let r=(await pool.query("SELECT * FROM product_release WHERE id=$1",[z.uuid().parse(id)])).rows[0];
  if(!r) throw Error("Service release no longer exists");
  if(r.state==='ci_pending') {
    // Failed CI cannot leave the owning workflow silently waiting forever.
    if(Date.now()-new Date(r.created_at).getTime()>60*60*1000) {
      r=(await pool.query("UPDATE product_release SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='ci_pending' RETURNING *",[id,'Container CI did not report a tested image within one hour. Check the Forgejo Actions run and runner, then prepare a new release.'])).rows[0] || r;
    } else r=await createServiceRelease(r.product_id,{buildId:r.build_id,requestId:r.request_id,environment:r.environment});
  } else if(r.state==='publishing' && r.approved_at) r=await promoteServiceRelease(id);
  else if(r.state==='syncing') {
    r=await reconcileServiceRelease(id);
    if(r.state==='syncing' && Date.now()-new Date(r.updated_at).getTime()>30*60*1000)
      r=(await pool.query("UPDATE product_release SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='syncing' RETURNING *",[id,'Deployment did not become healthy within 30 minutes. Review its migration, image pull and health checks before retrying release approval.'])).rows[0] || r;
  }
  return releaseStatus(r);
}
export async function rejectServiceRelease(id: string, reason: string) {
  const r=(await pool.query("UPDATE product_release SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='awaiting_approval' RETURNING *",[z.uuid().parse(id),'Release declined: '+z.string().trim().min(1).max(1000).parse(reason)])).rows[0];
  if(!r) throw Error("Only a release awaiting approval can be declined");
  return releaseStatus(r);
}

export const serviceToolDefinitions: Array<{slug:string;name:string;handler:string;description:string;inputSchema:import("../../shared/src").Json;outputSchema:import("../../shared/src").Json}> = [
  {slug:'openhands-prepare_release',name:'Prepare backend release',handler:'openhands.prepare_release',
    description:'Build and test an immutable container from a completed backend product build. The workflow waits for human deployment approval and a verified healthy preview/live service. This tool cannot approve a release.',
    inputSchema:{type:'object',required:['buildId'],additionalProperties:false,properties:{buildId:{type:'string',format:'uuid'},environment:{type:'string',enum:['preview','live'],default:'preview'}}},outputSchema:{type:'object'}},
  {slug:'openhands-inspect_delivery',name:'Inspect product hosting',handler:'openhands.inspect_delivery',
    description:'Read backend product settings and release status, including verified preview/live URLs. Configuration exposes secret references only.',
    inputSchema:{type:'object',required:['productId'],additionalProperties:false,properties:{productId:{type:'string',format:'uuid'}}},outputSchema:{type:'object'}}
];
export function registerServiceTools(registry: import('./index').ToolRegistry) {
  for(const d of serviceToolDefinitions) registry.register(d.handler,async(input,_configuration,ctx)=>{
    const sid=z.uuid().parse(ctx?.idempotencyKey.split(':')[0]);
    const run=(await pool.query('SELECT r.id,r.customer_organization_id AS org FROM reasoning_session s JOIN run r ON r.id=s.run_id WHERE s.id=$1',[sid])).rows[0];
    if(!run?.org) throw Error('Resolve the customer before managing product hosting');
    if(d.handler.endsWith('inspect_delivery')) {
      const args=z.object({productId:z.uuid()}).strict().parse(input),p=await productRecord(args.productId);
      if(p.organization_id!==run.org) throw Error('Product belongs to another customer');
      return serviceDeliveryView(p.id);
    }
    const args=z.object({buildId:z.uuid(),environment:z.enum(['preview','live']).default('preview')}).strict().parse(input);
    const build=(await pool.query('SELECT * FROM code_build WHERE id=$1 AND organization_id=$2',[args.buildId,run.org])).rows[0];
    if(!build?.product_id) throw Error('Build not found in this customer');
    // UUID-shaped deterministic request identity means activity retries never duplicate releases.
    const hex=createHmac('sha256','revos-release-request').update(ctx!.idempotencyKey).digest('hex');
    const requestId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    const release=await createServiceRelease(build.product_id,{buildId:build.id,environment:args.environment,requestId});
    return {...releaseStatus(release),runId:run.id,instruction:'The engine waits for tested CI, human approval in Product Hosting, and a healthy deployment. Use inspect_delivery afterwards to read its verified URL. Humans can decline a release; the workflow then fails with their reason.'};
  },{retrySafe:true});
}
