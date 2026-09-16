import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  reasoningSessions,
  reasoningTurns,
} from "../../packages/database/src";
import {
  seedAgent,
  agentIds,
  agentDecisions,
  finalReport,
} from "../../scripts/seed-agent";
import { ids } from "../../scripts/seed";
import { createSessionActivities } from "../../packages/temporal/src/activities/sessions";
import { ToolRegistry } from "../../packages/engine/src";
import {
  connectionOptions,
  namespace,
} from "../../packages/temporal/src/config";
const base = process.env.API_URL ?? "http://localhost:3000";
async function api(path: string, body?: unknown) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  assert.ok(r.ok, await r.clone().text());
  return r.json();
}
async function wait(id: string, status = "completed") {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const r = await api(`/runs/${id}`);
    if (r.status === status) return r;
    if (["failed", "cancelled"].includes(r.status))
      throw new Error(JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Run timeout");
}
after(() => pool.end());
test("SDK agent selects pinned skill, explicitly fetches knowledge, and executes a separate Temporal tool Activity", async () => {
  await seedAgent();
  const r = await api(`/workflows/${agentIds.workflow}/runs`, {
    input: { personName: "Jordan Example" },
  });
  await wait(r.id);
  const [summary] = await api(`/runs/${r.id}/sessions`);
  const session = await api(`/sessions/${summary.id}`);
  assert.equal(session.status, "completed");
  assert.equal(session.turns.length, 5);
  assert.deepEqual(session.output, finalReport);
  assert.deepEqual(session.state.fetchedKnowledgeIds, [ids.knowledge]);
  assert.equal(session.state.toolCalls, 1);
  assert.equal(
    session.state.completedSkills[0].skillVersionId,
    agentIds.skillVersion,
  );
  const history = await api(`/runs/${r.id}/history`);
  assert.ok(
    history.events.some((e: any) => e.activity === "executeSessionTool"),
  );
  assert.ok(
    history.events.some((e: any) => e.activity === "fetchSessionKnowledge"),
  );
  const registry = new ToolRegistry();
  registry.register(
    "property.search",
    async () => {
      throw new Error("Completed tool must not execute again");
    },
    { retrySafe: true },
  );
  const cached = createSessionActivities(registry, {
    reason: async () => {
      throw new Error("Completed model turn must not repeat");
    },
  });
  assert.deepEqual(
    await cached.reason({ sessionId: session.id, turn: 2 }),
    session.turns[2].decision,
  );
  assert.deepEqual(
    await cached.executeSessionTool({ sessionId: session.id, turn: 2 }),
    session.turns[2].outcome,
  );
  await assert.rejects(
    db
      .update(reasoningSessions)
      .set({ input: { mutated: true } })
      .where(eq(reasoningSessions.id, session.id)),
  );
  await assert.rejects(
    db
      .update(reasoningTurns)
      .set({ decision: agentDecisions[0] })
      .where(eq(reasoningTurns.id, session.turns[2].id)),
  );
});
test("session resumes after review (and optional worker restart) without repeating completed tools", async () => {
  await seedAgent();
  const w = randomUUID(),
    v = randomUUID();
  const decisions = [
    ...agentDecisions.slice(0, 3),
    {
      action: "request_review",
      target: null,
      payload: "{}",
      summary: "Review this synthetic evidence",
    },
    ...agentDecisions.slice(3),
  ];
  await db.transaction(async (tx) => {
    await tx.insert(workflows).values({
      id: w,
      organizationId: ids.organization,
      name: "Session recovery test",
      slug: w,
    });
    await tx.insert(workflowVersions).values({
      id: v,
      workflowId: w,
      version: 1,
      goal: "Recovery test",
      sopMarkdown: "Review evidence before completing",
      createdBy: "test",
    });
    await tx.insert(workflowSteps).values({
      workflowVersionId: v,
      key: "research",
      name: "Research",
      position: 0,
      type: "agent_loop",
      configuration: {
        provider: "mock",
        skillVersionIds: [agentIds.skillVersion],
        allowHumanReview: true,
        mockDecisions: decisions as any,
      },
    });
    await tx
      .update(workflows)
      .set({ currentVersionId: v })
      .where(eq(workflows.id, w));
  });
  const r = await api(`/workflows/${w}/runs`, { input: {} });
  await wait(r.id, "waiting");
  const [summary] = await api(`/runs/${r.id}/sessions`);
  const before = await api(`/sessions/${summary.id}`);
  if (process.env.TEST_WORKER_RESTART === "1") {
    execFileSync("kubectl", [
      "-n",
      "agent-engine-local",
      "rollout",
      "restart",
      "deployment/worker",
    ]);
    execFileSync("kubectl", [
      "-n",
      "agent-engine-local",
      "rollout",
      "status",
      "deployment/worker",
      "--timeout=120s",
    ]);
  }
  const bad = await fetch(base + `/runs/${r.id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stepKey: "research",
      reviewId: "stale-review",
      approved: true,
    }),
  });
  assert.equal(bad.status, 409);
  await api(`/runs/${r.id}/review`, {
    stepKey: "research",
    reviewId: before.reviewId,
    approved: true,
    note: "Verified synthetic fixture",
  });
  await wait(r.id);
  const after = await api(`/sessions/${summary.id}`);
  assert.equal(after.turns.length, 6);
  assert.deepEqual(after.turns.slice(0, 3), before.turns.slice(0, 3));
  const connection = await Connection.connect(connectionOptions());
  try {
    await new Client({ connection, namespace }).workflow
      .getHandle(r.temporalWorkflowId)
      .result();
  } finally {
    await connection.close();
  }
});

test("human questions survive restart, accept follow-ups, and feed answers into later reasoning", async () => {
  await seedAgent();
  const w = randomUUID(),
    v = randomUUID();
  const question = (text: string) => ({
    action: "ask_human",
    target: null,
    payload: JSON.stringify({
      question: text,
      options: ["Example County", "Other county"],
    }),
    summary: text,
  });
  await db.transaction(async (tx) => {
    await tx
      .insert(workflows)
      .values({
        id: w,
        organizationId: ids.organization,
        name: "Human conversation test",
        slug: w,
      });
    await tx
      .insert(workflowVersions)
      .values({
        id: v,
        workflowId: w,
        version: 1,
        goal: "Ask for missing context",
        sopMarkdown: "Ask, use the answer, and clarify again.",
        createdBy: "test",
      });
    await tx
      .insert(workflowSteps)
      .values({
        workflowVersionId: v,
        key: "conversation",
        name: "Conversation",
        position: 0,
        type: "agent_loop",
        configuration: {
          provider: "mock",
          allowHumanQuestions: true,
          allowHumanReview: false,
          skillVersionIds: [agentIds.skillVersion],
          mockDecisions: [
            question("Which county should I use?"),
            agentDecisions[0],
            question("Which county should I use for follow-up?"),
            ...agentDecisions.slice(3),
          ] as any,
        },
      });
    await tx
      .update(workflows)
      .set({ currentVersionId: v })
      .where(eq(workflows.id, w));
  });
  const run = await api(`/workflows/${w}/runs`, { input: {} });
  async function pending(previous?: string) {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      const { question } = await api(`/runs/${run.id}/question`);
      if (question && question.questionId !== previous) return question;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error("Question timeout");
  }
  async function rejected(path: string, body: unknown, status: number) {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, status, await r.text());
  }
  const first = await pending();
  if (process.env.TEST_WORKER_RESTART === "1") {
    execFileSync("kubectl", [
      "-n",
      "agent-engine-local",
      "rollout",
      "restart",
      "deployment/worker",
    ]);
    execFileSync("kubectl", [
      "-n",
      "agent-engine-local",
      "rollout",
      "status",
      "deployment/worker",
      "--timeout=60s",
    ]);
  }
  assert.equal((await pending()).questionId, first.questionId);
  await rejected(
    `/runs/${run.id}/answer`,
    { questionId: "stale", answer: "Wrong" },
    409,
  );
  await rejected(
    `/runs/${run.id}/answer`,
    { questionId: first.questionId, answer: "   " },
    400,
  );
  await rejected(
    `/runs/${run.id}/review`,
    { stepKey: "conversation", approved: true },
    409,
  );
  await api(`/runs/${run.id}/answer`, {
    questionId: first.questionId,
    answer: "Example County",
  });
  const second = await pending(first.questionId);
  await rejected(
    `/runs/${run.id}/answer`,
    { questionId: first.questionId, answer: "Late answer" },
    409,
  );
  await api(`/runs/${run.id}/answer`, {
    questionId: second.questionId,
    answer: "Use the same county.",
  });
  await wait(run.id);
  const detail = await api(`/sessions/${first.sessionId}`);
  assert.equal(detail.turns[0].outcome.result.answer, "Example County");
  assert.equal(detail.turns[2].outcome.result.answer, "Use the same county.");
  assert.equal(
    detail.turns[3].request.events[0].result.answer,
    "Example County",
  );
  assert.equal(
    detail.turns[3].request.events[2].result.answer,
    "Use the same county.",
  );
  assert.equal((await api(`/runs/${run.id}/question`)).question, null);
});
