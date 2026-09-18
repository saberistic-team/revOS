import {
  proxyActivities,
  sleep,
  startChild,
  ParentClosePolicy,
  patched,
  CancellationScope,
  isCancellation,
  ApplicationFailure,
} from "@temporalio/workflow";
import type {
  Activities,
  Json,
  Review,
  StepDefinition,
} from "../../../shared/src";
import type {
  SessionActivities,
  HumanAnswer,
} from "../../../shared/src/session";
import {
  REASONING_ACTIVITY_TIMEOUT_MS,
  REASONING_SCHEDULE_TIMEOUT_MS,
} from "../../../shared/src/reasoning-limits";
const activities = proxyActivities<
  SessionActivities &
    Activities & { isRunPaused(runId: string): Promise<boolean> }
>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3, initialInterval: "1 second" },
});
const reasoning = proxyActivities<Pick<SessionActivities, "reason">>({
  startToCloseTimeout: REASONING_ACTIVITY_TIMEOUT_MS,
  scheduleToCloseTimeout: REASONING_SCHEDULE_TIMEOUT_MS,
  retry: { maximumAttempts: 3, initialInterval: "1 second" },
});
export async function runAgentLoop(
  runId: string,
  step: StepDefinition,
  input: Json,
  waitForReview: (reviewId: string) => Promise<Review>,
  waitForAnswer: (questionId: string) => Promise<HumanAnswer>,
): Promise<Json> {
  const session = await activities.openReasoningSession({
    runId,
    workflowStepId: step.id,
    input,
  });
  try {
    for (let turn = 0; turn < session.config.maxTurns; turn++) {
      if (patched("engagement-pause-v1"))
        while (await activities.isRunPaused(runId)) await sleep("5 seconds");
      const decision = await reasoning.reason({ sessionId: session.id, turn });
      let outcome;
      if (decision.action === "call_tool") {
        outcome = await activities.executeSessionTool({
          sessionId: session.id,
          turn,
        });
        const build = outcome.result as any;
        if (build?.codeBuildId && patched("openhands-build-v1")) {
          const child = await startChild("CodeBuildWorkflow", {
            workflowId: `build:${build.codeBuildId}`,
            args: [build.codeBuildId],
          });
          await child.result();
        }
        if (build?.serviceReleaseId && patched("service-release-v1")) {
          await activities.setSessionStatus({ sessionId: session.id, status: "waiting" });
          await activities.saveRunStep({ runId, workflowStepId: step.id, status: "waiting", input,
            output: { sessionId: session.id, ...build, runId } });
          await activities.markRunWaiting(runId);
          const child = await startChild("ServiceReleaseWorkflow", {
            workflowId: `service-release:${build.serviceReleaseId}`, args: [build.serviceReleaseId],
          });
          await child.result();
          // The immutable tool receipt identifies the release; inspect_delivery fetches its verified result.
          await activities.setSessionStatus({ sessionId: session.id, status: "running" });
          await activities.markRunRunning(runId);
          await activities.saveRunStep({ runId, workflowStepId: step.id, status: "running", input });
        }
        if (build?.participationQuestionId && patched("named-human-participation-v1")) {
          await activities.setSessionStatus({ sessionId: session.id, status: "waiting" });
          await activities.saveRunStep({ runId, workflowStepId: step.id, status: "waiting", input,
            output: { sessionId: session.id, ...build } });
          await activities.markRunWaiting(runId);
          const child = await startChild("WaitForParticipationQuestionWorkflow", {
            workflowId: `participation-wait:${session.id}:${turn}`,
            args: [{ questionId: build.participationQuestionId, organizationId: build.organizationId }],
          });
          await child.result();
          // Keep the assignment outcome immutable; reason() loads attributed reviewed answers.
          await activities.setSessionStatus({ sessionId: session.id, status: "running" });
          await activities.markRunRunning(runId);
          await activities.saveRunStep({ runId, workflowStepId: step.id, status: "running", input });
        }
      } else if (decision.action === "fetch_knowledge") {
        outcome = await activities.fetchSessionKnowledge({
          sessionId: session.id,
          turn,
        });
      } else if (decision.action === "ask_human") {
        const question = await activities.prepareHumanQuestion({
          sessionId: session.id,
          turn,
        });
        const questionId = `question:${session.id}:${turn}`;
        await activities.setSessionStatus({
          sessionId: session.id,
          status: "waiting",
          reviewId: null,
        });
        await activities.saveRunStep({
          runId,
          workflowStepId: step.id,
          status: "waiting",
          input,
          output: { sessionId: session.id, questionId, ...question },
        });
        await activities.markRunWaiting(runId);
        const answer = await waitForAnswer(questionId);
        outcome = await activities.applyAgentDecision({
          sessionId: session.id,
          turn,
          answer,
        });
        await activities.setSessionStatus({
          sessionId: session.id,
          status: "running",
        });
        await activities.markRunRunning(runId);
        await activities.saveRunStep({
          runId,
          workflowStepId: step.id,
          status: "running",
          input,
        });
      } else if (decision.action === "request_review") {
        if (!session.config.allowHumanReview)
          throw ApplicationFailure.nonRetryable("Human review not allowed");
        const reviewId = `${session.id}:${turn}`;
        await activities.setSessionStatus({
          sessionId: session.id,
          status: "waiting",
          reviewId,
        });
        await activities.saveRunStep({
          runId,
          workflowStepId: step.id,
          status: "waiting",
          input,
          output: {
            sessionId: session.id,
            reviewId,
            request: decision.payload,
          },
        });
        await activities.markRunWaiting(runId);
        const review = await waitForReview(reviewId);
        outcome = await activities.applyAgentDecision({
          sessionId: session.id,
          turn,
          review,
        });
        await activities.setSessionStatus({
          sessionId: session.id,
          status: "running",
        });
        await activities.markRunRunning(runId);
        await activities.saveRunStep({
          runId,
          workflowStepId: step.id,
          status: "running",
          input,
        });
      } else {
        outcome = await activities.applyAgentDecision({
          sessionId: session.id,
          turn,
        });
      }
      if (
        decision.action === "complete_skill" &&
        patched("skill-output-artifacts-v1")
      ) {
        const skill = step.catalog?.find((s) => s.id === decision.target);
        const settings = skill?.configuration.outputs as any;
        if (
          settings?.artifacts?.formats?.length &&
          settings.artifacts.mode !== "manual"
        )
          await startChild("OutputArtifactWorkflow", {
            workflowId: `artifact:${session.id}:${turn}`,
            parentClosePolicy: ParentClosePolicy.ABANDON,
            args: [
              {
                source: {
                  runId,
                  workflowStepId: step.id,
                  sessionId: session.id,
                  turn,
                },
              },
            ],
          });
      }
      if (decision.action === "final") {
        await activities.setSessionStatus({
          sessionId: session.id,
          status: "completed",
          output: outcome.result,
        });
        return outcome.result;
      }
    }
    throw ApplicationFailure.nonRetryable(
      "Reasoning turn limit reached without final output",
    );
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      activities.setSessionStatus({
        sessionId: session.id,
        status: isCancellation(error) ? "cancelled" : "failed",
        error: String(error),
      }),
    );
    throw error;
  }
}
