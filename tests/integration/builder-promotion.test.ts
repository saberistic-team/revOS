import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { registerBuilder } from "../../apps/api/src/builder";
import {
  db,
  pool,
  runs,
  workflowVersions,
  workflowSteps,
  reasoningSessions,
  reasoningTurns,
} from "../../packages/database/src";
import { Context } from "@temporalio/activity";
import { ToolRegistry } from "../../packages/engine/src";
import { sessionConfig } from "../../packages/engine/src/agent-policy";
import { createSessionActivities } from "../../packages/temporal/src/activities/sessions";

test(
  "authoring promotion, required tool registration, and model-output correction",
  { skip: !(process.env.DATABASE_URL || "").includes("discovery_verify") },
  async () => {
    assert.match(
      process.env.DATABASE_URL || "",
      /discovery_verify/,
      "Use an isolated verification database",
    );
    const app = Fastify();
    registerBuilder(app, async () => {});
    async function call(
      url: string,
      payload?: any,
      method: any = "POST",
      expected = 200,
    ) {
      const r = await app.inject({ method, url, payload });
      assert.equal(r.statusCode, expected, r.body);
      return r.json();
    }
    try {
      const org = await call("/builder/organizations", {
        name: "Verification",
      });
      const agent = await call("/builder/agents", {
        organizationId: org.id,
        name: "Reviewer",
        instructions: "Review input",
      });
      const tool = await call("/builder/tools/enable", {
        slug: "openai-web-research",
      });
      assert.equal(
        (await call("/builder/tools/enable", { slug: "openai-web-research" }))
          .id,
        tool.id,
      );
      await call(
        "/builder/tools/enable",
        { slug: "arbitrary.code" },
        "POST",
        400,
      );
      const w = await call("/builder/workflows", {
        organizationId: org.id,
        name: "Verification",
      });
      const saved = await call(
        `/builder/workflows/${w.workflow.id}`,
        {
          revision: w.draft.revision,
          definition: {
            ...w.draft.definition,
            agentId: agent.id,
            goal: "Review",
            instructions: "Review",
            steps: [
              {
                key: "review",
                name: "Review",
                type: "human_review",
                skillVersionId: null,
                configuration: { outputMode: "input" },
              },
            ],
          },
        },
        "PUT",
      );
      const body = { revision: saved.draft.revision, input: {} };
      const first = await call(
        `/builder/workflows/${w.workflow.id}/test`,
        body,
      );
      const second = await call(
        `/builder/workflows/${w.workflow.id}/test`,
        body,
      );
      assert.equal(first.run.workflowVersionId, second.run.workflowVersionId);
      const [step] = await db
        .select()
        .from(workflowSteps)
        .where(
          eq(workflowSteps.workflowVersionId, first.run.workflowVersionId),
        );
      const [session] = await db
        .insert(reasoningSessions)
        .values({
          runId: first.run.id,
          workflowStepId: step.id,
          input: {},
          snapshot: {
            config: sessionConfig({}),
            outputSchema: { type: "object" },
            catalog: [
              {
                id: "test-skill",
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
                id: w.workflow.id,
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
          },
        })
        .returning();
      let calls = 0;
      const activities = createSessionActivities(new ToolRegistry(), {
        reason: async (request) => {
          calls++;
          if (calls === 2)
            assert.match(request.validationFeedback?.error || "", /valid JSON/);
          return {
            action: "select_skill",
            target: "test-skill",
            payload: calls === 1 ? "{truncated" : "{}",
            summary: "Test correction",
          };
        },
      });
      const original = Context.current;
      (Context as any).current = () => ({
        cancellationSignal: new AbortController().signal,
      });
      try {
        const corrected = await activities.reason({
          sessionId: session.id,
          turn: 0,
        });
        assert.equal(corrected.payload, "{}");
        assert.equal(calls, 2);
        assert.deepEqual(
          await activities.reason({ sessionId: session.id, turn: 0 }),
          corrected,
        );
        assert.equal(
          calls,
          2,
          "Committed decision is reused without another model call",
        );
        const rows = await db
          .select()
          .from(reasoningTurns)
          .where(eq(reasoningTurns.sessionId, session.id));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].decision.payload, "{}");
      } finally {
        (Context as any).current = original;
      }
      const publish = `/builder/workflows/${w.workflow.id}/publish`;
      await call(
        publish,
        { revision: body.revision, testedRunId: first.run.id },
        "POST",
        409,
      );
      await db
        .update(runs)
        .set({ status: "completed" })
        .where(eq(runs.id, first.run.id));
      const promoted = await call(publish, {
        revision: body.revision,
        testedRunId: first.run.id,
      });
      assert.equal(promoted.version, 1);
      assert.equal(promoted.versionId, first.run.workflowVersionId);
      const changed = await call(
        `/builder/workflows/${w.workflow.id}`,
        {
          revision: body.revision,
          definition: { ...saved.draft.definition, goal: "Changed" },
        },
        "PUT",
      );
      await call(
        publish,
        { revision: changed.draft.revision, testedRunId: first.run.id },
        "POST",
        409,
      );
      assert.equal(
        (
          await db
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.workflowId, w.workflow.id))
        ).length,
        1,
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
