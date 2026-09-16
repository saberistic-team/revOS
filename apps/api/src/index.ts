import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { eq, and, asc, desc, sql } from "drizzle-orm";
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
  reasoningSessions,
  reasoningTurns,
} from "../../../packages/database/src";
import { validate } from "../../../packages/engine/src";
import {
  connectionOptions,
  namespace,
  taskQueue,
  connectWithRetry,
} from "../../../packages/temporal/src/config";
import type { Json, Review } from "../../../packages/shared/src";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerBuilder } from "./builder";
async function main() {
  const connection = await connectWithRetry(() =>
    Connection.connect(connectionOptions()),
  );
  const client = new Client({ connection, namespace });
  const app = Fastify({ logger: true });
  const playground = readFileSync(join(__dirname, "playground.html"), "utf8");
  const builder = readFileSync(join(__dirname, "builder.html"), "utf8");
  app.get("/builder", async (_request, reply) =>
    reply.type("text/html").send(builder),
  );
  app.get("/", async (_request, reply) =>
    reply.type("text/html").send(playground),
  );
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
  registerBuilder(app, start);
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
        const [firstStep] = await tx
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.workflowVersionId, version.id))
          .orderBy(asc(workflowSteps.position))
          .limit(1);
        const chosenAgentId =
          request.body.agentId ?? firstStep?.configuration.builderAgentId;
        const candidates = await tx
          .select()
          .from(agents)
          .where(
            typeof chosenAgentId === "string"
              ? and(
                  eq(agents.organizationId, workflow.organizationId),
                  eq(agents.id, chosenAgentId),
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

  app.get<{ Params: { id: string } }>(
    "/workflows/:id/runs",
    { schema: { params: idParams } },
    async (request) =>
      db
        .select({ id: runs.id, status: runs.status, createdAt: runs.createdAt })
        .from(runs)
        .innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(eq(tasks.workflowId, request.params.id))
        .orderBy(desc(runs.createdAt))
        .limit(20),
  );
  app.get<{ Params: { id: string } }>(
    "/runs/:id/history",
    { schema: { params: idParams } },
    async (request, reply) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, request.params.id));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      try {
        const history = await client.workflow
          .getHandle(run.temporalWorkflowId)
          .fetchHistory();
        const all = history.events ?? [];
        const events = all.slice(-200).map((event) => {
          const entry = Object.entries(event).find(
            ([key, value]) => key.endsWith("EventAttributes") && value,
          );
          const attributes = (entry?.[1] ?? {}) as {
            activityType?: { name?: string };
            activityId?: string;
            scheduledEventId?: { toString(): string };
          };
          return {
            id: event.eventId?.toString(),
            type:
              entry?.[0]
                .replace("EventAttributes", "")
                .replace(/([A-Z])/g, " $1")
                .trim() ?? String(event.eventType),
            activity: attributes.activityType?.name,
            activityId: attributes.activityId,
            scheduledEventId: attributes.scheduledEventId?.toString(),
          };
        });
        return {
          events,
          total: all.length,
          truncated: all.length > 200,
          workflowId: run.temporalWorkflowId,
        };
      } catch {
        return reply
          .code(503)
          .send({ error: "Temporal history is not available yet" });
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/runs/:id/sessions",
    { schema: { params: idParams } },
    async (request, reply) => {
      const [run] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, request.params.id));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      return db
        .select({
          id: reasoningSessions.id,
          workflowStepId: reasoningSessions.workflowStepId,
          status: reasoningSessions.status,
          reviewId: reasoningSessions.reviewId,
          output: reasoningSessions.output,
          error: reasoningSessions.error,
        })
        .from(reasoningSessions)
        .where(eq(reasoningSessions.runId, request.params.id));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      const [session] = await db
        .select()
        .from(reasoningSessions)
        .where(eq(reasoningSessions.id, request.params.id));
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const turns = await db
        .select()
        .from(reasoningTurns)
        .where(eq(reasoningTurns.sessionId, session.id))
        .orderBy(asc(reasoningTurns.turn));
      return { ...session, turns, state: turns.at(-1)?.outcome?.state ?? null };
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
            reviewId: { type: "string", maxLength: 100 },
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
      const [session] = await db
        .select()
        .from(reasoningSessions)
        .where(
          and(
            eq(reasoningSessions.runId, run.id),
            eq(reasoningSessions.workflowStepId, waiting.workflow_step.id),
          ),
        );
      if (
        session &&
        (session.status !== "waiting" ||
          !session.reviewId ||
          session.reviewId !== request.body.reviewId)
      )
        return reply.code(409).send({
          error: "A matching current reviewId is required for an agent session",
        });
      await client.workflow
        .getHandle(run.temporalWorkflowId)
        .signal("humanReview", request.body);
      return reply.code(202).send({ accepted: true });
    },
  );
  async function pendingQuestion(runId: string) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run || run.status !== "waiting") return null;
    const waiting = await db
      .select({ step: workflowSteps, session: reasoningSessions })
      .from(reasoningSessions)
      .innerJoin(
        workflowSteps,
        eq(workflowSteps.id, reasoningSessions.workflowStepId),
      )
      .where(
        and(
          eq(reasoningSessions.runId, runId),
          eq(reasoningSessions.status, "waiting"),
        ),
      );
    for (const item of waiting) {
      const [turn] = await db
        .select()
        .from(reasoningTurns)
        .where(eq(reasoningTurns.sessionId, item.session.id))
        .orderBy(desc(reasoningTurns.turn))
        .limit(1);
      if (turn?.decision.action === "ask_human" && !turn.outcome) {
        const question = JSON.parse(turn.decision.payload);
        return {
          questionId: `question:${item.session.id}:${turn.turn}`,
          sessionId: item.session.id,
          stepKey: item.step.key,
          ...question,
        };
      }
    }
    return null;
  }
  app.get<{ Params: { id: string } }>(
    "/runs/:id/question",
    { schema: { params: idParams } },
    async (request) => ({ question: await pendingQuestion(request.params.id) }),
  );
  app.post<{
    Params: { id: string };
    Body: { questionId: string; answer: string };
  }>(
    "/runs/:id/answer",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["questionId", "answer"],
          additionalProperties: false,
          properties: {
            questionId: { type: "string", maxLength: 100 },
            answer: { type: "string", minLength: 1, maxLength: 12000 },
          },
        },
      },
    },
    async (request, reply) => {
      const question = await pendingQuestion(request.params.id);
      if (!question || question.questionId !== request.body.questionId)
        return reply
          .code(409)
          .send({ error: "This question is no longer waiting for an answer" });
      if (!request.body.answer.trim())
        return reply.code(400).send({ error: "Enter an answer" });
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, request.params.id));
      await client.workflow
        .getHandle(run.temporalWorkflowId)
        .signal("humanAnswer", {
          stepKey: question.stepKey,
          questionId: question.questionId,
          answer: request.body.answer,
        });
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
