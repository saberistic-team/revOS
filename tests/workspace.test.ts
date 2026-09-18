import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeBodySchema,
  skillBodySchema,
  resultMarkdown,
  knowledgeMarkdown,
  assistantOutputSchema,
} from "../packages/shared/src/workspace";
test("knowledge edits require bounded content, explicit evidence and valid relationship IDs", () => {
  assert.throws(() =>
    knowledgeBodySchema.parse({
      title: "X",
      category: "notes",
      content: "",
      evidence: "unverified",
    }),
  );
  assert.throws(() =>
    knowledgeBodySchema.parse({
      title: "X",
      category: "notes",
      content: "test",
      evidence: "proven",
    }),
  );
  assert.throws(() =>
    knowledgeBodySchema.parse({
      title: "X",
      category: "notes",
      content: "test",
      evidence: "unverified",
      relatedIds: ["another-organization"],
    }),
  );
  assert.equal(
    knowledgeBodySchema.parse({
      title: "X",
      category: "notes",
      content: "test",
      evidence: "researched",
    }).evidence,
    "researched",
  );
});
test("repository markdown preserves evidence, source provenance and revision metadata", () => {
  const doc = {
    id: "doc",
    title: "Profile",
    category: "business",
    evidence: "researched",
    revision: 2,
    relatedIds: [],
    provenance: { runId: "run", workflowStepId: "step" },
    content: "Source: https://example.com\nUnknown: annual revenue",
  };
  const text = knowledgeMarkdown(doc);
  const meta = JSON.parse(text.match(/^<!-- revos:(.+) -->/)![1]);
  assert.equal(meta.provenance.runId, "run");
  assert.equal(meta.revision, 2);
  assert.ok(text.includes(doc.content));
  assert.ok(text.includes("researched"));
});
test("saved research renderer retains source URLs and unknown values without inventing facts", () => {
  const text = resultMarkdown({
    source: "https://example.com",
    revenue: null,
    opportunities: ["Improve follow-up"],
  });
  assert.ok(text.includes("https://example.com"));
  assert.ok(text.includes("Not provided"));
  assert.ok(text.includes("Improve follow-up"));
});
test("assistant proposal envelope does not accept arbitrary executable action kinds", () => {
  assert.throws(() =>
    assistantOutputSchema.parse({
      explanation: "",
      questions: [],
      citations: [],
      proposals: [
        {
          kind: "shell",
          targetId: null,
          title: "x",
          reason: "x",
          bodyJson: "{}",
        },
      ],
    }),
  );
  assert.throws(() =>
    skillBodySchema.parse({
      name: "x",
      instructions: "",
      description: "",
      inputSchema: {},
      outputSchema: {},
      configuration: {},
    }),
  );
});
