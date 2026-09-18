import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rm,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { pool } from "../../database/src";
import { forgejo } from "./forgejo";
import { kubernetes, buildNamespace } from "./kubernetes";
import { ToolRegistry } from "./index";
import { z } from "zod";
import { acceptedBuildResume, buildAttempt, buildJobName, resumedBuildResult } from "./build-attempt";
import { committedBuildSource, lineageSchema, pinnedBuildLineage, publishBuildSource } from "./build-lineage";
import { codingBudgetSchema, serviceConfigSchema } from "../../shared/src/service-delivery";
import { serviceRepoApi, serviceRepositoryName, serviceRepositoryUrl } from "./service-delivery";
import { getKelosBuild, startKelosBuild } from "./kelos";
import { recordUsage } from "./usage-ledger";
const root = () => process.env.BUILD_DATA_DIR || "/build-data";
const dir = (id: string) => path.join(root(), "jobs", z.uuid().parse(id));
const repository = (org: string) => `products-${org}`;
const repoApi = (org: string) =>
  `/repos/${encodeURIComponent(process.env.FORGEJO_OWNER || "revos")}/${repository(org)}`;
const repoUrl = (org: string) =>
  `${process.env.FORGEJO_PUBLIC_URL || "http://localhost:3001"}/${process.env.FORGEJO_OWNER || "revos"}/${repository(org)}`;
export async function siteFiles(id: string, service = false) {
  const base = path.join(dir(id), "site");
  if ((await lstat(base)).isSymbolicLink()) throw Error("Invalid build root");
  const files: { name: string; data: Buffer }[] = [];
  let size = 0;
  async function walk(folder: string) {
    for (const name of await readdir(folder)) {
      const full = path.join(folder, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink())
        throw Error("Symlinks are not allowed in build artifacts");
      if (
        name.startsWith(".") ||
        ["node_modules", "__pycache__"].includes(name)
      )
        continue;
      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const relative = path.relative(base, full);
      if (!/^[a-zA-Z0-9_./ -]+$/.test(relative))
        throw Error("Unsupported artifact filename");
      if (++size > (service ? 500 : 100)) throw Error("Build exceeds file limit");
      const data = await readFile(full);
      for (const secret of [
        process.env.OPENAI_API_KEY,
        process.env.FORGEJO_TOKEN,
      ])
        if (secret && data.includes(Buffer.from(secret)))
          throw Error("Build contains a credential and cannot be published");
      files.push({ name: relative, data });
    }
  }
  await walk(base);
  if (files.reduce((s, f) => s + f.data.length, 0) > (service ? 20_000_000 : 5_000_000))
    throw Error("Build exceeds source size limit");
  if (!files.some((f) => f.name === (service ? "Dockerfile" : "index.html")))
    if (service) throw Error("Backend build needs Dockerfile"); else
    throw Error("Build needs index.html");
  return files;
}
async function startJob(b: any) {
  const attempt = buildAttempt(b);
  const config = b.result?._config || {};
  const service = config.runtime === "service";
  const budget = codingBudgetSchema.parse(config.budget || {});
  const ns = buildNamespace(),
    p = `/apis/batch/v1/namespaces/${ns}/jobs`,
    name = buildJobName(b.id, attempt);
  const readJob = (n: number) => config.executor === "kelos" ? getKelosBuild(b.id,n) : kubernetes(p+"/"+buildJobName(b.id,n));
  if (await readJob(attempt)) return true;
  // A failed dispatch can leave an attempt without a Job while an older Job
  // still runs. Inspect every earlier attempt before sharing its workspace.
  for (let previousAttempt = attempt - 1; previousAttempt >= 0; previousAttempt--) {
    const prior = await readJob(previousAttempt);
    if (prior?.status?.active || (prior && !prior.status?.succeeded && !prior.status?.failed && !prior.status?.conditions?.some(
      (c: any) => ["Complete", "Failed"].includes(c.type) && c.status === "True",
    ))) return false; // Never run two coding processes in the same workspace.
  }
  const folder = dir(b.id);
  await mkdir(path.join(folder, "site"), { recursive: true });
  const oldRequest = await readFile(path.join(folder, "request.json"), "utf8").then(JSON.parse).catch(() => null);
  const lineage = b.parent_id ? lineageSchema.parse(b.result?.lineage) : null;
  if (lineage && lineage.parentBuildId !== b.parent_id) throw Error("Build parent does not match its pinned source");
  if (lineage && !oldRequest) {
    // Fetch through the engine's authenticated connection. The coding sandbox
    // receives only the exact committed files, never repository credentials.
    const files = await committedBuildSource(service ? serviceRepoApi(config.productId) : repoApi(b.organization_id), lineage.parentCommit, forgejo, service);
    const staging = path.join(folder, ".seed-" + randomUUID());
    try {
      await mkdir(staging);
      for (const f of files) {
        const dest = path.join(staging, f.name);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.data);
      }
      await rm(path.join(folder, "site"), { recursive: true });
      await rename(staging, path.join(folder, "site"));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (lineage && oldRequest && (oldRequest.lineage?.parentBuildId !== lineage.parentBuildId || oldRequest.lineage?.parentCommit !== lineage.parentCommit))
    throw Error("Existing revision workspace does not match its pinned parent commit");
  if (attempt && oldRequest?.attempt !== attempt) {
    const archivedAttempt = Number.isSafeInteger(oldRequest?.attempt) && oldRequest.attempt >= 0
      ? oldRequest.attempt : 0;
    const archive = path.join(folder, "attempts", String(archivedAttempt));
    await mkdir(archive, { recursive: true });
    for (const file of ["result.json", "progress.json"]) {
      await rename(path.join(folder, file), path.join(archive, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  const maxIterations = z.coerce.number().int().min(1).max(1000).parse(process.env.OPENHANDS_MAX_ITERATIONS || "200");
  await writeFile(
    path.join(folder, "request.json"),
    JSON.stringify({ id: b.id, brief: b.brief, attempt, resume: attempt > 0, maxIterations, budget: {...budget,chunkTurns: Math.min(maxIterations,budget.chunkTurns)}, runtime:service ? "service":"static", service:config.service, ...(lineage ? { lineage } : {}) }),
  );
  if(config.executor === "kelos") {
    await startKelosBuild({id:b.id,attempt,image:process.env.KELOS_OPENHANDS_IMAGE || "agent-engine-openhands-kelos:local",model:process.env.OPENHANDS_MODEL || "openai/gpt-6-astra",maxSeconds:budget.maxSeconds,maxIterations});
    return true;
  }
  await kubernetes(p, "POST", {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, labels: { "revos-build": b.id } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: budget.maxSeconds+120,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { "revos-build": b.id } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers: [
            {
              name: "openhands",
              image:
                process.env.OPENHANDS_IMAGE || "agent-engine-openhands:local",
              imagePullPolicy: "IfNotPresent",
              env: [
                {
                  name: "OPENAI_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: "openai-secrets",
                      key: "OPENAI_API_KEY",
                    },
                  },
                },
                {
                  name: "OPENHANDS_MODEL",
                  value: process.env.OPENHANDS_MODEL || "openai/gpt-6-astra",
                },
                { name: "OPENHANDS_MAX_ITERATIONS", value: String(maxIterations) },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/workspace",
                  subPath: "jobs/" + b.id,
                },
              ],
              resources: {
                requests: { cpu: "100m", memory: "256Mi" },
                limits: { cpu: "2", memory: "2Gi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: { claimName: "build-data" },
            },
          ],
        },
      },
    },
  });
  return true;
}
async function recordCodingUsage(b:any,result:any) {
  const usage=result.usage;
  if (!usage) return;
  const baseline=b.result?.usage || {};
  for(const [field,category] of [["inputTokens","llm_input"],["outputTokens","llm_output"]] as const) {
    const value=usage[field], prior=baseline[field] || 0;
    if(!Number.isSafeInteger(value) || value<prior) continue;
    await recordUsage({organizationId:b.organization_id,productId:b.product_id || undefined,runId:b.run_id || undefined,buildId:b.id,provider:"openhands",category,eventKey:`build:${b.id}:${category}`,attemptId:String(buildAttempt(b)),units:value-prior,unit:"tokens",metadata:{model:process.env.OPENHANDS_MODEL || "openai/gpt-6-astra",source:"openhands-sdk",sdkEstimatedCostUsd:usage.sdkEstimatedCostUsd ?? null}});
  }
}
export async function tickCodeBuild(id: string, expectedAttempt = 0) {
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext($1))", ["build:" + id]);
  try {
    const b = (await pool.query("SELECT * FROM code_build WHERE id=$1", [id]))
      .rows[0];
    if (!b) throw Error("Build missing");
    if (buildAttempt(b) !== expectedAttempt) return true;
    if (b.state === "completed") {
      if (b.source_key.startsWith("product:") && !b.result?.previewUrl && b.result?._config?.runtime!=="service")
        await previewBuild(id, b.organization_id);
      return true;
    }
    if (["failed","paused"].includes(b.state)) return true;
    if (!(await startJob(b))) return false;
    await pool.query(
      "UPDATE code_build SET state='running',updated_at=now() WHERE id=$1",
      [id],
    );
    const job = b.result?._config?.executor === "kelos" ? await getKelosBuild(id,expectedAttempt) : await kubernetes(
      `/apis/batch/v1/namespaces/${buildNamespace()}/jobs/${buildJobName(id, expectedAttempt)}`,
    );
    const failed =
      job?.status?.failed ||
      job?.status?.conditions?.some(
        (c: any) => c.type === "Failed" && c.status === "True",
      );
    if (!failed && !job?.status?.succeeded) return false;
    const result = await readFile(path.join(dir(id), "result.json"), "utf8").then(JSON.parse).catch(()=>null);
    if (!result) throw Error("OpenHands job stopped without a result; its workspace and conversation remain available to resume.");
    await recordCodingUsage(b,result);
    if (failed || result.state === "failed") {
      await pool.query("UPDATE code_build SET result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",[id,JSON.stringify(result)]);
      throw Error(result.error || "OpenHands job failed. Inspect the build logs.");
    }
    if (result.state === "paused") {
      await pool.query("UPDATE code_build SET state='paused',result=coalesce(result,'{}'::jsonb)||$2::jsonb,error=$3,updated_at=now() WHERE id=$1",[id,JSON.stringify(result),result.reason || "Coding budget needs review"]);
      return true;
    }
    if (result.state !== "completed")
      throw Error(result.error || "Build failed");
    const service=b.result?._config?.runtime === "service";
    const files = await siteFiles(id,service),
      api = service ? serviceRepoApi(b.result._config.productId) : repoApi(b.organization_id),
      branch = "build-" + id;
    if (!(await forgejo(api)))
      await forgejo("/user/repos", "POST", {
        name: service ? serviceRepositoryName(b.result._config.productId) : repository(b.organization_id),
        private: true,
        auto_init: true,
        default_branch: "main",
      });
    const lineage = b.parent_id ? lineageSchema.parse(b.result?.lineage) : null;
    const commit = await publishBuildSource(api, branch, lineage?.parentCommit ?? "main", files, forgejo, service);
    const repositoryLink=service ? serviceRepositoryUrl(b.result._config.productId) : repoUrl(b.organization_id);
    await pool.query(
      "UPDATE code_build SET state='completed',result=$2,error=NULL,updated_at=now() WHERE id=$1",
      [
        id,
        JSON.stringify({
          ...result,
          ...(b.result?._config ? {_config:b.result._config} : {}),
          ...(lineage ? { lineage } : {}),
          ...(b.result?._retry ? { _retry: b.result._retry, _attemptHistory: b.result._attemptHistory } : {}),
          files: files.map((f) => f.name),
          commit,
          branch,
          repositoryUrl: repositoryLink,
          codeUrl: repositoryLink + "/src/commit/" + commit,
        }),
      ],
    );
    if (b.source_key.startsWith("product:") && !service)
      await previewBuild(id, b.organization_id);
    return true;
  } catch (e) {
    await pool.query(
      "UPDATE code_build SET state='failed',error=$2,updated_at=now() WHERE id=$1",
      [id, String(e)],
    );
    return true;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
      "build:" + id,
    ]);
    lock.release();
  }
}
export async function resumeCodeBuild(id: string, requestId: string, budget?: unknown) {
  z.uuid().parse(id);
  z.uuid().parse(requestId);
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", ["build:" + id]);
    const b = (await lock.query("SELECT * FROM code_build WHERE id=$1", [id])).rows[0];
    if (!b) throw Error("Build missing");
    if (acceptedBuildResume(b, requestId)) return b;
    const result = resumedBuildResult(b, requestId);
    if (budget) result._config={...result._config,budget:codingBudgetSchema.parse(budget)};
    return (await lock.query(
      "UPDATE code_build SET state='pending',result=$2,error=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [id, JSON.stringify(result)],
    )).rows[0];
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", ["build:" + id]);
    lock.release();
  }
}
export async function createCodeBuild(
  org: string,
  runId: string | null,
  key: string,
  brief: string,
  parentId?: string,
  options?: {productId?:string;runtime?:"service";runtimeKind?:"static"|"service";service?:unknown;executor?:string;budget?:unknown},
) {
  const existing = (await pool.query("SELECT * FROM code_build WHERE source_key=$1", [key])).rows[0];
  if (existing) return codeBuildReceipt(existing, org);
  let lineage = null;
  let configuration: any = options;
  if(options?.productId) {
    const product=(await pool.query("SELECT p.*,d.configuration FROM platform_product p LEFT JOIN product_delivery_config d ON d.product_id=p.id WHERE p.id=$1 AND p.organization_id=$2",[options.productId,org])).rows[0];
    if(!product) throw Error("Product does not belong to this organization");
    if(product.runtime_kind==='service' || options.runtime==='service' || options.runtimeKind==='service') {
      if(!product.configuration) throw Error("Configure backend hosting before building this service");
      const service=serviceConfigSchema.parse(product.configuration);
      configuration={productId:product.id,runtime:'service',service,executor:service.executor,budget:service.budget};
    }
  }
  if (parentId) {
    const p = (
      await pool.query(
        "SELECT * FROM code_build WHERE id=$1 AND organization_id=$2 AND state='completed'",
        [parentId, org],
      )
    ).rows[0];
    lineage = pinnedBuildLineage(p, org);
    configuration = configuration?.runtime==='service' ? configuration : {...p.result?._config,...configuration};
    if(!Object.keys(configuration).length) configuration=undefined;
    if (options?.productId && (p.product_id || p.result?._config?.productId || p.id)!==options.productId) throw Error("Revision source belongs to another product");
  }
  const b = (
    await pool.query(
      "INSERT INTO code_build(organization_id,run_id,source_key,brief,parent_id,result,product_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_key) DO UPDATE SET source_key=excluded.source_key RETURNING *",
      [org, runId, key, brief, parentId ?? null, lineage || configuration ? JSON.stringify({ ...(lineage?{lineage}:{}),...(configuration?{_config:configuration}:{}) }) : null,configuration?.productId ?? null],
    )
  ).rows[0];
  return codeBuildReceipt(b, org);
}
function codeBuildReceipt(b: any, org: string) {
  if (b.organization_id !== org) throw Error("Build operation belongs to another customer");
  return {
    codeBuildId: b.id,
    state: b.state,
    ...(b.result?.lineage ? { lineage: lineageSchema.parse(b.result.lineage) } : {}),
    instruction:
      b.result?._config?.runtime==='service' ? "The engine waits for the backend source build. A tested container image and approved GitOps release are required before this product has a running preview." : "The engine waits for this build. Call inspect_build next to read its result, then create_preview to publish the static preview.",
  };
}
export async function previewBuild(id: string, org: string) {
  const b = (
    await pool.query(
      "SELECT * FROM code_build WHERE id=$1 AND organization_id=$2 AND state='completed'",
      [id, org],
    )
  ).rows[0];
  if (!b) throw Error("Completed build missing");
  if(b.result?._config?.runtime==='service') throw Error("Backend services use tested container releases; approve a service release instead of the static preview action");
  const dest = path.join(root(), "previews", id);
  await mkdir(dest, { recursive: true });
  for (const f of await siteFiles(id)) {
    const target = path.join(dest, f.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.data);
  }
  const previewUrl = `${process.env.PREVIEW_PUBLIC_URL || "http://localhost:3002"}/${id}/`;
  await pool.query(
    "UPDATE code_build SET result=result||$2::jsonb WHERE id=$1",
    [id, JSON.stringify({ previewUrl })],
  );
  return { previewUrl, commit: b.result.commit, codeUrl: b.result.codeUrl };
}
export const codeToolDefinitions = [
  [
    "start_build",
    "Build with OpenHands",
    "Build a static site or configured backend product. Pass productId or use the campaign product to inherit its runtime and hosting configuration. The engine waits durably for the coding job.",
  ],
  [
    "revise_build",
    "Revise an OpenHands build",
    "Create a new version from an existing completed build, with human feedback.",
  ],
  [
    "inspect_build",
    "Inspect an OpenHands build",
    "Read build status, source code, commit and file list.",
  ],
  [
    "create_preview",
    "Create a preview link",
    "Publish a completed static build to the isolated preview service.",
  ],
].map(([slug, name, description]) => ({
  slug: "openhands-" + slug,
  name,
  handler: "openhands." + slug,
  description,
  inputSchema: {
    type: "object",
    required:
      slug === "start_build"
        ? ["brief"]
        : slug === "revise_build"
          ? ["brief", "buildId"]
          : ["buildId"],
    additionalProperties: false,
    properties: {
      ...(slug.includes("build") && !["inspect_build"].includes(slug)
        ? { brief: { type: "string", minLength: 1, maxLength: 12000 }, productId: {type:"string",format:"uuid"} }
        : {}),
      ...(slug !== "start_build"
        ? { buildId: { type: "string", format: "uuid" } }
        : {}),
    },
  },
  outputSchema: { type: "object" },
}));
export function registerCodeTools(registry: ToolRegistry) {
  for (const d of codeToolDefinitions)
    registry.register(
      d.handler,
      async (input, _configuration, ctx) => {
        const sid = z.uuid().parse(ctx?.idempotencyKey.split(":")[0]);
        const row = (
          await pool.query(
            "SELECT r.id,r.customer_organization_id AS org FROM reasoning_session s JOIN run r ON r.id=s.run_id WHERE s.id=$1",
            [sid],
          )
        ).rows[0];
        if (!row?.org) throw Error("Resolve the customer before building");
        const creating = d.handler.endsWith("start_build") || d.handler.endsWith("revise_build");
        if (creating) {
          const existing = (await pool.query("SELECT * FROM code_build WHERE source_key=$1", [ctx!.idempotencyKey])).rows[0];
          if (existing) return codeBuildReceipt(existing, row.org);
        }
        const b = z
          .object({
            brief: z.string().min(1).max(12000).optional(),
            buildId: z.uuid().optional(),
            productId:z.uuid().optional(),
          })
          .parse(input);
        if (creating) {
          if (d.handler.endsWith("start_build")) {
            if (b.buildId) throw Error("Use revise_build to change an existing build");
            const state = (await pool.query(
              "SELECT outcome->'state' AS state FROM reasoning_turn WHERE session_id=$1 AND outcome IS NOT NULL ORDER BY turn DESC LIMIT 1", [sid],
            )).rows[0]?.state;
            if (state?.revisionPending) {
              const completed = (await pool.query(
                "SELECT id FROM code_build WHERE organization_id=$1 AND source_key LIKE $2 AND state='completed' ORDER BY created_at DESC LIMIT 1", [row.org, sid + ":%"],
              )).rows[0];
              if (completed) return {
                state: "not_started",
                reason: "existing_build_requires_revision",
                existingBuildId: completed.id,
                instruction: "This review is revising an existing build. Use revise_build with buildId set to existingBuildId and brief containing the feedback, or inspect_build if its result already satisfies the review. No new build was started.",
              };
            }
          } else {
            z.uuid().parse(b.buildId);
          }
          const campaignProduct=(await pool.query("SELECT c.product_id FROM engagement_attempt a JOIN platform_campaign c ON c.engagement_id=a.engagement_id WHERE a.run_id=$1 AND c.organization_id=$2 AND c.product_id IS NOT NULL LIMIT 1",[row.id,row.org])).rows[0]?.product_id;
          if(campaignProduct && b.productId && b.productId!==campaignProduct) throw Error("Build must use the product assigned to this campaign");
          const productId=campaignProduct || b.productId;
          return createCodeBuild(
            row.org,
            row.id,
            ctx!.idempotencyKey,
            z.string().parse(b.brief),
            b.buildId,
            productId ? {productId}:undefined,
          );
        }
        if (d.handler.endsWith("create_preview"))
          return previewBuild(z.uuid().parse(b.buildId), row.org);
        const found = (
          await pool.query(
            "SELECT id,state,result,error FROM code_build WHERE id=$1 AND organization_id=$2",
            [b.buildId, row.org],
          )
        ).rows[0];
        if (!found) throw Error("Build not found in this customer");
        return found;
      },
      { retrySafe: true },
    );
}

export async function requireCompletedBuild(runId: string) {
  if (
    !(
      await pool.query(
        "SELECT id FROM code_build WHERE run_id=$1 AND state='completed' AND result->>'previewUrl' IS NOT NULL",
        [runId],
      )
    ).rowCount
  )
    throw Error(
      "Product step requires a completed OpenHands build and a published preview; no verified build exists for this run",
    );
}
