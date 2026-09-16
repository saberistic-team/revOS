import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { registerBuilder } from "../../apps/api/src/builder";
import {
  db,
  pool,
  workflowVersions,
  workflowSteps,
  workflows,
  organizations,
} from "../../packages/database/src";
import { seedAgent, agentIds } from "../../scripts/seed-agent";
import { ids } from "../../scripts/seed";
const app = Fastify();
registerBuilder(app, async () => {});
after(async () => {
  await app.close();
  await pool.end();
});
async function call(method: any, url: string, payload?: any, status = 200) {
  const r = await app.inject({ method, url, payload });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
test("builder saves drafts, validates references, tests without publishing, and publishes immutable versions", async () => {
  await seedAgent();
  const catalog = await call("GET", "/builder/catalog");
  const org = catalog.agents.find(
    (a: any) => a.organizationId === ids.organization,
  ).organizationId;
  const created = await call("POST", "/builder/workflows", {
    organizationId: org,
    name: "Builder lifecycle test",
  });
  const id = created.workflow.id;
  const detail = await call("GET", `/builder/workflows/${id}`);
  let definition = {
    ...detail.draft.definition,
    goal: "Review input",
    instructions: "Ask for human review and return its decision.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    outputSchema: { type: "object", required: ["approved"] },
    steps: [
      {
        key: "review",
        name: "Review input",
        type: "human_review",
        skillVersionId: null,
        configuration: { inputFrom: "initial" },
      },
    ],
  };
  const saved = await call("PUT", `/builder/workflows/${id}`, {
    revision: 1,
    definition,
  });
  assert.equal(saved.draft.revision, 2);
  await call(
    "PUT",
    `/builder/workflows/${id}`,
    { revision: 1, definition },
    409,
  );
  await call("POST", `/builder/workflows/${id}/validate`, { revision: 2 });
  await call(
    "POST",
    `/builder/workflows/${id}/test`,
    { revision: 2, input: {} },
    400,
  );
  const trial = await call("POST", `/builder/workflows/${id}/test`, {
    revision: 2,
    input: { message: "Approve this synthetic builder test" },
  });
  assert.ok(trial.run.id);
  assert.equal(
    (await call("GET", `/builder/workflows/${id}`)).workflow.currentVersionId,
    null,
  );
  const published = await call("POST", `/builder/workflows/${id}/publish`, {
    revision: 2,
  });
  assert.notEqual(published.versionId, trial.run.workflowVersionId);
  assert.equal(
    (await call("POST", `/builder/workflows/${id}/publish`, { revision: 2 }))
      .alreadyPublished,
    true,
  );
  await assert.rejects(() =>
    db
      .update(workflowVersions)
      .set({ goal: "mutated" })
      .where(eq(workflowVersions.id, published.versionId)),
  );
  await assert.rejects(() =>
    db
      .insert(workflowSteps)
      .values({
        workflowVersionId: trial.run.workflowVersionId,
        key: "late",
        name: "Late",
        position: 1,
        type: "human_review",
      }),
  );
  definition = { ...definition, goal: "Updated goal" };
  await call("PUT", `/builder/workflows/${id}`, { revision: 2, definition });
  const v3 = await call("POST", `/builder/workflows/${id}/publish`, {
    revision: 3,
  });
  assert.equal(v3.version, 3);
  assert.equal(
    (
      await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, published.versionId))
    )[0].goal,
    "Review input",
  );
  const copy = await call("POST", "/builder/workflows", {
    organizationId: org,
    name: "Builder copy",
    duplicateId: id,
  });
  assert.equal(copy.workflow.currentVersionId, null);
  assert.equal(copy.draft.definition.goal, "Updated goal");
  const invalid = {
    ...definition,
    steps: [
      {
        key: "agent",
        name: "Agent",
        type: "agent_loop",
        skillVersionId: null,
        configuration: {
          provider: "openai",
          skillVersionIds: [agentIds.skillVersion],
          inputFrom: "steps.future",
        },
      },
    ],
  };
  await call("PUT", `/builder/workflows/${id}`, {
    revision: 3,
    definition: invalid,
  });
  await call("POST", `/builder/workflows/${id}/validate`, { revision: 4 }, 400);
  invalid.steps[0].configuration.inputFrom = "initial";
  await call("PUT", `/builder/workflows/${id}`, {
    revision: 4,
    definition: invalid,
  });
  await call("POST", `/builder/workflows/${id}/validate`, { revision: 5 });
  // End the no-cost trial through the real engine once its pending dispatch is swept.
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const r = await fetch("http://localhost:3000/runs/" + trial.run.id).then(
      (r) => r.json(),
    );
    if (r.status === "waiting") {
      const review = await fetch(
        "http://localhost:3000/runs/" + trial.run.id + "/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stepKey: "review", approved: true }),
        },
      );
      assert.equal(review.status, 202);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
});
test("library versions skills and scopes knowledge permissions to the organization", async () => {
  const catalog = await call("GET", "/builder/catalog");
  const org = ids.organization;
  const k = await call("POST", "/builder/knowledge", {
    organizationId: org,
    name: "Builder reference",
    content: "Use explicit evidence.",
  });
  const body = {
    organizationId: org,
    name: "Builder skill",
    description: "Test authoring",
    instructions: "Summarize the provided text.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    configuration: { allowedToolIds: [], allowedKnowledgeIds: [k.id] },
  };
  const first = await call("POST", "/builder/skills", body);
  const second = await call("POST", "/builder/skills", {
    ...body,
    skillId: first.skillId,
    instructions: "Summarize concisely.",
  });
  assert.equal(second.version, first.version + 1);
  await call("POST", "/builder/knowledge", {
    id: k.id,
    organizationId: org,
    name: k.name,
    content: "Updated evidence policy.",
  });
  const [foreign] = await db
    .insert(organizations)
    .values({ name: "Builder isolation test" })
    .returning();
  await call(
    "POST",
    "/builder/skills",
    { ...body, organizationId: foreign.id },
    400,
  );
  await call(
    "POST",
    "/builder/knowledge",
    { id: k.id, organizationId: foreign.id, name: "Wrong", content: "Wrong" },
    404,
  );
  await call(
    "POST",
    "/builder/skills",
    { ...body, outputSchema: { type: "not-a-json-schema-type" } },
    400,
  );
});
