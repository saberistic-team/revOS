import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIAgentPlanner } from "../packages/engine/src/openai-agent";
import {
  sessionConfig,
  validateDecision,
} from "../packages/engine/src/agent-policy";
import {
  initialSessionState,
  type SessionSnapshot,
  type ReasonRequest,
  type AgentDecision,
} from "../packages/shared/src/session";
const decision: AgentDecision = {
  action: "select_skill",
  target: "skill-v1",
  payload: "{}",
  summary: "Use the approved skill.",
};
const snapshot: SessionSnapshot = {
  config: sessionConfig({ mockDecisions: [decision] as any }),
  catalog: [
    {
      id: "skill-v1",
      name: "Research",
      description: "An available capability",
      version: 1,
      executionType: "agent",
      instructions: "Follow policy",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      configuration: {
        allowedToolIds: ["tool-1"],
        allowedKnowledgeIds: ["knowledge-1"],
      },
    },
  ],
  outputSchema: { type: "object" },
  definition: {
    workflow: {
      id: "w",
      version: 1,
      goal: "Research",
      sopMarkdown: "Select a skill",
      inputSchema: {},
      outputSchema: {},
    },
    agent: { name: "Researcher", instructions: "Be accurate" },
    steps: [],
    tools: [
      {
        id: "tool-1",
        handler: "search",
        inputSchema: { type: "object", required: ["query"] },
        outputSchema: {},
      },
    ],
    knowledge: [
      { id: "knowledge-1", name: "Evidence policy", content: "Do not guess" },
    ],
  },
};
const request: ReasonRequest = {
  sessionId: "session",
  turn: 0,
  input: {},
  state: initialSessionState(),
  events: [],
};
test("actual Agents SDK Agent/Runner produces structured decisions offline", async () => {
  const result = await new OpenAIAgentPlanner().reason(request, snapshot);
  assert.deepEqual(result, decision);
});
test("SDK action schema excludes disallowed review even when the model proposes it", async () => {
  await assert.rejects(() =>
    new OpenAIAgentPlanner().reason(request, {
      ...snapshot,
      config: {
        ...snapshot.config,
        allowHumanReview: false,
        mockDecisions: [
          { ...decision, action: "request_review", target: null },
        ],
      },
    }),
  );
});
test("model can only select catalog skills and tools of an active skill", () => {
  assert.deepEqual(validateDecision(decision, request, snapshot), {});
  assert.throws(
    () =>
      validateDecision(
        { ...decision, target: "foreign-skill" },
        request,
        snapshot,
      ),
    /pinned catalog/,
  );
  assert.throws(
    () =>
      validateDecision(
        { ...decision, action: "call_tool", target: "tool-1" },
        request,
        snapshot,
      ),
    /Select a skill/,
  );
  const active = {
    ...request,
    state: { ...request.state, activeSkillId: "skill-v1" },
  };
  assert.throws(
    () =>
      validateDecision(
        { ...decision, action: "call_tool", target: "tool-1" },
        active,
        snapshot,
      ),
    /query/,
  );
  assert.throws(
    () =>
      validateDecision(
        {
          ...decision,
          action: "call_tool",
          target: "forbidden",
          payload: '{"query":"x"}',
        },
        active,
        snapshot,
      ),
    /not allowed/,
  );
});
test("knowledge retrieval requires explicit permission and final cannot bypass skill completion", () => {
  const active = {
    ...request,
    state: { ...request.state, activeSkillId: "skill-v1" },
  };
  assert.deepEqual(
    validateDecision(
      {
        ...decision,
        action: "fetch_knowledge",
        target: "knowledge-1",
        payload: "",
      },
      active,
      snapshot,
    ),
    {},
  );
  assert.throws(
    () =>
      validateDecision(
        { ...decision, action: "fetch_knowledge", target: "private" },
        active,
        snapshot,
      ),
    /not allowed/,
  );
  assert.throws(
    () =>
      validateDecision(
        { ...decision, action: "final", target: null },
        request,
        snapshot,
      ),
    /Complete at least/,
  );
  assert.throws(() => sessionConfig({ maxTurns: 1000 }), /Invalid maxTurns/);
});

test("human questions have an explicit permission and a bounded question payload", () => {
  const ask: AgentDecision = {
    action: "ask_human",
    target: null,
    payload: JSON.stringify({
      question: "Which county?",
      options: ["Example County", "Another county"],
    }),
    summary: "Clarify the county.",
  };
  assert.deepEqual(validateDecision(ask, request, snapshot), {
    question: "Which county?",
    options: ["Example County", "Another county"],
  });
  assert.throws(
    () =>
      validateDecision(ask, request, {
        ...snapshot,
        config: { ...snapshot.config, allowHumanQuestions: false },
      }),
    /not enabled/,
  );
  assert.throws(
    () =>
      validateDecision(
        { ...ask, payload: '{"question":""}' },
        request,
        snapshot,
      ),
    /Human question/,
  );
});

test("required evidence blocks completion until knowledge and a call by the active skill are recorded", async () => {
  const s = structuredClone(snapshot);
  s.catalog[0].configuration.requiredKnowledgeIds = ["knowledge-1"];
  s.catalog[0].configuration.requiredToolIds = ["tool-1"];
  const r = structuredClone(request);
  r.state.activeSkillId = "skill-v1";
  const complete: AgentDecision = {
    action: "complete_skill",
    target: "skill-v1",
    payload: "{}",
    summary: "Finish",
  };
  assert.throws(
    () => validateDecision(complete, r, s),
    /Required skill evidence/,
  );
  s.config.mockDecisions = [complete];
  await assert.rejects(() => new OpenAIAgentPlanner().reason(r, s));
  r.state.fetchedKnowledgeIds = ["knowledge-1"];
  r.events = [
    {
      turn: 0,
      decision: { ...decision, action: "call_tool", target: "tool-1" },
      result: {},
    },
    { turn: 1, decision, result: {} },
  ];
  assert.throws(
    () => validateDecision(complete, r, s),
    /Required skill evidence/,
  );
  r.events.push({
    turn: 2,
    decision: { ...decision, action: "call_tool", target: "tool-1" },
    result: { sources: ["recorded"] },
  });
  assert.deepEqual(validateDecision(complete, r, s), {});
});
