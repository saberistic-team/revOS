import {
  proxyActivities,
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
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "10 seconds",
    maximumAttempts: 3,
  },
});
export const humanReview = defineSignal<[Review]>("humanReview");
export async function AgentRunWorkflow(args: AgentRunInput): Promise<Json> {
  let active: StepDefinition | undefined;
  let stepInput: Json = args.input;
  const reviews: Record<string, Review> = Object.create(null);
  setHandler(humanReview, (review) => {
    if (
      active?.type === "human_review" &&
      review.stepKey === active.key &&
      !(review.stepKey in reviews)
    )
      reviews[review.stepKey] = review;
  });
  try {
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
      if (step.type === "human_review") {
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
        output = {
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
      await activities.saveRunStep({
        runId: args.runId,
        workflowStepId: step.id,
        status: "completed",
        input: stepInput,
        output,
      });
      context.steps[step.key] = output;
      context.previous = output;
      active = undefined;
    }
    await activities.completeRun({
      runId: args.runId,
      output: context.previous,
      outputSchema: definition.workflow.outputSchema,
    });
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
