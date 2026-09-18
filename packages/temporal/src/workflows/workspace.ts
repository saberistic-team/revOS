import { proxyActivities, CancellationScope } from "@temporalio/workflow";
import type { WorkspaceActivities } from "../../../shared/src/workspace";
const activities = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: "15 minutes",
  scheduleToCloseTimeout: "35 minutes",
  heartbeatTimeout: "45 seconds",
  retry: { maximumAttempts: 2, initialInterval: "5 seconds" },
});
const bookkeeping = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
export async function WorkspaceJobWorkflow(id: string) {
  try {
    await activities.executeWorkspaceJob(id);
  } catch (e) {
    await CancellationScope.nonCancellable(() =>
      bookkeeping.failWorkspaceJob({
        id,
        error: String((e as Error & { cause?: Error }).cause ?? e),
      }),
    );
  }
}

export async function RunKnowledgeWorkflow(runId: string) {
  const id = await bookkeeping.prepareRunKnowledgeJob(runId);
  await WorkspaceJobWorkflow(id);
}

const mapActivities = proxyActivities<WorkspaceActivities>({
  startToCloseTimeout: "30 minutes",
  scheduleToCloseTimeout: "95 minutes",
  heartbeatTimeout: "45 seconds",
  retry: { maximumAttempts: 3, initialInterval: "10 seconds" },
});
export async function MindmapJobWorkflow(id: string) {
  try {
    await mapActivities.executeWorkspaceJob(id);
  } catch (e) {
    await CancellationScope.nonCancellable(() =>
      bookkeeping.failWorkspaceJob({
        id,
        error: String((e as Error & { cause?: Error }).cause ?? e),
      }),
    );
  }
}
