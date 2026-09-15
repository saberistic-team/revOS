import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { eq, and, asc, sql } from "drizzle-orm";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  agents,
  tasks,
  runs,
  runSteps,
} from "../../../packages/database/src";
import { validate } from "../../../packages/engine/src";
import {
  connectionOptions,
  namespace,
  taskQueue,
  connectWithRetry,
} from "../../../packages/temporal/src/config";
import type { Json, Review } from "../../../packages/shared/src";
async function main() {
  const connection = await connectWithRetry(() =>
    Connection.connect(connectionOptions()),
  );
  const client = new Client({ connection, namespace });
  const app = Fastify({ logger: true });
  const idParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } },
  };
  async function start(run: typeof runs.$inferSelect) {
    try {
      await client.workflow.start("AgentRunWorkflow", {
        workflowId: run.temporalWorkflowId,
        taskQueue,
        args: [
          {
            runId: run.id,
            workflowVersionId: run.workflowVersionId,
            input: run.input,
          },
        ],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (e) {
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    }
  }
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      await connection.workflowService.getSystemInfo({});
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/workflows", async () => db.select().from(workflows));
  app.get<{ Params: { id: string } }>(
    "/workflows/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, request.params.id));
      if (!workflow)
        return reply.code(404).send({ error: "Workflow not found" });
      const version = workflow.currentVersionId
        ? (
            await db
              .select()
              .from(workflowVersions)
              .where(eq(workflowVersions.id, workflow.currentVersionId))
          )[0]
        : null;
      const steps = version
        ? await db
            .select()
            .from(workflowSteps)
            .where(eq(workflowSteps.workflowVersionId, version.id))
            .orderBy(asc(workflowSteps.position))
        : [];
      return { ...workflow, version, steps };
    },
  );
  app.post<{ Params: { id: string }; Body: { input: Json; agentId?: string } }>(
    "/workflows/:id/runs",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["input"],
          additionalProperties: false,
          properties: {
            input: {},
            agentId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await db.transaction(async (tx) => {
        const [workflow] = await tx
          .select()
          .from(workflows)
          .where(eq(workflows.id, request.params.id));
        if (!workflow?.currentVersionId)
          return { error: "Published workflow not found", code: 404 } as const;
        const [version] = await tx
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.id, workflow.currentVersionId));
        try {
          validate(version.inputSchema, request.body.input, "Workflow input");
        } catch (e) {
          return { error: String(e), code: 400 } as const;
        }
        const candidates = await tx
          .select()
          .from(agents)
          .where(
            request.body.agentId
              ? and(
                  eq(agents.organizationId, workflow.organizationId),
                  eq(agents.id, request.body.agentId),
                )
              : eq(agents.organizationId, workflow.organizationId),
          );
        if (candidates.length !== 1)
          return {
            error:
              "Specify a valid agentId when the organization has multiple agents",
            code: 400,
          } as const;
        const [task] = await tx
          .insert(tasks)
          .values({
            organizationId: workflow.organizationId,
            agentId: candidates[0].id,
            workflowId: workflow.id,
            input: request.body.input,
          })
          .returning();
        const id = randomUUID();
        const [run] = await tx
          .insert(runs)
          .values({
            id,
            taskId: task.id,
            workflowVersionId: version.id,
            temporalWorkflowId: `run:${id}`,
            input: request.body.input,
          })
          .returning();
        return { run } as const;
      });
      if ("error" in result)
        return reply.code(result.code ?? 400).send({ error: result.error });
      // The persisted pending Run is a small durable dispatch queue; a periodic sweep repairs interrupted starts.
      try {
        await start(result.run);
      } catch (e) {
        app.log.error(
          { err: e, runId: result.run.id },
          "Temporal start pending; will retry",
        );
      }
      return reply.code(202).send(result.run);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/runs/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, request.params.id));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const steps = await db
        .select({
          id: runSteps.id,
          key: workflowSteps.key,
          position: workflowSteps.position,
          status: runSteps.status,
          input: runSteps.input,
          output: runSteps.output,
          error: runSteps.error,
        })
        .from(runSteps)
        .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
        .where(eq(runSteps.runId, run.id))
        .orderBy(asc(workflowSteps.position));
      return { ...run, steps };
    },
  );
  app.post<{ Params: { id: string }; Body: Review }>(
    "/runs/:id/review",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["stepKey", "approved"],
          additionalProperties: false,
          properties: {
            stepKey: { type: "string" },
            approved: { type: "boolean" },
            note: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, request.params.id));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const [waiting] = await db
        .select()
        .from(runSteps)
        .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
        .where(
          and(
            eq(runSteps.runId, run.id),
            eq(runSteps.status, "waiting"),
            eq(workflowSteps.key, request.body.stepKey),
          ),
        );
      if (run.status !== "waiting" || !waiting)
        return reply
          .code(409)
          .send({ error: "This step is not waiting for review" });
      await client.workflow
        .getHandle(run.temporalWorkflowId)
        .signal("humanReview", request.body);
      return reply.code(202).send({ accepted: true });
    },
  );
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const run of await db
        .select()
        .from(runs)
        .where(eq(runs.status, "pending"))
        .limit(100))
        await start(run);
    } catch (e) {
      app.log.error({ err: e }, "Dispatch retry failed");
    } finally {
      sweeping = false;
    }
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await connection.close();
    await pool.end();
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void app.close());
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
