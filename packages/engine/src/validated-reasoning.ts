import type { AgentPlanner } from "./openai-agent";
import type { ReasonRequest, SessionSnapshot } from "../../shared/src/session";
import {
  REASONING_CALL_TIMEOUT_MS,
  REASONING_MAX_ATTEMPTS,
  decisionByteLimit,
} from "../../shared/src/reasoning-limits";
import { checkPayloadSize, checkReasoningContextSize, validateDecision } from "./agent-policy";

export async function validatedReasoning(
  planner: AgentPlanner,
  request: ReasonRequest,
  snapshot: SessionSnapshot,
  cancellationSignal: AbortSignal,
  callTimeoutMs = REASONING_CALL_TIMEOUT_MS,
) {
  for (let attempt = 0; attempt < REASONING_MAX_ATTEMPTS; attempt++) {
    cancellationSignal.throwIfAborted();
    checkReasoningContextSize(request, snapshot);
    // A schema correction gets its own request budget. Earlier model calls must
    // not consume the time available to generate the corrected response.
    const deadline = AbortSignal.timeout(callTimeoutMs);
    const signal = AbortSignal.any([cancellationSignal, deadline]);
    let decision;
    try {
      decision = await planner.reason(request, snapshot, signal);
    } catch (error) {
      if (deadline.aborted && !cancellationSignal.aborted)
        throw new Error(
          `Model reasoning request timed out after ${callTimeoutMs / 1000} seconds (generation ${attempt + 1}/${REASONING_MAX_ATTEMPTS})`,
          { cause: error },
        );
      throw error;
    }
    try {
      checkPayloadSize(decision, decisionByteLimit(snapshot.config));
      validateDecision(decision, request, snapshot);
      return decision;
    } catch (error) {
      if (attempt === REASONING_MAX_ATTEMPTS - 1) throw error;
      request.validationFeedback = {
        error: String(error),
        previousDecision: decision,
      };
    }
  }
  throw new Error("Model returned no valid decision");
}
