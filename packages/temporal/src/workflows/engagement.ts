import {
  proxyActivities,
  sleep,
  continueAsNew,
  startChild,
} from "@temporalio/workflow";
const a = proxyActivities<{
  tickEngagement(id: string): Promise<boolean | { importRunId: string }>;
}>({ startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 5 } });
export async function EngagementWorkflow(id: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const result = await a.tickEngagement(id);
    if (result === true) return;
    if (typeof result === "object") {
      const child = await startChild("RunKnowledgeWorkflow", {
        workflowId: "knowledge:" + result.importRunId,
        args: [result.importRunId],
      });
      await child.result();
    }
    await sleep("5 seconds");
  }
  await continueAsNew<typeof EngagementWorkflow>(id);
}
