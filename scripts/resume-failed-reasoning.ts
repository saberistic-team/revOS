// Administrative recovery for a failed reasoning activity only. Completed tool
// calls and decisions remain immutable and are reused by Temporal replay.
import { Client, Connection } from "@temporalio/client";
import { and, asc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import {
  db,
  pool,
  runs,
  runSteps,
  reasoningSessions,
  reasoningTurns,
} from "../packages/database/src";
import { connectionOptions, namespace } from "../packages/temporal/src/config";

async function main() {
  const runId = z.uuid().parse(process.argv[2]);
  const apply = process.argv.includes("--apply");
  const restartRunning = process.argv.includes("--restart-running");
  const expectedStatus = restartRunning ? "running" : "failed";
  const temporalStatus = restartRunning ? "RUNNING" : "FAILED";
  const connection = await Connection.connect(connectionOptions());
  try {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run || run.status !== expectedStatus)
      throw Error(`Run must be ${expectedStatus}`);
    const sessions = await db
      .select()
      .from(reasoningSessions)
      .where(
        and(
          eq(reasoningSessions.runId, runId),
          eq(reasoningSessions.status, expectedStatus),
        ),
      );
    if (sessions.length !== 1)
      throw Error("Expected exactly one matching reasoning session");
    const session = sessions[0];
    const turns = await db
      .select()
      .from(reasoningTurns)
      .where(eq(reasoningTurns.sessionId, session.id))
      .orderBy(asc(reasoningTurns.turn));
    if (turns.some((t) => !t.outcome))
      throw Error(
        "An uncompleted action needs separate recovery; do not reset it automatically",
      );
    const handle = new Client({ connection, namespace }).workflow.getHandle(
      run.temporalWorkflowId,
    );
    const description = await handle.describe();
    if (description.status.name !== temporalStatus)
      throw Error("Temporal execution status must match the app");
    const history = await handle.fetchHistory();
    const events = history.events ?? [];
    const failed = [...events]
      .reverse()
      .find((e) => e.activityTaskFailedEventAttributes);
    const pending = description.raw.pendingActivities ?? [];
    if (
      restartRunning &&
      (pending.length !== 1 || pending[0].activityType?.name !== "reason")
    )
      throw Error("Only a single pending reasoning activity can be restarted");
    const scheduled = restartRunning
      ? events.find(
          (e) =>
            e.activityTaskScheduledEventAttributes?.activityId ===
            pending[0].activityId,
        )
      : events.find(
          (e) =>
            e.eventId?.toString() ===
            failed?.activityTaskFailedEventAttributes?.scheduledEventId?.toString(),
        );
    const attributes = scheduled?.activityTaskScheduledEventAttributes;
    if (!attributes || attributes.activityType?.name !== "reason")
      throw Error("The last failed activity must be reasoning");
    const payload = attributes.input?.payloads?.[0];
    if (
      !payload?.data ||
      Buffer.from(payload.metadata?.encoding ?? []).toString() !== "json/plain"
    )
      throw Error("Unsupported activity payload encoding");
    const args = JSON.parse(Buffer.from(payload.data).toString());
    if (args.sessionId !== session.id || args.turn !== turns.length)
      throw Error(
        "Failed activity does not match the next uncommitted reasoning turn",
      );
    const cleanup = new Set(["setSessionStatus", "saveRunStep", "failRun"]);
    for (const event of events.filter(
      (e) =>
        Number(e.eventId) >
        Number(restartRunning ? scheduled!.eventId : failed!.eventId),
    )) {
      const name =
        event.activityTaskScheduledEventAttributes?.activityType?.name;
      if (name && !cleanup.has(name))
        throw Error(
          "Later business activities exist; automatic recovery would be unsafe",
        );
    }
    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    const failedStep = steps.find(
      (s) => s.workflowStepId === session.workflowStepId,
    );
    if (failedStep?.status !== expectedStatus)
      throw Error("Failed step state is inconsistent");
    const completedHashes = Object.fromEntries(
      steps
        .filter((s) => s.status === "completed")
        .map((s) => [
          s.id,
          createHash("sha256").update(JSON.stringify(s.output)).digest("hex"),
        ]),
    );
    const plan = {
      runId,
      workflowId: run.temporalWorkflowId,
      originalTemporalRunId: description.runId,
      sessionId: session.id,
      resumeTurn: args.turn,
      resetEventId: attributes.workflowTaskCompletedEventId!.toString(),
      preservedCompletedSteps: Object.keys(completedHashes).length,
      completedHashes,
      originalError: run.error,
      restartRunning,
      requestId: randomUUID(),
    };
    writeFileSync(
      `/tmp/reasoning-recovery-${runId}.json`,
      JSON.stringify(plan, null, 2),
    );
    if (!apply) {
      console.log(
        JSON.stringify({ ...plan, completedHashes: undefined, dryRun: true }),
      );
      return;
    }
    // Hold the session lock across reset so a new reasoning activity cannot read
    // the old failed status before this transaction commits. No history is edited.
    const reset = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      if (locked.status !== expectedStatus)
        throw Error("Run changed during recovery");
      const [lockedSession] = await tx
        .select()
        .from(reasoningSessions)
        .where(eq(reasoningSessions.id, session.id))
        .for("update");
      if (lockedSession.status !== expectedStatus)
        throw Error("Session changed during recovery");
      const latestTurns = await tx
        .select()
        .from(reasoningTurns)
        .where(eq(reasoningTurns.sessionId, session.id));
      if (
        latestTurns.length !== turns.length ||
        latestTurns.some((t) => !t.outcome)
      )
        throw Error("Reasoning progressed during recovery; leave it running");
      const latest = await handle.describe();
      if (
        restartRunning &&
        (latest.raw.pendingActivities?.length !== 1 ||
          latest.raw.pendingActivities[0].activityId !==
            pending[0].activityId ||
          latest.raw.pendingActivities[0].activityType?.name !== "reason")
      )
        throw Error("Pending activity changed during recovery");
      if (
        latest.runId !== description.runId ||
        latest.status.name !== temporalStatus
      )
        throw Error("Temporal execution changed during recovery");
      await tx
        .update(reasoningSessions)
        .set({
          status: "running",
          error: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(reasoningSessions.id, session.id));
      await tx
        .update(runSteps)
        .set({ status: "running", error: null, completedAt: null })
        .where(eq(runSteps.id, failedStep.id));
      await tx
        .update(runs)
        .set({ status: "running", error: null, completedAt: null })
        .where(eq(runs.id, runId));
      return connection.workflowService.resetWorkflowExecution({
        namespace,
        workflowExecution: {
          workflowId: run.temporalWorkflowId,
          runId: description.runId,
        },
        workflowTaskFinishEventId: attributes.workflowTaskCompletedEventId,
        requestId: plan.requestId,
        reason:
          "Resume reasoning after correcting model timeout and output budgets; reuse recorded activities",
        resetReapplyType: 2,
      });
    });
    const result = { ...plan, newTemporalRunId: reset.runId };
    writeFileSync(
      `/tmp/reasoning-recovery-${runId}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify({ ...result, completedHashes: undefined }));
  } finally {
    await connection.close();
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
