import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitAssistantInput,
  checkAssistantBudget,
  ASSISTANT_INPUT_TOKENS,
} from "../packages/engine/src/assistant-budget";
test("large libraries fit budget while selected workflow and latest request remain intact", () => {
  const definition = {
    steps: [
      {
        name: "Keep original permissions",
        configuration: { allowedToolIds: ["original"] },
      },
    ],
  };
  const value = {
    context: {
      documents: Array.from({ length: 30 }, (_, i) => ({
        id: String(i),
        content: "research ".repeat(3000),
        excerpt: false,
      })),
      skills: [],
      knowledge: [],
      tools: [],
      workflows: [{ id: "chosen", definition }],
    },
    conversation: [
      { content: "old ".repeat(20000) },
      { content: "Build the requested workflow" },
    ],
    selectedWorkflowId: "chosen",
    selectedDocumentId: "0",
  };
  const result = fitAssistantInput(value, "Instructions");
  const parsed = JSON.parse(result.text);
  assert.ok(result.tokens <= ASSISTANT_INPUT_TOKENS);
  assert.deepEqual(parsed.context.workflows[0].definition, definition);
  assert.equal(
    parsed.conversation.at(-1).content,
    "Build the requested workflow",
  );
  assert.equal(value.context.documents[1].excerpt, false);
});
test("oversized mandatory request fails locally instead of truncating user intent", () => {
  assert.throws(
    () => checkAssistantBudget("token ".repeat(20000), "Instructions"),
    /too large/,
  );
});
test("truncated selected documents are flagged to prevent full replacement", () => {
  const result = fitAssistantInput(
    {
      context: {
        documents: [
          {
            id: "selected",
            content: "research ".repeat(25000),
            excerpt: false,
          },
        ],
        skills: [],
        knowledge: [],
        tools: [],
        workflows: [],
      },
      conversation: [{ content: "Explain" }],
      selectedDocumentId: "selected",
    },
    "Instructions",
  );
  assert.equal(result.context.documents[0].excerpt, true);
  assert.ok(result.tokens <= ASSISTANT_INPUT_TOKENS);
});
