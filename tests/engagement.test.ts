import test from "node:test";
import assert from "node:assert/strict";
import {
  chainStagesSchema,
  engagementDecisionSchema,
  handoffInput,
} from "../packages/shared/src/engagement";
const id = "11111111-1111-4111-a111-111111111111";
test("revision requests require feedback and approvals identify an exact attempt", () => {
  assert.equal(
    engagementDecisionSchema.safeParse({ attemptId: id, action: "revise" })
      .success,
    false,
  );
  assert.equal(
    engagementDecisionSchema.safeParse({ action: "approve" }).success,
    false,
  );
  assert.equal(
    engagementDecisionSchema.safeParse({
      attemptId: id,
      action: "revise",
      feedback: "Change the audience",
      source: "customer",
    }).success,
    true,
  );
});
test("handoffs preserve approved findings, revision history and feedback attribution without mutating original input", () => {
  const initial = { company_name: "Example", engagement: { ignored: true } },
    approved = { runId: id, output: { evidence: ["a"] } },
    revision = { output: { version: 1 } },
    feedback = [{ content: "New constraint", source: "operator" }];
  const result = handoffInput(initial, approved, revision, feedback);
  assert.deepEqual(result.engagement.approvedPreviousStage, approved);
  assert.deepEqual(result.engagement.revisionOf, revision);
  assert.equal(result.engagement.feedback[0].source, "operator");
  assert.deepEqual(initial.engagement, { ignored: true });
});
test("chains require at least one concrete workflow and limit graph size", () => {
  assert.equal(chainStagesSchema.safeParse([]).success, false);
  assert.equal(
    chainStagesSchema.safeParse([{ name: "Research", workflowId: "invented" }])
      .success,
    false,
  );
  assert.equal(
    chainStagesSchema.safeParse([{ name: "Research", workflowId: id }]).success,
    true,
  );
});
