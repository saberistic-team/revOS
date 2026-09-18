import { createHash, randomUUID } from "node:crypto";
import { engagementAttempts, pool } from "../../database/src";
import { createWorkflowRun, assertWorkflowAccess } from "./run-service";
import { validate } from "./index";
import { handoffInput } from "../../shared/src/engagement";
import type { PoolClient } from "pg";
function stableId(key: string) {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function createEngagement(
  templateId: string,
  input: any,
  name: string,
  customerId?: string,
  options: { queryClient?: Pick<PoolClient, "query">; id?: string } = {},
) {
  const queryClient = options.queryClient ?? pool;
  const t = (
    await queryClient.query("SELECT * FROM engagement_template WHERE id=$1", [
      templateId,
    ])
  ).rows[0];
  if (!t) throw Error("Engagement template missing");
  const stages = [];
  for (const s of t.stages) {
    const w = await assertWorkflowAccess(s.workflowId, t.organization_id);
    stages.push({ ...s, versionId: w.currentVersionId });
  }
  if (!stages.length) throw Error("Engagement chain needs a starting workflow");
  const firstVersion = (await queryClient.query("SELECT input_schema FROM workflow_version WHERE id=$1", [stages[0].versionId])).rows[0];
  validate(firstVersion.input_schema, handoffInput(input, null, null, []), "Engagement starting inputs");
  if (
    customerId &&
    !(
      await queryClient.query(
        "SELECT id FROM organization WHERE id=$1 AND kind='customer'",
        [customerId],
      )
    ).rowCount
  )
    throw Error("Customer missing");
  return (
    await queryClient.query(
      "INSERT INTO engagement(id,organization_id,customer_organization_id,name,stages,input) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        options.id ?? randomUUID(),
        t.organization_id,
        customerId ?? null,
        name,
        JSON.stringify(stages),
        JSON.stringify(input),
      ],
    )
  ).rows[0];
}
export async function tickEngagement(id: string) {
  const c = await pool.connect();
  await c.query("SELECT pg_advisory_lock(hashtext($1))", [id]);
  try {
    const e = (await c.query("SELECT * FROM engagement WHERE id=$1", [id]))
      .rows[0];
    if (!e) throw Error("Engagement missing");
    if (e.state === "completed" || e.state === "cancelled") return true;
    if (e.state === "paused") return false;
    const attempts = (
      await c.query(
        "SELECT * FROM engagement_attempt WHERE engagement_id=$1 ORDER BY stage_index,revision",
        [id],
      )
    ).rows;
    const a = attempts.filter((x) => x.stage_index === e.stage_index).at(-1);
    if (a?.state === "approved") {
      // Run knowledge must be persisted before the next workflow takes its snapshot.
      const job = (
        await c.query(
          "SELECT * FROM workspace_job WHERE kind='import' AND payload->>'runId'=$1 ORDER BY created_at DESC LIMIT 1",
          [a.run_id],
        )
      ).rows[0];
      if (!job) return { importRunId: a.run_id };
      if (job?.state !== "completed") {
        await c.query("UPDATE engagement SET error=$2 WHERE id=$1", [
          id,
          job?.state === "failed"
            ? "Knowledge handoff failed. Retry the import in Knowledge."
            : "Waiting for the knowledge handoff.",
        ]);
        return false;
      }
      const pending = job.result?.proposalIds ?? [];
      if (
        pending.length &&
        (
          await c.query(
            "SELECT id FROM workspace_change WHERE id=ANY($1::uuid[]) AND state NOT IN ('applied','rejected')",
            [pending],
          )
        ).rowCount
      ) {
        await c.query("UPDATE engagement SET error=$2 WHERE id=$1", [
          id,
          "Review knowledge conflicts in Knowledge before continuing.",
        ]);
        return false;
      }
      await c.query(
        "UPDATE engagement SET stage_index=stage_index+1,state=$2,error=NULL,updated_at=now() WHERE id=$1",
        [id, e.stage_index + 1 >= e.stages.length ? "completed" : "running"],
      );
      return e.stage_index + 1 >= e.stages.length;
    }
    if (!a || a.state === "revision_requested") {
      const revision = (a?.revision ?? 0) + 1;
      const runId = stableId(`${id}:${e.stage_index}:${revision}`);
      const previous = attempts
        .filter(
          (x) => x.stage_index === e.stage_index - 1 && x.state === "approved",
        )
        .at(-1);
      const feedback = a
        ? (
            await c.query(
              "SELECT content,source FROM run_feedback WHERE run_id=$1 ORDER BY created_at",
              [a.run_id],
            )
          ).rows
        : [];
      if (a?.feedback)
        feedback.push({ content: a.feedback, source: a.decision_by });
      const input = handoffInput(
        e.input,
        previous ? { runId: previous.run_id, output: previous.output, approval:{feedback:previous.feedback,source:previous.decision_by,approvedAt:previous.approved_at} } : null,
        a ? { runId: a.run_id, output: a.output } : null,
        feedback,
      );
      const s = e.stages[e.stage_index];
      const result = await createWorkflowRun(
        s.workflowId,
        input,
        undefined,
        e.customer_organization_id ?? undefined,
        runId,
        s.versionId,
        !!e.customer_organization_id,
        async (tx, run) => {
          await tx
            .insert(engagementAttempts)
            .values({
              engagementId: id,
              stageIndex: e.stage_index,
              revision,
              runId: run.id,
            })
            .onConflictDoNothing();
        },
      );
      if ("error" in result) throw Error(result.error);
      await c.query(
        "UPDATE engagement SET state='running',error=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      return false;
    }
    if (a.state === "awaiting_approval" || a.state === "failed") return false;
    const run = (await c.query("SELECT * FROM run WHERE id=$1", [a.run_id]))
      .rows[0];
    if (run.customer_organization_id && !e.customer_organization_id)
      await c.query(
        "UPDATE engagement SET customer_organization_id=$2 WHERE id=$1",
        [id, run.customer_organization_id],
      );
    if (run.status === "completed") {
      await c.query(
        "UPDATE engagement_attempt SET state='awaiting_approval',output=$2 WHERE id=$1",
        [a.id, JSON.stringify(run.output)],
      );
      await c.query(
        "UPDATE engagement SET state='awaiting_approval',updated_at=now() WHERE id=$1",
        [id],
      );
    } else if (["failed", "cancelled"].includes(run.status)) {
      await c.query(
        "UPDATE engagement_attempt SET state='failed' WHERE id=$1",
        [a.id],
      );
      await c.query(
        "UPDATE engagement SET state='needs_attention',error=$2 WHERE id=$1",
        [id, run.error ?? run.status],
      );
    }
    return false;
  } catch (error) {
    await c.query(
      "UPDATE engagement SET state='needs_attention',error=$2 WHERE id=$1",
      [id, String(error)],
    );
    return false;
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
    c.release();
  }
}

export async function isRunPaused(runId: string) {
  return !!(
    await pool.query(
      "SELECT 1 FROM engagement e JOIN engagement_attempt a ON a.engagement_id=e.id WHERE a.run_id=$1 AND e.state='paused'",
      [runId],
    )
  ).rowCount;
}

export async function shouldImportRun(runId: string) {
  return !(
    await pool.query("SELECT id FROM engagement_attempt WHERE run_id=$1", [
      runId,
    ])
  ).rowCount;
}
