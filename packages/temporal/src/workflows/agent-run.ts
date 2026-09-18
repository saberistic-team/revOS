import {
  proxyActivities,
  startChild,
  ParentClosePolicy,
  patched,
  defineSignal,
  setHandler,
  condition,
  CancellationScope,
  isCancellation,
  ApplicationFailure,
} from "@temporalio/workflow";
import type {
  Activities,
  AgentRunInput,
  Review,
  Json,
  StepDefinition,
  StepContext,
} from "../../../shared/src";
import { bindInput } from "../../../shared/src/bindings";
import type { HumanAnswer } from "../../../shared/src/session";
import { runAgentLoop } from "./agent-loop";
const activities = proxyActivities<
  Activities & {
    shouldImportRun(runId: string): Promise<boolean>;
    requireCompletedBuild(runId: string): Promise<void>;
  }
>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "10 seconds",
    maximumAttempts: 3,
  },
});
export const humanAnswer = defineSignal<[HumanAnswer]>("humanAnswer");
export const humanReview = defineSignal<[Review]>("humanReview");
export async function AgentRunWorkflow(args: AgentRunInput): Promise<Json> {
  let active: StepDefinition | undefined;
  let stepInput: Json = args.input;
  const answers: Record<string, HumanAnswer> = Object.create(null);
  setHandler(humanAnswer, (answer) => {
    if (
      active &&
      answer.stepKey === active.key &&
      typeof answer.questionId === "string" &&
      typeof answer.answer === "string" &&
      answer.answer.trim() &&
      answer.answer.length <= 12000 &&
      !(answer.questionId in answers)
    )
      answers[answer.questionId] = answer;
  });
  const reviews: Record<string, Review> = Object.create(null);
  setHandler(humanReview, (review) => {
    if (
      (active?.type === "human_review" ||
        active?.type === "agent_loop" ||
        active?.skill?.executionType === "agent") &&
      review.stepKey === active.key &&
      !((review.reviewId ?? review.stepKey) in reviews)
    )
      reviews[review.reviewId ?? review.stepKey] = review;
  });
  let organizationConfirmed = false;
  setHandler(defineSignal("organizationConfirmed"), () => {
    organizationConfirmed = true;
  });
  try {
    if (patched("customer-organization-v1")) {
      let resolved = await activities.resolveRunOrganization(args.runId);
      while (resolved.state !== "resolved") {
        await activities.markRunWaiting(args.runId);
        if (!(await condition(() => organizationConfirmed, "7 days")))
          throw ApplicationFailure.nonRetryable(
            "Customer confirmation expired",
          );
        organizationConfirmed = false;
        resolved = await activities.resolveRunOrganization(args.runId);
      }
    }
    const definition = await activities.loadExecutionDefinition(args);
    await activities.markRunRunning(args.runId);
    const context: StepContext = {
      initial: args.input,
      previous: args.input,
      steps: Object.create(null),
    };
    for (const step of definition.steps) {
      active = step;
      stepInput = bindInput(step.configuration, context);
      await activities.saveRunStep({
        runId: args.runId,
        workflowStepId: step.id,
        status: "running",
        input: stepInput,
      });
      let output: Json;
      if (step.type === "agent_loop" || step.skill?.executionType === "agent") {
        output = await runAgentLoop(
          args.runId,
          step,
          stepInput,
          async (reviewId) => {
            const received = await condition(
              () => reviewId in reviews,
              "7 days",
            );
            if (!received)
              throw ApplicationFailure.nonRetryable("Human review expired");
            return reviews[reviewId];
          },
          async (questionId) => {
            const received = await condition(
              () => questionId in answers,
              "7 days",
            );
            if (!received)
              throw ApplicationFailure.nonRetryable("Human question expired");
            return answers[questionId];
          },
        );
      } else if (step.type === "human_review") {
        await activities.saveRunStep({
          runId: args.runId,
          workflowStepId: step.id,
          status: "waiting",
          input: stepInput,
        });
        await activities.markRunWaiting(args.runId);
        const received = await condition(() => step.key in reviews, "7 days");
        if (!received || !reviews[step.key].approved)
          throw ApplicationFailure.nonRetryable(
            "Human review rejected or expired",
          );
        output =
          step.configuration.outputMode === "input"
            ? stepInput
            : {
                approved: true,
                note: reviews[step.key].note ?? "",
                value: stepInput,
              };
        await activities.markRunRunning(args.runId);
      } else if (step.type === "skill" && step.skill) {
        output = await activities.executeSkill({
          skill: step.skill,
          input: stepInput,
          definition,
        });
      } else
        throw ApplicationFailure.nonRetryable("Unsupported step definition");
      if (step.configuration.requireCompletedBuild === true)
        await activities.requireCompletedBuild(args.runId);
      await activities.saveRunStep({
        runId: args.runId,
        workflowStepId: step.id,
        status: "completed",
        input: stepInput,
        output,
      });
      if (patched("output-artifacts-v1")) {
        for (const fixedSkill of [
          false,
          ...(step.type === "skill" && step.skill?.executionType !== "agent"
            ? [true]
            : []),
        ]) {
          const settings = (
            fixedSkill
              ? step.skill?.configuration.outputs
              : step.configuration.outputs
          ) as any;
          if (
            settings?.artifacts?.formats?.length &&
            settings.artifacts.mode !== "manual"
          )
            await startChild("OutputArtifactWorkflow", {
              workflowId: `artifact:${args.runId}:${step.id}:${fixedSkill ? "skill" : "step"}`,
              parentClosePolicy: ParentClosePolicy.ABANDON,
              args: [
                {
                  source: {
                    runId: args.runId,
                    workflowStepId: step.id,
                    ...(fixedSkill ? { fixedSkill: true } : {}),
                  },
                },
              ],
            });
        }
      }
      context.steps[step.key] = output;
      context.previous = output;
      active = undefined;
    }
    await activities.completeRun({
      runId: args.runId,
      output: context.previous,
      outputSchema: definition.workflow.outputSchema,
    });
    if (
      patched("organization-knowledge-v1") &&
      (!patched("engagement-knowledge-gate-v1") ||
        (await activities.shouldImportRun(args.runId))) &&
      (!!definition.customer ||
        definition.steps.some((s) => s.configuration.captureKnowledge === true))
    ) {
      await startChild("RunKnowledgeWorkflow", {
        workflowId: `knowledge:${args.runId}`,
        parentClosePolicy: ParentClosePolicy.ABANDON,
        args: [args.runId],
      });
    }
    return context.previous;
  } catch (error) {
    const messages: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; cause && depth < 8; depth++) {
      messages.push(cause instanceof Error ? cause.message : String(cause));
      cause = cause instanceof Error ? cause.cause : undefined;
    }
    const errorMessage = messages.join(": ");
    const cancelled = isCancellation(error);
    await CancellationScope.nonCancellable(async () => {
      if (active)
        await activities.saveRunStep({
          runId: args.runId,
          workflowStepId: active.id,
          status: cancelled ? "cancelled" : "failed",
          input: stepInput,
          error: errorMessage,
        });
      await activities.failRun({
        runId: args.runId,
        error: errorMessage,
        cancelled,
      });
    });
    throw error;
  }
}

export { OutputArtifactWorkflow } from "./artifact";

export {
  WorkspaceJobWorkflow,
  RunKnowledgeWorkflow,
  MindmapJobWorkflow,
} from "./workspace";

export { EngagementWorkflow } from "./engagement";

export { CodeBuildWorkflow } from "./code-build";
export { ParticipationWorkflow, WaitForParticipationQuestionWorkflow } from "./participation";

export { ServiceReleaseWorkflow } from "./service-release";
