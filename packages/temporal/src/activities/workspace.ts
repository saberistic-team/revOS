import { generateMindmap } from "../../../engine/src/mindmap";
import { Context } from "@temporalio/activity";
import { eq, and, ne, sql } from "drizzle-orm";
import { db, pool, workspaceJobs, runs, tasks } from "../../../database/src";
import {
  importRun,
  applyChange,
  syncRepository,
} from "../../../engine/src/workspace-service";
import { assistantTurn } from "../../../engine/src/workspace-assistant";
import type { WorkspaceActivities } from "../../../shared/src/workspace";
export function createWorkspaceActivities(): WorkspaceActivities {
  return {
    async prepareRunKnowledgeJob(runId) {
      const [row] = await db
        .select({
          org: sql<string>`coalesce(${runs.customerOrganizationId}, ${tasks.organizationId})`,
        })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .where(eq(runs.id, runId));
      if (!row) throw Error("Run missing");
      await db
        .insert(workspaceJobs)
        .values({
          id: runId,
          organizationId: row.org,
          kind: "import",
          payload: { runId },
          state: "pending",
        })
        .onConflictDoNothing();
      return runId;
    },
    async executeWorkspaceJob(id) {
      const lock = await pool.connect();
      let acquired = false;
      const ctx = Context.current();
      const timer = setInterval(() => ctx.heartbeat({ id }), 10000);
      try {
        acquired = (
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            [id],
          )
        ).rows[0].locked;
        if (!acquired) throw Error("Job already running");
        const [job] = await db
          .select()
          .from(workspaceJobs)
          .where(eq(workspaceJobs.id, id));
        if (!job) throw Error("Workspace job missing");
        if (job.state === "completed") return;
        await db
          .update(workspaceJobs)
          .set({ state: "running", error: null, updatedAt: new Date() })
          .where(eq(workspaceJobs.id, id));
        const signal = AbortSignal.any([
          ctx.cancellationSignal,
          AbortSignal.timeout((job.kind === "mindmap" ? 28 : 8) * 60 * 1000),
        ]);
        let result: any;
        if (job.kind === "import")
          result = await importRun(job.organizationId, job.payload.runId);
        else if (job.kind === "apply")
          result = await applyChange(job.payload.changeId, job.organizationId);
        else if (job.kind === "sync")
          result = await syncRepository(job.organizationId);
        else if (job.kind === "assistant")
          result = await assistantTurn(
            job.organizationId,
            id,
            job.payload,
            signal,
          );
        else if (job.kind === "mindmap")
          result = await generateMindmap(job, signal);
        else throw Error("Unknown workspace job");
        await db
          .update(workspaceJobs)
          .set({ state: "completed", result, updatedAt: new Date() })
          .where(eq(workspaceJobs.id, id));
      } finally {
        clearInterval(timer);
        if (acquired)
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
        lock.release();
      }
    },
    async failWorkspaceJob({ id, error }) {
      const lock = await pool.connect();
      let acquired = false;
      try {
        acquired = (
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            [id],
          )
        ).rows[0].locked;
        if (!acquired)
          throw Error("Workspace job is still running; retry status update");
        await db
          .update(workspaceJobs)
          .set({ state: "failed", error, updatedAt: new Date() })
          .where(
            and(eq(workspaceJobs.id, id), ne(workspaceJobs.state, "completed")),
          );
      } finally {
        if (acquired)
          await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
        lock.release();
      }
    },
  };
}
