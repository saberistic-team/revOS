import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  skills,
  skillVersions,
  runs,
  tasks,
} from "../../packages/database/src";
import { seed, ids, syntheticInput } from "../../scripts/seed";
import {
  connectionOptions,
  namespace,
} from "../../packages/temporal/src/config";
const databaseError = (pattern: RegExp) => (error: unknown) => {
  const cause = (error as { cause?: Error }).cause;
  return pattern.test(cause?.message ?? String(error));
};
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
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const run = await api(`/runs/${id}`);
    if (run.status === status) return run;
    if (["failed", "cancelled"].includes(run.status))
      throw new Error(JSON.stringify(run));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Run timeout");
}
async function fixture(review = false, invalid = false) {
  const w = randomUUID(),
    v = randomUUID(),
    s = randomUUID(),
    sv = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(workflows).values({
      id: w,
      organizationId: ids.organization,
      name: "Onboarding test",
      slug: w,
    });
    await tx.insert(workflowVersions).values({
      id: v,
      workflowId: w,
      version: 1,
      goal: "Welcome a new customer",
      sopMarkdown: "Produce a greeting; optionally wait for approval.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      createdBy: "integration",
    });
    await tx.insert(skills).values({
      id: s,
      name: "Welcome",
      slug: s,
      organizationId: ids.organization,
    });
    await tx.insert(skillVersions).values({
      id: sv,
      skillId: s,
      version: 1,
      instructions: "Welcome a customer",
      executionType: "llm",
      inputSchema: { type: "object" },
      outputSchema: invalid
        ? { type: "object", required: ["missing"] }
        : { type: "object" },
      configuration: { mockResponse: { greeting: "Welcome aboard" } },
    });
    await tx.insert(workflowSteps).values({
      workflowVersionId: v,
      key: "welcome",
      name: "Welcome",
      position: 0,
      type: "skill",
      skillVersionId: sv,
    });
    if (review)
      await tx.insert(workflowSteps).values({
        workflowVersionId: v,
        key: "approve",
        name: "Approval",
        position: 1,
        type: "human_review",
      });
    await tx
      .update(workflows)
      .set({ currentVersionId: v })
      .where(eq(workflows.id, w));
  });
  return { w, v, sv };
}
after(() => pool.end());
test("seed is idempotent and pins the expected five skill relationships", async () => {
  await seed();
  await seed();
  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflowVersionId, ids.version));
  assert.equal(steps.length, 5);
  assert.ok(steps.every((s) => s.skillVersionId));
  const detail = await api(`/workflows/${ids.workflow}`);
  assert.equal(detail.version.version, 1);
});
test("synthetic workflow completes in Temporal and persists business results", async () => {
  const run = await api(`/workflows/${ids.workflow}/runs`, {
    input: syntheticInput,
  });
  const result = await wait(run.id);
  assert.equal(result.workflowVersionId, ids.version);
  assert.equal(result.steps.length, 5);
  assert.ok(result.steps.every((s: any) => s.status === "completed"));
  assert.equal(result.output.synthetic, true);
  const connection = await Connection.connect(connectionOptions());
  try {
    const client = new Client({ connection, namespace });
    assert.deepEqual(
      await client.workflow.getHandle(run.temporalWorkflowId).result(),
      result.output,
    );
  } finally {
    await connection.close();
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
  assert.equal(task.status, "completed");
  await assert.rejects(
    db
      .update(workflowVersions)
      .set({ goal: "Mutated" })
      .where(eq(workflowVersions.id, ids.version)),
    databaseError(/immutable/),
  );
  await assert.rejects(
    db
      .update(skillVersions)
      .set({ instructions: "Mutated" })
      .where(
        eq(skillVersions.id, result.executionDefinition.steps[0].skill.id),
      ),
    databaseError(/immutable/),
  );
  await assert.rejects(
    db.insert(workflowSteps).values({
      workflowVersionId: ids.version,
      key: "late",
      name: "Late",
      position: 99,
      type: "human_review",
    }),
    databaseError(/sealed/),
  );
  await assert.rejects(
    db
      .update(runs)
      .set({
        executionDefinition: { ...result.executionDefinition, knowledge: [] },
      })
      .where(eq(runs.id, run.id)),
    databaseError(/immutable/),
  );
});
test("generic engine runs unrelated onboarding; old Run stays on v1 after publishing v2", async () => {
  const f = await fixture();
  const run = await api(`/workflows/${f.w}/runs`, {
    input: { customer: "Synthetic Customer" },
  });
  await wait(run.id);
  const v2 = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(workflowVersions).values({
      id: v2,
      workflowId: f.w,
      version: 2,
      goal: "New goal",
      sopMarkdown: "New SOP",
      createdBy: "test",
    });
    await tx.insert(workflowSteps).values({
      workflowVersionId: v2,
      key: "welcome",
      name: "Welcome",
      position: 0,
      type: "skill",
      skillVersionId: f.sv,
    });
    await tx
      .update(workflows)
      .set({ currentVersionId: v2 })
      .where(eq(workflows.id, f.w));
  });
  const old = await api(`/runs/${run.id}`);
  assert.equal(old.workflowVersionId, f.v);
  assert.deepEqual(old.output, { greeting: "Welcome aboard" });
  await assert.rejects(
    db.update(runs).set({ workflowVersionId: v2 }).where(eq(runs.id, run.id)),
    databaseError(/immutable/),
  );
  const newer = await api(`/workflows/${f.w}/runs`, { input: {} });
  assert.equal((await wait(newer.id)).workflowVersionId, v2);
});
test("human review waits for a Temporal signal and resumes", async () => {
  const f = await fixture(true);
  const run = await api(`/workflows/${f.w}/runs`, { input: {} });
  await wait(run.id, "waiting");
  await api(`/runs/${run.id}/review`, {
    stepKey: "approve",
    approved: true,
    note: "Synthetic approval",
  });
  assert.equal((await wait(run.id)).output.approved, true);
});
test("invalid skill output fails Run and RunStep after bounded retries", async () => {
  const f = await fixture(false, true);
  const run = await api(`/workflows/${f.w}/runs`, { input: {} });
  const result = await wait(run.id, "failed");
  assert.equal(result.steps[0].status, "failed");
  assert.match(result.error, /missing/);
});
