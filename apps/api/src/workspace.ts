import { requireProduct } from "../../../packages/engine/src/organization-products";
import {
  resolveAssistantContext,
  selectedContextMessage,
} from "../../../packages/engine/src/assistant-context";
import { assistantContextSchema } from "../../../packages/shared/src/assistant-context";
import { assistantScopeSchema } from "../../../packages/shared/src/assistant-scope";
import {
  queueMindmap,
  mindmapState,
} from "../../../packages/engine/src/mindmap";
import type { FastifyInstance } from "fastify";
import {
  Client,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  organizations,
  kbDocuments,
  workspaceChanges,
  workspaceThreads,
  workspaceMessages,
  workspaceJobs,
  runs,
  tasks,
  workflows,
} from "../../../packages/database/src";
import {
  createChange,
  requireOrg,
  workspaceContext,
} from "../../../packages/engine/src/workspace-service";
import {
  repositoryUrl,
  forgejo,
  repoPath,
} from "../../../packages/engine/src/forgejo";
import { knowledgeBodySchema } from "../../../packages/shared/src/workspace";
import { taskQueue } from "../../../packages/temporal/src/config";
export function registerWorkspace(app: FastifyInstance, client: Client) {
  const wrap = (fn: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      return await fn(r);
    } catch (e: any) {
      return reply
        .code(e instanceof z.ZodError ? 400 : (e.statusCode ?? 400))
        .send({ error: e.message });
    }
  };
  const org = (r: any) => z.uuid().parse(r.params.org);
  async function start(id: string) {
    const row = (
      await db
        .select({ kind: workspaceJobs.kind })
        .from(workspaceJobs)
        .where(eq(workspaceJobs.id, id))
    )[0];
    await client.workflow.start(
      row?.kind === "mindmap" ? "MindmapJobWorkflow" : "WorkspaceJobWorkflow",
      {
        workflowId: `workspace:${id}`,
        taskQueue,
        args: [id],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      },
    );
  }
  async function job(organizationId: string, kind: string, payload: any) {
    const [j] = await db
      .insert(workspaceJobs)
      .values({ organizationId, kind, payload })
      .returning();
    try {
      await start(j.id);
    } catch (e) {
      app.log.warn({ jobId: j.id }, "Workspace dispatch pending");
    }
    return j;
  }
  app.get(
    "/workspace/:org/state",
    wrap(async (r) => {
      const id = org(r);
      const context = await workspaceContext(id);
      const recent = await db
        .select({
          id: runs.id,
          status: runs.status,
          createdAt: runs.createdAt,
          workflow: workflows.name,
        })
        .from(runs)
        .innerJoin(tasks, eq(runs.taskId, tasks.id))
        .innerJoin(workflows, eq(tasks.workflowId, workflows.id))
        .where(
          sql`coalesce(${runs.customerOrganizationId}, ${tasks.organizationId}) = ${id}`,
        )
        .orderBy(desc(runs.createdAt))
        .limit(30);
      return {
        mindmap: await mindmapState(id),
        documents: context.documents,
        products: context.products,
        workflows: context.workflows,
        skills: context.skills.map((s) => ({
          id: s.id,
          skillId: s.skillId,
          name: s.name,
          version: s.version,
          knowledgeIds: s.configuration.allowedKnowledgeIds ?? [],
        })),
        changes: await db
          .select()
          .from(workspaceChanges)
          .where(eq(workspaceChanges.organizationId, id))
          .orderBy(desc(workspaceChanges.createdAt))
          .limit(100),
        threads: await db
          .select()
          .from(workspaceThreads)
          .where(eq(workspaceThreads.organizationId, id))
          .orderBy(desc(workspaceThreads.createdAt)),
        jobs: await db
          .select({
            id: workspaceJobs.id,
            kind: workspaceJobs.kind,
            payload: workspaceJobs.payload,
            state: workspaceJobs.state,
            result: workspaceJobs.result,
            error: workspaceJobs.error,
            createdAt: workspaceJobs.createdAt,
          })
          .from(workspaceJobs)
          .where(eq(workspaceJobs.organizationId, id))
          .orderBy(desc(workspaceJobs.createdAt))
          .limit(30),
        runs: recent,
        repositoryUrl: repositoryUrl(id),
        repositoryConfigured: !!process.env.FORGEJO_TOKEN,
      };
    }),
  );
  app.get(
    "/workspace/:org/assistant",
    wrap(async (r) => {
      const id = org(r);
      await requireOrg(id);
      const scope = assistantScopeSchema.parse(r.query.scope);
      const threads = await db
        .select()
        .from(workspaceThreads)
        .where(
          and(
            eq(workspaceThreads.organizationId, id),
            eq(workspaceThreads.scope, scope),
          ),
        )
        .orderBy(desc(workspaceThreads.createdAt));
      const threadIds = threads.map((t) => t.id);
      const jobs = await db
        .select()
        .from(workspaceJobs)
        .where(
          and(
            eq(workspaceJobs.organizationId, id),
            eq(workspaceJobs.kind, "assistant"),
          ),
        )
        .orderBy(desc(workspaceJobs.createdAt))
        .limit(100);
      const changes = await db
        .select()
        .from(workspaceChanges)
        .where(eq(workspaceChanges.organizationId, id))
        .orderBy(desc(workspaceChanges.createdAt))
        .limit(100);
      return {
        threads,
        jobs: jobs.filter((j) => threadIds.includes(j.payload.threadId)),
        changes: changes.filter((c) =>
          threadIds.includes(c.provenance.assistantThreadId),
        ),
      };
    }),
  );
  app.get(
    "/workspace/:org/repository",
    wrap(async (r) => {
      const id = org(r);
      await requireOrg(id);
      const repo = await forgejo(repoPath(id));
      return {
        configured: !!process.env.FORGEJO_TOKEN,
        url: repositoryUrl(id),
        exists: !!repo,
        commits: repo ? await forgejo(repoPath(id) + "/commits?limit=20") : [],
      };
    }),
  );
  app.post(
    "/workspace/:org/import",
    wrap(async (r) => {
      const id = org(r);
      await requireOrg(id);
      const b = z.object({ runId: z.uuid() }).parse(r.body);
      const [run] = await db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(
          and(
            eq(runs.id, b.runId),
            sql`coalesce(${runs.customerOrganizationId}, ${tasks.organizationId}) = ${id}`,
          ),
        );
      if (!run) throw Error("Run not found in this organization");
      return job(id, "import", b);
    }),
  );
  app.post(
    "/workspace/:org/sync",
    wrap(async (r) => {
      const id = org(r);
      await requireOrg(id);
      return job(id, "sync", {});
    }),
  );
  app.post(
    "/workspace/:org/capture",
    wrap(async (r) => {
      const id = org(r);
      const b = z
        .object({
          documentId: z.uuid().nullable().optional(),
          baseRevision: z.number().int().nonnegative().optional(),
          reason: z.string().min(1).max(12000),
          body: knowledgeBodySchema,
        })
        .parse(r.body);
      if (b.documentId && b.baseRevision === undefined)
        throw Error("Supply the document revision when proposing a correction");
      return createChange({
        organizationId: id,
        kind: "knowledge",
        targetId: b.documentId,
        title: b.body.title,
        reason: b.reason,
        body: b.body,
        baseRevision: b.baseRevision,
        provenance: { capture: "human", capturedAt: new Date().toISOString() },
      });
    }),
  );
  app.post(
    "/workspace/:org/changes/:id/approve",
    wrap(async (r) => {
      const organizationId = org(r),
        id = z.uuid().parse(r.params.id);
      const b = z
        .object({ confirmKnowledge: z.boolean().default(false) })
        .parse(r.body ?? {});
      const applyJob = await db.transaction(async (tx) => {
        const [c] = await tx
          .select()
          .from(workspaceChanges)
          .where(
            and(
              eq(workspaceChanges.id, id),
              eq(workspaceChanges.organizationId, organizationId),
            ),
          )
          .for("update");
        if (!c || !["proposed", "failed"].includes(c.state))
          throw Error("This proposal is not awaiting approval");
        await tx
          .update(workspaceChanges)
          .set({
            state: "approved",
            error: null,
            body:
              c.kind === "knowledge" && b.confirmKnowledge
                ? { ...c.body, evidence: "customer_confirmed" }
                : c.body,
            provenance: {
              ...c.provenance,
              approvedBy: "local-user",
              approvedAt: new Date().toISOString(),
              customerConfirmed: b.confirmKnowledge,
            },
            updatedAt: new Date(),
          })
          .where(eq(workspaceChanges.id, id));
        return (
          await tx
            .insert(workspaceJobs)
            .values({
              organizationId,
              kind: "apply",
              payload: { changeId: id },
            })
            .returning()
        )[0];
      });
      try {
        await start(applyJob.id);
      } catch {}
      return applyJob;
    }),
  );
  app.post(
    "/workspace/:org/changes/:id/reject",
    wrap(async (r) => {
      const [c] = await db
        .update(workspaceChanges)
        .set({ state: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceChanges.id, z.uuid().parse(r.params.id)),
            eq(workspaceChanges.organizationId, org(r)),
            eq(workspaceChanges.state, "proposed"),
          ),
        )
        .returning();
      if (!c) throw Error("Proposal is no longer pending");
      return c;
    }),
  );
  app.post(
    "/workspace/:org/threads",
    wrap(async (r) => {
      const id = org(r);
      await requireOrg(id);
      const b = z
        .object({
          title: z
            .string()
            .trim()
            .min(1)
            .max(160)
            .default("Knowledge assistant"),
          scope: assistantScopeSchema.default("knowledge"),
        })
        .parse(r.body ?? {});
      return (
        await db
          .insert(workspaceThreads)
          .values({ organizationId: id, title: b.title, scope: b.scope })
          .returning()
      )[0];
    }),
  );
  app.get(
    "/workspace/:org/threads/:id",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id);
      const [t] = await db
        .select()
        .from(workspaceThreads)
        .where(
          and(
            eq(workspaceThreads.id, id),
            eq(workspaceThreads.organizationId, org(r)),
          ),
        );
      if (!t) throw Error("Conversation not found");
      return {
        thread: t,
        messages: await db
          .select()
          .from(workspaceMessages)
          .where(eq(workspaceMessages.threadId, id))
          .orderBy(asc(workspaceMessages.createdAt)),
      };
    }),
  );
  app.post(
    "/workspace/:org/threads/:id/messages",
    wrap(async (r) => {
      const organizationId = org(r),
        threadId = z.uuid().parse(r.params.id);
      const b = z
        .object({
          content: z.string().trim().min(1).max(12000),
          documentId: z.uuid().nullable().optional(),
          productId: z.uuid().nullable().optional(),
          campaignId: z.uuid().nullable().optional(),
          workflowId: z.uuid().nullable().optional(),
          runId: z.uuid().nullable().optional(),
          context: assistantContextSchema.optional(),
        })
        .parse(r.body);
      const j = await db.transaction(async (tx) => {
        const [t] = await tx
          .select()
          .from(workspaceThreads)
          .where(
            and(
              eq(workspaceThreads.id, threadId),
              eq(workspaceThreads.organizationId, organizationId),
            ),
          )
          .for("update");
        if (!t) throw Error("Conversation not found");
        const selectedContext = b.context
          ? await resolveAssistantContext(organizationId, t.scope, b.context)
          : null;
        if (selectedContext) {
          for (const key of [
            "documentId",
            "productId",
            "campaignId",
            "workflowId",
            "runId",
          ] as const) {
            if (b[key] && b[key] !== selectedContext.selection[key])
              throw Error("Message context disagrees with the selected item");
            b[key] = selectedContext.selection[key];
          }
        }
        if (b.campaignId) {
          if (t.scope !== "knowledge")
            throw Error("Campaign context belongs in Organizations");
          const campaign = (
            await pool.query(
              "SELECT product_id FROM platform_campaign WHERE id=$1 AND organization_id=$2",
              [b.campaignId, organizationId],
            )
          ).rows[0];
          if (!campaign || (b.productId && b.productId !== campaign.product_id))
            throw Error("Campaign does not match this organization or product");
        }
        if (b.productId) {
          if (t.scope !== "knowledge")
            throw Error("Product context belongs in Organizations");
          await requireProduct(organizationId, b.productId);
        }
        if (b.documentId && t.scope !== "knowledge")
          throw Error("Document context belongs in Knowledge");
        if (b.runId && t.scope !== "run")
          throw Error("Run context belongs in Run");
        if (b.workflowId && t.scope === "knowledge")
          throw Error("Workflow authoring belongs in Library");
        const active = await tx
          .select()
          .from(workspaceJobs)
          .where(
            and(
              eq(workspaceJobs.organizationId, organizationId),
              inArray(workspaceJobs.state, ["pending", "running"]),
              sql`${workspaceJobs.payload}->>'threadId' = ${threadId}`,
            ),
          );
        if (active.length)
          throw Error("The assistant is still responding. Wait for its reply.");
        const [m] = await tx
          .insert(workspaceMessages)
          .values({
            threadId,
            role: "user",
            content: selectedContext
              ? selectedContextMessage(b.content, selectedContext.details)
              : b.content,
            metadata: {
              documentId: b.documentId,
              productId: b.productId,
              campaignId: b.campaignId,
              workflowId: b.workflowId,
              runId: b.runId,
              scope: t.scope,
              ...(selectedContext
                ? {
                    displayContent: b.content,
                    context: selectedContext.selection,
                  }
                : {}),
            },
          })
          .returning();
        return (
          await tx
            .insert(workspaceJobs)
            .values({
              organizationId,
              kind: "assistant",
              payload: {
                threadId,
                messageId: m.id,
                documentId: b.documentId,
                productId: b.productId,
                campaignId: b.campaignId,
                workflowId: b.workflowId,
                runId: b.runId,
                ...(selectedContext
                  ? { context: selectedContext.selection }
                  : {}),
              },
            })
            .returning()
        )[0];
      });
      try {
        await start(j.id);
      } catch {}
      return j;
    }),
  );
  app.post(
    "/workspace/:org/jobs/:id/retry",
    wrap(async (r) => {
      const [j] = await db
        .update(workspaceJobs)
        .set({ state: "pending", error: null, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceJobs.id, z.uuid().parse(r.params.id)),
            eq(workspaceJobs.organizationId, org(r)),
            eq(workspaceJobs.state, "failed"),
          ),
        )
        .returning();
      if (!j) throw Error("Only failed jobs can be retried");
      await start(j.id);
      return j;
    }),
  );
  let sweeping = false;
  const timer = setInterval(async () => {
    if (process.env.DISABLE_BACKGROUND_DISPATCH === "true") return;
    if (sweeping) return;
    sweeping = true;
    try {
      for (const o of await db
        .select({ id: organizations.id })
        .from(organizations))
        await queueMindmap(o.id);
      for (const j of await db
        .select()
        .from(workspaceJobs)
        .where(eq(workspaceJobs.state, "pending"))
        .limit(25))
        await start(j.id);
    } catch (e) {
      app.log.warn("Workspace dispatch will retry");
    } finally {
      sweeping = false;
    }
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
