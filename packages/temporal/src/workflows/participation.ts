import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  continueAsNew,
} from "@temporalio/workflow";
import type { ParticipationActivities } from "../../../shared/src/participation";
const activities = proxyActivities<ParticipationActivities>({
  startToCloseTimeout: "3 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "10 seconds",
    maximumInterval: "5 minutes",
  },
});
export const participationChanged = defineSignal("participationChanged");
export type ParticipationWorkflowInput = {
  kind: "question" | "email";
  id: string;
};
/** Humans can take days to reply; no activity or worker is held while waiting. */
export async function ParticipationWorkflow(
  input: ParticipationWorkflowInput,
): Promise<void> {
  if (input.kind === "email") {
    await activities.deliverParticipationEmail(input.id);
    return;
  }
  let changed = false;
  setHandler(participationChanged, () => {
    changed = true;
  });
  for (let round = 0; round < 100; round++) {
    changed = false;
    const status = await activities.participationStatus(input.id);
    if (status.state === "rejected") return;
    if (status.state === "accepted") {
      await activities.publishParticipationAnswer(input.id);
      return;
    }
    await condition(() => changed, "6 hours");
  }
  await continueAsNew<typeof ParticipationWorkflow>(input);
}

export async function WaitForParticipationQuestionWorkflow(input: {
  questionId: string;
  organizationId: string;
}): Promise<
  import("../../../shared/src/participation").ReviewedParticipationAnswer
> {
  let changed = false;
  setHandler(participationChanged, () => {
    changed = true;
  });
  for (let round = 0; round < 1000; round++) {
    changed = false;
    const answer = await activities.participationReviewedResult(input);
    if (answer) return answer;
    await condition(() => changed, "30 seconds");
  }
  return continueAsNew<typeof WaitForParticipationQuestionWorkflow>(input);
}
