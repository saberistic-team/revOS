import { continueAsNew, patched, proxyActivities, sleep } from "@temporalio/workflow";
const a = proxyActivities<{ tickCodeBuild(id: string, attempt?: number): Promise<boolean> }>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});
export async function CodeBuildWorkflow(id: string, attempt = 0): Promise<void> {
  const resumable = patched("code-build-resume-v2");
  for (let i = 0; i < 300; i++) {
    if (await (resumable ? a.tickCodeBuild(id, attempt) : a.tickCodeBuild(id))) return;
    await sleep("5 seconds");
  }
  if (resumable) return continueAsNew<typeof CodeBuildWorkflow>(id, attempt);
  throw Error("Build exceeded its time limit");
}
