import assert from "node:assert/strict";
import { test } from "node:test";
import { collaborativeStageDefinition } from "../scripts/seed-collaborative-delivery";

const agent = "00000000-0000-4000-8000-000000000001",
  skill = "00000000-0000-4000-8000-000000000002",
  participant = "00000000-0000-4000-8000-000000000003";
test("collaborative chain stage retains source gates, build requirements and output settings without modifying source", () => {
  const source: any = {
    name: "Product",
    description: "Existing description",
    agentId: agent,
    goal: "Build and verify",
    instructions: "Original instructions",
    inputSchema: {
      type: "object",
      required: ["customer"],
      properties: { customer: { type: "string" } },
    },
    outputSchema: { type: "object" },
    steps: [
      {
        key: "build",
        name: "Build product",
        type: "agent_loop",
        skillVersionId: null,
        configuration: {
          provider: "openai",
          model: "gpt-4.1",
          skillVersionIds: [skill],
          inputFrom: "context",
          requireCompletedBuild: true,
          maxTurns: 40,
          allowHumanReview: true,
          outputs: {
            presentation: "report",
            artifacts: { mode: "manual", formats: ["pdf"] },
          },
        },
      },
      {
        key: "review",
        name: "Customer review",
        type: "human_review",
        skillVersionId: null,
        configuration: { inputFrom: "previous", outputMode: "input" },
      },
    ],
  };
  const before = structuredClone(source),
    result = collaborativeStageDefinition(
      source,
      "Collaborative Customer Product",
      [participant, participant],
    );
  assert.deepEqual(source, before);
  assert.equal(result.instructions.startsWith("Original instructions"), true);
  assert.deepEqual(result.inputSchema, source.inputSchema);
  assert.deepEqual(result.outputSchema, source.outputSchema);
  assert.deepEqual(result.steps[1], source.steps[1]);
  assert.deepEqual(result.steps[0].configuration.skillVersionIds, [
    skill,
    participant,
  ]);
  assert.equal(result.steps[0].configuration.requireCompletedBuild, true);
  assert.equal(result.steps[0].configuration.allowHumanReview, true);
  assert.equal(result.steps[0].configuration.allowHumanQuestions, true);
  assert.deepEqual(
    result.steps[0].configuration.outputs,
    source.steps[0].configuration.outputs,
  );
  assert.match(
    result.steps[0].configuration.goal,
    /reviewer accepts or rejects/,
  );
});
