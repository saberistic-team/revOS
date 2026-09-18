import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeFingerprint,
  validateMindmap,
} from "../packages/shared/src/mindmap";
const doc = {
  id: "a",
  revision: 1,
  content: "Luxury jewelry",
  title: "Business",
  evidence: "researched",
};
const graph = {
  title: "Customer",
  summary: "Overview",
  nodes: [
    {
      id: "a",
      label: "Consignors",
      summary: "Supply inventory",
      theme: "Business model",
      evidence: "researched",
      sourceIds: ["source-a"],
    },
    {
      id: "b",
      label: "Inventory",
      summary: "Products",
      theme: "Business model",
      evidence: "inferred",
      sourceIds: ["source-b"],
    },
  ],
  edges: [
    {
      from: "a",
      to: "b",
      label: "supplies",
      inferred: true,
      sourceIds: ["source-a"],
    },
  ],
};
test("knowledge fingerprint detects edits, additions, removals, revisions and evidence changes but ignores order", () => {
  const other = { ...doc, id: "b" };
  assert.equal(
    knowledgeFingerprint([doc, other]),
    knowledgeFingerprint([other, doc]),
  );
  for (const edited of [
    { ...doc, content: "Watches" },
    { ...doc, revision: 2 },
    { ...doc, evidence: "customer_confirmed" },
    { ...doc, title: "New title" },
  ])
    assert.notEqual(
      knowledgeFingerprint([doc]),
      knowledgeFingerprint([edited]),
    );
  assert.notEqual(
    knowledgeFingerprint([doc]),
    knowledgeFingerprint([doc, other]),
  );
  assert.notEqual(knowledgeFingerprint([doc]), knowledgeFingerprint([]));
});
test("semantic map accepts source-backed concepts and inferred connections", () => {
  assert.equal(
    validateMindmap(graph, ["source-a", "source-b"]).edges[0].inferred,
    true,
  );
});
test("map rejects foreign sources, missing evidence, duplicate nodes and dangling edges", () => {
  assert.throws(() => validateMindmap(graph, ["source-a"]), /unknown sources/);
  assert.throws(
    () =>
      validateMindmap(
        { ...graph, nodes: [{ ...graph.nodes[0], sourceIds: [] }] },
        ["source-a"],
      ),
    /sources/,
  );
  assert.throws(
    () =>
      validateMindmap({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }, [
        "source-a",
      ]),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateMindmap(
        { ...graph, edges: [{ ...graph.edges[0], to: "missing" }] },
        ["source-a", "source-b"],
      ),
    /connection/,
  );
});
