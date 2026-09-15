import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  MockModelProvider,
  validate,
  bindInput,
} from "../packages/engine/src";
import { registerDemoTools } from "../apps/worker/src/demo-tools";
test("DB handler name resolves to adapter; unknown handlers fail", async () => {
  const registry = new ToolRegistry();
  registerDemoTools(registry);
  assert.deepEqual(
    await registry.resolve("property.search")(
      {},
      { syntheticResults: { properties: [] } },
    ),
    { properties: [] },
  );
  assert.throws(() => registry.resolve("missing"), /Unknown tool/);
});
test("mock model executes DB configuration without business dispatch", async () => {
  const provider = new MockModelProvider();
  assert.deepEqual(
    await provider.generate({
      instructions: "Summarize onboarding",
      input: {},
      outputSchema: {},
      configuration: { mockResponse: { welcome: "hello" } },
      context: {},
    }),
    { output: { welcome: "hello" } },
  );
  await assert.rejects(
    () =>
      provider.generate({
        instructions: "",
        input: {},
        outputSchema: {},
        configuration: {},
        context: {},
      }),
    /mockResponse/,
  );
});
test("schemas reject invalid input and bindings resolve explicit prior steps", () => {
  assert.throws(
    () => validate({ type: "object", required: ["name"] }, {}, "input"),
    /name/,
  );
  assert.deepEqual(
    bindInput(
      { inputFrom: "steps.first" },
      { initial: {}, previous: {}, steps: { first: { ok: true } } },
    ),
    { ok: true },
  );
  assert.throws(
    () =>
      bindInput(
        { inputFrom: "steps.missing" },
        { initial: {}, previous: {}, steps: {} },
      ),
    /Unknown step/,
  );
});
