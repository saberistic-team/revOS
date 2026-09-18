import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MeteredOpenAIProvider,
  modelUsageEntries,
  usageContext,
} from "../packages/engine/src/model-usage";
import { meteredActivities } from "../packages/temporal/src/activities/usage";
import {
  recordUsageDurably,
  replayUsageJournal,
} from "../packages/engine/src/usage-journal";

const organizationId = "00000000-0000-4000-8000-000000000001";
test("paid model response identity deduplicates across Temporal retries", () => {
  const response = {
    responseId: "response-one",
    usage: { inputTokens: 100, outputTokens: 30 },
  };
  const first = modelUsageEntries(response, "model", {
      organizationId,
      attemptId: "attempt-1",
      operation: "reason",
    }),
    second = modelUsageEntries(response, "model", {
      organizationId,
      attemptId: "attempt-2",
      operation: "reason",
    });
  assert.deepEqual(first, second);
  assert(first.every((v) => v.attemptId === ""));
  const next = modelUsageEntries(
    { ...response, responseId: "response-two" },
    "model",
    { organizationId, attemptId: "attempt-2", operation: "reason" },
  );
  assert.notDeepEqual(first, next);
});
test("ledger failure never discards a successful model response or stream", async () => {
  const reply = { responseId: "paid-response", output: [] },
    events = [
      { type: "response_started" },
      { type: "response_done", response: reply },
    ],
    warnings: string[] = [];
  const provider = new MeteredOpenAIProvider(
    {
      getModel: async () =>
        ({
          getResponse: async () => reply,
          async *getStreamedResponse() {
            yield* events;
          },
        }) as any,
    },
    async () => {
      throw Error("ledger failed; private detail should never be logged");
    },
    (message) => warnings.push(message),
  );
  const model = await provider.getModel("model");
  assert.equal(await model.getResponse({} as any), reply);
  const streamed = [];
  for await (const event of model.getStreamedResponse({} as any))
    streamed.push(event);
  assert.deepEqual(streamed, events);
  assert.equal(warnings.length, 2);
  assert(!warnings.join(" ").includes("private detail"));
});
test("metering failures preserve activity success and original business failure", async () => {
  const businessError = new Error("original business failure"),
    warnings: string[] = [],
    records: any[] = [];
  const wrapped = meteredActivities(
    {
      succeed: async () => {
        assert.equal(usageContext.getStore()?.organizationId, organizationId);
        return "done";
      },
      fail: async () => {
        throw businessError;
      },
    },
    {
      info: () => ({
        workflowExecution: { workflowId: "workflow", runId: "execution" },
        activityId: "activity",
        attempt: 2,
      }),
      owner: async () => ({ organizationId }),
      record: async (input) => {
        records.push(input);
        throw Error("ledger outage");
      },
      warn: (message) => warnings.push(message),
      startReplay: false,
    },
  );
  assert.equal(await wrapped.succeed(), "done");
  await assert.rejects(wrapped.fail(), (error) => error === businessError);
  assert.equal(records.length, 2);
  assert.equal(records[0].metadata.success, true);
  assert.equal(records[1].metadata.success, false);
  assert.equal(records[0].eventKey, "execution:activity:2");
  assert.equal(warnings.length, 2);
  assert.equal(usageContext.getStore(), undefined);
});
test("unavailable attribution does not prevent business work", async () => {
  let called = false;
  const wrapped = meteredActivities(
    {
      work: async () => {
        called = true;
        return 42;
      },
    },
    {
      info: () => ({
        workflowExecution: { workflowId: "w", runId: "r" },
        activityId: "a",
        attempt: 1,
      }),
      owner: async () => {
        throw Error("DB unavailable");
      },
      warn: () => {},
      startReplay: false,
    },
  );
  assert.equal(await wrapped.work(), 42);
  assert.equal(called, true);
});
test("usage receipts survive ledger outages and replay without model prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revos-usage-"));
  const input = {
    organizationId,
    provider: "openai:test",
    category: "llm_input" as const,
    eventKey: "response:input",
    units: 12,
    unit: "tokens",
    metadata: { model: "test" },
  };
  try {
    let attempts = 0;
    const result = await recordUsageDurably(input, {
      directory,
      record: async () => {
        attempts++;
        throw Error("offline");
      },
      warn: () => {},
    });
    assert.equal(result, "pending");
    assert.equal(attempts, 2);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(
      await readFile(join(directory, files[0]), "utf8"),
    );
    assert.deepEqual(receipt.input, {
      ...input,
      attemptId: "",
      currency: "USD",
    });
    assert(!JSON.stringify(receipt).includes("prompt"));
    const written: any[] = [];
    assert.deepEqual(
      await replayUsageJournal({
        directory,
        record: async (value) => written.push(value),
        warn: () => {},
      }),
      { recorded: 1, pending: 0 },
    );
    assert.equal(written.length, 1);
    assert.equal(written[0].eventKey, input.eventKey);
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(
      await replayUsageJournal({
        directory,
        record: async () => {
          throw Error("Should not replay twice");
        },
      }),
      { recorded: 0, pending: 0 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
