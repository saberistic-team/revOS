import {
  proxyActivities,
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import type {
  ArtifactActivities,
  ArtifactWorkflowInput,
} from "../../../shared/src/outputs";
const bookkeeping = proxyActivities<ArtifactActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1 second",
    maximumInterval: "10 seconds",
  },
});
const generation = proxyActivities<ArtifactActivities>({
  startToCloseTimeout: "10 minutes",
  scheduleToCloseTimeout: "25 minutes",
  heartbeatTimeout: "45 seconds",
  retry: { maximumAttempts: 2, initialInterval: "5 seconds" },
});
export async function OutputArtifactWorkflow(input: ArtifactWorkflowInput) {
  const jobId = await bookkeeping.prepareArtifact(input);
  if (!jobId) return null;
  try {
    await generation.generateArtifact(jobId);
    return jobId;
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      bookkeeping.failArtifact({
        jobId,
        error: String((error as Error & { cause?: Error }).cause ?? error),
      }),
    );
    if (isCancellation(error)) throw error;
    return jobId;
  }
}
