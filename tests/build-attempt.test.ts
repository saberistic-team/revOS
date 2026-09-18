import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAttempt, buildJobName, buildWorkflowId, resumedBuildResult } from "../packages/engine/src/build-attempt";
const id = "32ff4b0f-6838-4aa2-9a09-b966a4e3f616";
const requestId = "ab72f9be-f467-4c72-9c2d-ce71d9e5dc5d";
test("resume keeps history and uses distinct stable execution identities", () => {
  const first = resumedBuildResult({ state: "failed", error: "iteration limit", updated_at: "2026-09-17T00:00:00Z" }, requestId);
  assert.equal(buildAttempt({ result: first }), 1);
  assert.equal(first._attemptHistory[0].error, "iteration limit");
  assert.equal(buildJobName(id), `build-${id}`);
  assert.equal(buildJobName(id, 1), `build-${id}-r1`);
  assert.equal(buildWorkflowId(id, 1), `build:${id}:retry:1`);
  assert.strictEqual(resumedBuildResult({ state: "running", result: first }, requestId), first);
  assert.strictEqual(resumedBuildResult({ state: "completed", result: first }, requestId), first);
  const second = resumedBuildResult({ state: "failed", result: first }, id);
  assert.equal(second._retry.attempt, 2);
  assert.equal(second._attemptHistory.length, 2);
  assert.equal(second._attemptHistory[1].requestId, requestId);
  assert.strictEqual(resumedBuildResult({ state: "failed", result: second }, requestId), second);
});
test("resume rejects active/completed work and invalid operation identities", () => {
  for (const state of ["pending", "running", "completed"]) assert.throws(() => resumedBuildResult({ state }, requestId), /Only a failed/);
  assert.throws(() => resumedBuildResult({ state: "failed" }, "bad"));
  assert.throws(() => buildJobName("../escape"));
  assert.throws(() => buildJobName(id, -1));
});
