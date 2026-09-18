import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionConfig, validateDecision } from "../packages/engine/src/agent-policy";
import { validatedReasoning } from "../packages/engine/src/validated-reasoning";
import { initialSessionState, type AgentDecision, type ReasonRequest, type SessionSnapshot } from "../packages/shared/src/session";

const buildId = "12f69fe1-3156-4b2b-a979-9b41514d93af";
const otherBuildId = "96ddaf35-a4a3-434d-903f-16a274bd8671";
function fixture() {
  const snapshot: SessionSnapshot = {
    config: sessionConfig({ allowHumanReview: true }),
    outputSchema: { type: "object" },
    catalog: [{
      id: "skill", name: "Research prototype", description: "Build and revise a prototype", version: 1,
      executionType: "agent", instructions: "Use a completed prototype when possible",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      configuration: { allowedToolIds: ["start", "revise", "inspect"] },
    }],
    definition: {
      workflow: { id: "workflow", version: 1, goal: "Research", sopMarkdown: "Review the prototype", inputSchema: {}, outputSchema: {} },
      agent: { name: "Researcher", instructions: "Preserve approved scope" }, steps: [], knowledge: [],
      tools: [
        { id: "start", handler: "openhands.start_build", inputSchema: { type: "object", required: ["brief"], properties: { brief: { type: "string" } } }, outputSchema: {} },
        { id: "revise", handler: "openhands.revise_build", inputSchema: { type: "object", required: ["brief", "buildId"], properties: { brief: { type: "string" }, buildId: { type: "string", format: "uuid" } } }, outputSchema: {} },
        { id: "inspect", handler: "openhands.inspect_build", inputSchema: { type: "object", required: ["buildId"], properties: { buildId: { type: "string", format: "uuid" } } }, outputSchema: {} },
      ],
    },
  };
  const request: ReasonRequest = {
    sessionId: "session", turn: 2, input: {},
    state: { ...initialSessionState(), activeSkillId: "skill", revisionPending: true },
    events: [{ turn: 0, decision: call("inspect", { buildId }), result: { id: buildId, state: "failed", error: "Previous iteration limit" } }],
    currentBuilds: [{ id: buildId, parentId: null, state: "completed", commit: "confirmed-commit", codeUrl: "http://localhost:3001/revos/products/src/commit/confirmed-commit", previewUrl: `http://localhost:3002/${buildId}/`, error: null, updatedAt: "2026-09-17T12:00:00.000Z" }],
  };
  return { snapshot, request };
}
function call(target: string, input: object): AgentDecision {
  return { action: "call_tool", target, payload: JSON.stringify(input), summary: "Address the requested prototype feedback" };
}

test("live completed build prevents a fresh replacement after historical failure", () => {
  const { request, snapshot } = fixture();
  const history = structuredClone(request.events);
  assert.throws(() => validateDecision(call("start", { brief: "Rebuild the reviewed prototype" }), request, snapshot), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /openhands\.revise_build/);
    assert.match(error.message, new RegExp(buildId));
    assert.match(error.message, /inspect\/reuse/);
    return true;
  });
  assert.deepEqual(validateDecision(call("revise", { buildId, brief: "Update the lead filter" }), request, snapshot), { buildId, brief: "Update the lead filter" });
  assert.deepEqual(request.events, history, "Historical tool outcomes must remain unchanged");
});

test("invalid fresh-build choice gets actionable validation feedback before execution", async () => {
  const { request, snapshot } = fixture();
  const revised = call("revise", { buildId, brief: "Add the requested qualification labels" });
  let generations = 0;
  const chosen = await validatedReasoning({ reason: async (context) => {
    generations++;
    if (generations === 1) return call("start", { brief: "Build again" });
    assert.match(context.validationFeedback!.error, /Do not start a fresh build/);
    assert.match(context.validationFeedback!.error, new RegExp(buildId));
    assert.equal(context.currentBuilds![0].state, "completed");
    assert.equal((context.events[0].result as { state: string }).state, "failed");
    return revised;
  } }, request, snapshot, new AbortController().signal);
  assert.deepEqual(chosen, revised);
  assert.equal(generations, 2);
});

test("review-only feedback can inspect and resubmit without another coding build or approval", () => {
  const { request, snapshot } = fixture();
  assert.doesNotThrow(() => validateDecision(call("inspect", { buildId }), request, snapshot));
  assert.doesNotThrow(() => validateDecision({ action: "request_review", target: null, payload: JSON.stringify({ buildId, explanation: "Existing preview addresses this question" }), summary: "Review the existing prototype" }, request, snapshot));
  assert.throws(() => validateDecision({ action: "complete_skill", target: "skill", payload: "{}", summary: "Complete" }, request, snapshot), /Human approval/);
});

test("known unfinished parents are rejected, while other customer-owned parents defer to tool validation", () => {
  const { request, snapshot } = fixture();
  request.currentBuilds![0].state = "running";
  assert.throws(() => validateDecision(call("revise", { buildId, brief: "Change it" }), request, snapshot), /currently running.*completed parent/);
  assert.doesNotThrow(() => validateDecision(call("revise", { buildId: otherBuildId, brief: "Revise an earlier customer prototype" }), request, snapshot));
  assert.doesNotThrow(() => validateDecision(call("start", { brief: "New output without a completed result" }), request, snapshot));
});

test("legacy persisted requests and new-work sessions retain their existing behavior", () => {
  const { request, snapshot } = fixture();
  request.state.revisionPending = false;
  assert.doesNotThrow(() => validateDecision(call("start", { brief: "A separate new prototype" }), request, snapshot));
  request.state.revisionPending = true;
  delete request.currentBuilds;
  assert.doesNotThrow(() => validateDecision(call("start", { brief: "Previously recorded tool decision" }), request, snapshot));
});
