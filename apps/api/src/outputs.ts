import type { FastifyInstance } from "fastify";
import {
  Client,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { z } from "zod";
import { and, eq, asc, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  runs,
  runSteps,
  reasoningSessions,
  reasoningTurns,
  artifactJobs,
  artifactFiles,
} from "../../../packages/database/src";
import {
  outputSettingsSchema,
  stableOutputJson,
  type ArtifactWorkflowInput,
} from "../../../packages/shared/src/outputs";
import { loadOutputSource } from "../../../packages/engine/src/output-source";
import { taskQueue } from "../../../packages/temporal/src/config";
const sourceSchema = z
  .object({
    runId: z.uuid(),
    workflowStepId: z.uuid(),
    sessionId: z.uuid().optional(),
    turn: z.number().int().min(0).optional(),
    fixedSkill: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) => (s.sessionId === undefined) === (s.turn === undefined),
    "Session and turn must be supplied together",
  );
export function registerOutputs(app: FastifyInstance, client: Client) {
  app.get<{ Params: { id: string } }>(
    "/runs/:id/outputs",
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success)
        return reply.code(400).send({ error: "Invalid run ID" });
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, req.params.id));
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const steps = await db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, run.id));
      const sessions = await db
        .select()
        .from(reasoningSessions)
        .where(eq(reasoningSessions.runId, run.id));
      const turns = sessions.length
        ? await db
            .select()
            .from(reasoningTurns)
            .where(
              inArray(
                reasoningTurns.sessionId,
                sessions.map((s) => s.id),
              ),
            )
            .orderBy(asc(reasoningTurns.turn))
        : [];
      const jobs = await db
        .select({
          id: artifactJobs.id,
          runId: artifactJobs.runId,
          workflowStepId: artifactJobs.workflowStepId,
          sessionId: artifactJobs.sessionId,
          turn: artifactJobs.turn,
          skillVersionId: artifactJobs.skillVersionId,
          title: artifactJobs.title,
          state: artifactJobs.state,
          error: artifactJobs.error,
          settings: artifactJobs.settings,
          sourceHash: artifactJobs.sourceHash,
          createdAt: artifactJobs.createdAt,
        })
        .from(artifactJobs)
        .where(eq(artifactJobs.runId, run.id));
      const files = jobs.length
        ? await db
            .select({
              id: artifactFiles.id,
              jobId: artifactFiles.jobId,
              filename: artifactFiles.filename,
              mimeType: artifactFiles.mimeType,
              byteSize: artifactFiles.byteSize,
              sha256: artifactFiles.sha256,
            })
            .from(artifactFiles)
            .where(
              inArray(
                artifactFiles.jobId,
                jobs.map((j) => j.id),
              ),
            )
        : [];
      const sources: any[] = [];
      for (const step of run.executionDefinition?.steps ?? []) {
        const saved = steps.find((s) => s.workflowStepId === step.id);
        if (saved?.status === "completed")
          sources.push({
            kind: "step",
            title: step.name,
            output: saved.output,
            settings: outputSettingsSchema.parse(
              step.configuration.outputs ?? {},
            ),
            source: { runId: run.id, workflowStepId: step.id },
          });
        for (const session of sessions.filter(
          (s) => s.workflowStepId === step.id,
        ))
          for (const turn of turns.filter(
            (t) =>
              t.sessionId === session.id &&
              t.decision.action === "complete_skill" &&
              t.outcome,
          )) {
            const skill = session.snapshot.catalog.find(
              (s) => s.id === turn.decision.target,
            );
            sources.push({
              kind: "skill",
              title: skill?.name || "Completed skill",
              skillVersionId: skill?.id,
              output: JSON.parse(turn.decision.payload),
              settings: outputSettingsSchema.parse(
                skill?.configuration.outputs ?? {},
              ),
              source: {
                runId: run.id,
                workflowStepId: step.id,
                sessionId: session.id,
                turn: turn.turn,
              },
            });
          }
        if (
          saved?.status === "completed" &&
          step.type === "skill" &&
          step.skill?.executionType !== "agent"
        )
          sources.push({
            kind: "skill",
            title: step.name,
            skillVersionId: step.skill?.id,
            output: saved.output,
            settings: outputSettingsSchema.parse(
              step.skill?.configuration.outputs ?? {},
            ),
            source: {
              runId: run.id,
              workflowStepId: step.id,
              fixedSkill: true,
            },
          });
      }
      return {
        sources,
        jobs: jobs.map((j) => ({
          ...j,
          files: files.filter((f) => f.jobId === j.id),
        })),
      };
    },
  );
  async function start(input: ArtifactWorkflowInput) {
    const id =
      "artifact-manual:" +
      createHash("sha256").update(stableOutputJson(input)).digest("hex");
    await client.workflow.start("OutputArtifactWorkflow", {
      workflowId: id,
      taskQueue,
      args: [input],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    });
    return { workflowId: id, status: "queued" };
  }
  app.post("/outputs/generate", async (req, reply) => {
    const parsed = z
      .object({
        source: sourceSchema,
        settings: outputSettingsSchema.optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.message });
    let source;
    try {
      source = await loadOutputSource(parsed.data.source);
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
    const settings = parsed.data.settings ?? source.settings;
    if (!settings.artifacts.formats.length)
      return reply.code(400).send({ error: "Choose an artifact format" });
    return reply
      .code(202)
      .send(await start({ ...parsed.data, settings, manual: true }));
  });
  app.post<{ Params: { id: string } }>(
    "/artifacts/:id/retry",
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success)
        return reply.code(400).send({ error: "Invalid artifact ID" });
      const [job] = await db
        .select()
        .from(artifactJobs)
        .where(eq(artifactJobs.id, req.params.id));
      if (!job) return reply.code(404).send({ error: "Artifact not found" });
      if (job.state !== "failed")
        return reply
          .code(409)
          .send({ error: "Only failed artifacts can be retried" });
      return reply.code(202).send(
        await start({
          source: {
            runId: job.runId,
            workflowStepId: job.workflowStepId,
            ...(job.sessionId
              ? { sessionId: job.sessionId, turn: job.turn! }
              : job.skillVersionId
                ? { fixedSkill: true }
                : {}),
          },
          settings: job.settings,
          manual: true,
        }),
      );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    "/artifacts/files/:id",
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success)
        return reply.code(400).send({ error: "Invalid file ID" });
      const [file] = await db
        .select()
        .from(artifactFiles)
        .where(eq(artifactFiles.id, req.params.id));
      if (!file)
        return reply.code(404).send({ error: "Artifact file not found" });
      const inline =
        !req.query.download &&
        ["application/pdf", "image/png"].includes(file.mimeType);
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox")
        .header(
          "Content-Disposition",
          `${inline ? "inline" : "attachment"}; filename="${file.filename.replace(/["\r\n]/g, "_")}"`,
        )
        .type(file.mimeType)
        .send(Buffer.from(file.contentBase64, "base64"));
    },
  );
}
