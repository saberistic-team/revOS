import { Context } from "@temporalio/activity";
import { pool } from "../../../database/src";
import {
  usageContext,
  type UsageContext,
} from "../../../engine/src/model-usage";
import {
  recordUsageDurably,
  startUsageJournalReplay,
} from "../../../engine/src/usage-journal";

export async function activityOwner(
  name: string,
  args: any[],
  workflowId: string,
): Promise<UsageContext | undefined> {
  let runId = args[0]?.runId;
  if (
    [
      "participationStatus",
      "publishParticipationAnswer",
      "participationReviewedResult",
    ].includes(name)
  ) {
    const question = (
      await pool.query(
        "SELECT organization_id,product_id,campaign_id,run_id FROM participation_question WHERE id=$1",
        [args[0]?.questionId || args[0]],
      )
    ).rows[0];
    if (question)
      return {
        organizationId: question.organization_id,
        productId: question.product_id || undefined,
        campaignId: question.campaign_id || undefined,
        runId: question.run_id || undefined,
      };
  }
  if (name === "deliverParticipationEmail") {
    const mail = (
      await pool.query(
        "SELECT organization_id FROM participation_outbox WHERE id=$1",
        [args[0]],
      )
    ).rows[0];
    if (mail) return { organizationId: mail.organization_id };
  }
  if (name === "tickEngagement") {
    const engagement = (
      await pool.query(
        "SELECT coalesce(customer_organization_id,organization_id) AS organization_id FROM engagement WHERE id=$1",
        [args[0]],
      )
    ).rows[0];
    if (engagement) return { organizationId: engagement.organization_id };
  }
  if (name === "tickCodeBuild" || name === "requireCompletedBuild") {
    const build = (
      await pool.query(
        "SELECT id,organization_id,product_id,run_id FROM code_build WHERE id=$1",
        [args[0]],
      )
    ).rows[0];
    if (build)
      return {
        organizationId: build.organization_id,
        productId: build.product_id ?? undefined,
        buildId: build.id,
        runId: build.run_id ?? undefined,
      };
  }
  if (name === "executeWorkspaceJob" || name === "failWorkspaceJob") {
    const job = (
      await pool.query(
        "SELECT organization_id,payload FROM workspace_job WHERE id=$1",
        [args[0]?.id || args[0]],
      )
    ).rows[0];
    if (job)
      return {
        organizationId: job.organization_id,
        productId: job.payload?.productId ?? undefined,
        campaignId: job.payload?.campaignId ?? undefined,
        runId: job.payload?.runId ?? undefined,
      };
  }
  if (args[0]?.sessionId)
    runId = (
      await pool.query("SELECT run_id FROM reasoning_session WHERE id=$1", [
        args[0].sessionId,
      ])
    ).rows[0]?.run_id;
  if (name === "generateArtifact" || name === "failArtifact")
    runId = (
      await pool.query("SELECT run_id FROM artifact_job WHERE id=$1", [
        args[0]?.jobId || args[0],
      ])
    ).rows[0]?.run_id;
  if (name === "prepareArtifact") runId = args[0]?.source?.runId;
  if (
    [
      "resolveRunOrganization",
      "prepareRunKnowledgeJob",
      "markRunRunning",
      "markRunWaiting",
      "shouldImportRun",
      "isRunPaused",
    ].includes(name)
  )
    runId = args[0];
  const row = (
    await pool.query(
      "SELECT r.id,coalesce(r.customer_organization_id,t.organization_id) AS organization_id FROM run r JOIN task t ON t.id=r.task_id WHERE ($1::uuid IS NOT NULL AND r.id=$1) OR ($1::uuid IS NULL AND r.temporal_workflow_id=$2) LIMIT 1",
      [runId ?? null, workflowId],
    )
  ).rows[0];
  return row
    ? { organizationId: row.organization_id, runId: row.id }
    : undefined;
}
type MeteringDependencies = {
  info?: () => any;
  owner?: typeof activityOwner;
  record?: typeof recordUsageDurably;
  warn?: (message: string) => void;
  startReplay?: boolean;
};
export function meteredActivities<
  T extends Record<string, (...args: any[]) => Promise<any>>,
>(activities: T, dependencies: MeteringDependencies = {}): T {
  const owner = dependencies.owner || activityOwner,
    record = dependencies.record || recordUsageDurably,
    warn = dependencies.warn || console.warn,
    infoFor = dependencies.info || (() => Context.current().info);
  if (dependencies.startReplay !== false) startUsageJournalReplay();
  return Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      async (...args: any[]) => {
        const info = infoFor();
        if (!info.workflowExecution) return fn(...args);
        let scope: UsageContext | undefined;
        try {
          scope = await owner(name, args, info.workflowExecution.workflowId);
        } catch {
          warn("Activity usage attribution unavailable; work will continue");
        }
        if (!scope) return fn(...args);
        const attemptId = `${info.workflowExecution.runId}:${info.activityId}:${info.attempt}`;
        return usageContext.run(
          { ...scope, operation: name, attemptId },
          async () => {
            const started = Date.now();
            let success = false;
            try {
              const result = await fn(...args);
              success = true;
              return result;
            } finally {
              try {
                await record({
                  ...scope,
                  provider: "temporal",
                  category: "temporal",
                  eventKey: attemptId,
                  units: 1,
                  unit: "activity_attempts",
                  metadata: {
                    activity: name,
                    success,
                    durationMs: Date.now() - started,
                    measurement:
                      "activity attempts; not Temporal Cloud billed actions",
                  },
                });
              } catch {
                warn(
                  "Activity usage receipt could not be recorded; work outcome preserved",
                );
              }
            }
          },
        );
      },
    ]),
  ) as T;
}
