import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type { ServiceReleaseStatus } from "../../../shared/src/service-delivery";
const activities = proxyActivities<{ tickServiceRelease(id: string): Promise<ServiceReleaseStatus> }>({
  startToCloseTimeout: "3 minutes", retry: { maximumAttempts: 5, initialInterval: "10 seconds", maximumInterval: "1 minute" },
});
/** Approval may take days; waiting does not hold a worker or activity open. */
export async function ServiceReleaseWorkflow(id: string): Promise<ServiceReleaseStatus> {
  for (let tick = 0; tick < 500; tick++) {
    const release = await activities.tickServiceRelease(id);
    if (release.state === "healthy") return release;
    if (release.state === "failed") throw ApplicationFailure.nonRetryable(release.error || "Service release failed. Open Product Hosting to review CI and deployment details.", "ServiceReleaseFailed");
    await sleep(release.state === "awaiting_approval" ? "30 seconds" : "15 seconds");
  }
  return continueAsNew<typeof ServiceReleaseWorkflow>(id);
}
