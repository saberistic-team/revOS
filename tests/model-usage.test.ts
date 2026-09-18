import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenUsage, usageMeasurements } from "../packages/engine/src/model-usage";

test("cached and reasoning tokens are never double counted", () => {
  assert.deepEqual(tokenUsage({ usage: { input_tokens: 120, output_tokens: 80, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 60 } } }), { input: 100, cached: 20, output: 80 });
  assert.deepEqual(tokenUsage({ usage: { inputTokens: 120, outputTokens: 80, inputTokensDetails: [{ cached_tokens: 20 }] } }), { input: 100, cached: 20, output: 80 });
});
test("unknown or invalid usage is not presented as zero usage", () => {
  assert.equal(tokenUsage({}), null);
  assert.equal(tokenUsage({ usage: { inputTokens: -1, outputTokens: 4 } }), null);
  assert.equal(tokenUsage({ usage: { inputTokens: 10, outputTokens: 4, inputTokensDetails: [{ cached_tokens: 11 }] } }), null);
});
test("response identity deduplicates reprocessing and preserves separately charged calls", () => {
  const sample = { responseId: "response-one", usage: { inputTokens: 10, outputTokens: 2 }, output: [{ type: "hosted_tool_call", name: "web_search_call", id: "search-1" }, { type: "hosted_tool_call", name: "web_search_call", id: "search-1" }] };
  assert.deepEqual(usageMeasurements(sample, "fallback1"), usageMeasurements(sample, "fallback2"));
  assert.notDeepEqual(usageMeasurements(sample, "fallback1"), usageMeasurements({ ...sample, responseId: "response-two" }, "fallback1"));
  assert.equal(usageMeasurements(sample, "fallback1").filter(x => x.category === "hosted_tools").length, 1);
  assert.equal(JSON.stringify(usageMeasurements({ ...sample, secret: "never-record", output: [{ type: "reasoning", text: "private" }] }, "fallback")).includes("private"), false);
});
