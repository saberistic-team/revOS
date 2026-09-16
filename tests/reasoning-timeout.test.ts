import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { validatedReasoning } from "../packages/engine/src/validated-reasoning";
import { sessionConfig } from "../packages/engine/src/agent-policy";
import {
  initialSessionState,
  type ReasonRequest,
  type SessionSnapshot,
  type AgentDecision,
} from "../packages/shared/src/session";
import {
  REASONING_ACTIVITY_TIMEOUT_MS,
  REASONING_CALL_TIMEOUT_MS,
  REASONING_MAX_ATTEMPTS,
} from "../packages/shared/src/reasoning-limits";
function fixture() {
  const snapshot: SessionSnapshot = {
    config: sessionConfig({}),
    outputSchema: { type: "object" },
    catalog: [
      {
        id: "skill",
        name: "Test",
        description: "Test",
        version: 1,
        executionType: "agent",
        instructions: "Test",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        configuration: {},
      },
    ],
    definition: {
      workflow: {
        id: "w",
        version: 1,
        goal: "Test",
        sopMarkdown: "Test",
        inputSchema: {},
        outputSchema: {},
      },
      agent: { name: "Test", instructions: "Test" },
      steps: [],
      tools: [],
      knowledge: [],
    },
  };
  const request: ReasonRequest = {
    sessionId: "s",
    turn: 0,
    input: {},
    state: initialSessionState(),
    events: [],
  };
  const decision: AgentDecision = {
    action: "select_skill",
    target: "skill",
    payload: "{}",
    summary: "Select",
  };
  return { snapshot, request, decision };
}
test("schema repair receives a fresh deadline after an earlier generation", async () => {
  const { snapshot, request, decision } = fixture();
  const signals: AbortSignal[] = [];
  const result = await validatedReasoning(
    {
      reason: async (r, _s, signal) => {
        signals.push(signal!);
        await delay(50, undefined, { signal });
        if (signals.length === 1) return { ...decision, payload: "{truncated" };
        assert.match(r.validationFeedback!.error, /valid JSON/);
        return decision;
      },
    },
    request,
    snapshot,
    new AbortController().signal,
    80,
  );
  assert.deepEqual(result, decision);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(
    REASONING_ACTIVITY_TIMEOUT_MS >
      REASONING_MAX_ATTEMPTS * REASONING_CALL_TIMEOUT_MS,
  );
});
test("slow model request produces an actionable timeout", async () => {
  const { snapshot, request, decision } = fixture();
  await assert.rejects(
    validatedReasoning(
      {
        reason: async (_r, _s, signal) => {
          await delay(100, undefined, { signal });
          return decision;
        },
      },
      request,
      snapshot,
      new AbortController().signal,
      10,
    ),
    /Model reasoning request timed out.*generation 1\/3/,
  );
});
test("cancellation remains cancellation rather than being labeled a timeout", async () => {
  const { snapshot, request, decision } = fixture();
  const cancellation = new AbortController();
  const pending = validatedReasoning(
    {
      reason: async (_r, _s, signal) => {
        cancellation.abort();
        await delay(100, undefined, { signal });
        return decision;
      },
    },
    request,
    snapshot,
    cancellation.signal,
    1000,
  );
  await assert.rejects(
    pending,
    (error) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      !error.message.includes("timed out"),
  );
});
test("invalid decisions have bounded correction attempts", async () => {
  const { snapshot, request, decision } = fixture();
  let calls = 0;
  await assert.rejects(
    validatedReasoning(
      {
        reason: async () => {
          calls++;
          return { ...decision, payload: "invalid" };
        },
      },
      request,
      snapshot,
      new AbortController().signal,
    ),
    /valid JSON/,
  );
  assert.equal(calls, REASONING_MAX_ATTEMPTS);
});

test("larger configured outputs can produce a final brief above the old 16 KB cap", async () => {
  const { snapshot, request } = fixture();
  snapshot.config.maxOutputTokens = 6000;
  request.state.completedSkills = [
    { skillVersionId: "skill", input: {}, output: {} },
  ];
  const final: AgentDecision = {
    action: "final",
    target: null,
    summary: "Brief",
    payload: JSON.stringify({ brief: "Evidence. ".repeat(2200) }),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(final)) > 16000);
  assert.deepEqual(
    await validatedReasoning(
      { reason: async () => final },
      request,
      snapshot,
      new AbortController().signal,
    ),
    final,
  );
});

test("oversized output stays bounded and tells the model the actual byte limit", async () => {
  const { snapshot, request } = fixture();
  snapshot.config.maxOutputTokens = 6000;
  request.state.completedSkills = [
    { skillVersionId: "skill", input: {}, output: {} },
  ];
  let calls = 0;
  const final: AgentDecision = {
    action: "final",
    target: null,
    summary: "Brief",
    payload: JSON.stringify({ brief: "x".repeat(65000) }),
  };
  await assert.rejects(
    validatedReasoning(
      {
        reason: async (r) => {
          calls++;
          if (calls > 1)
            assert.match(r.validationFeedback!.error, /48000 bytes allowed/);
          return final;
        },
      },
      request,
      snapshot,
      new AbortController().signal,
    ),
    /48000 bytes allowed/,
  );
  assert.equal(calls, 3);
});
