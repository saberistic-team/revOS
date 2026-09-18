import assert from "node:assert/strict";
import { test } from "node:test";
import {
  priceUnits,
  productSchema,
  requirementSchema,
  usageSchema,
} from "../packages/shared/src/product-platform";
import {
  canonicalUsageHash,
  monthRange,
} from "../packages/engine/src/usage-ledger";
import {
  openCostMeasurements,
  storageAccrual,
} from "../packages/engine/src/usage-collectors";
import { assertRequirementRevision } from "../packages/engine/src/product-platform";

test("fractional token prices use integer monetary arithmetic", () => {
  assert.equal(priceUnits(1500000, 2000000, 1000000), 3000000);
  assert.equal(priceUnits(1, 2000000, 1000000), 2);
  assert.equal(priceUnits(0.25, 1000000, 1), 250000);
  assert.equal(priceUnits(0, 1, 1), 0);
  assert.throws(() => priceUnits(-1, 1, 1));
  assert.throws(() => priceUnits(1, 1, 0));
  assert.throws(() => priceUnits(9e9, Number.MAX_SAFE_INTEGER, 1), /exceeds/);
});
test("usage idempotency is independent of metadata key order but tracks real attempt changes", () => {
  assert.equal(
    canonicalUsageHash({ units: 12, metadata: { a: 1, b: 2 } }),
    canonicalUsageHash({ metadata: { b: 2, a: 1 }, units: 12 }),
  );
  assert.notEqual(
    canonicalUsageHash({ eventKey: "e", attemptId: "1" }),
    canonicalUsageHash({ eventKey: "e", attemptId: "2" }),
  );
});
test("calendar periods are UTC and handle year rollover", () => {
  assert.deepEqual(monthRange("2026-12"), [
    "2026-12-01T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
  ]);
  assert.throws(() => monthRange("2026-13"));
});
test("requirements need acceptance criteria and exact undecided revision", () => {
  assert.throws(() =>
    requirementSchema.parse({
      title: "Feature",
      description: "Build it",
      acceptanceCriteria: [],
    }),
  );
  assert.throws(
    () =>
      assertRequirementRevision(
        { current_revision: 2, state: "proposed" },
        1,
        true,
      ),
    /newer/,
  );
  assert.throws(
    () =>
      assertRequirementRevision(
        { current_revision: 1, state: "approved" },
        1,
        true,
      ),
    /already/,
  );
  assert.doesNotThrow(() =>
    assertRequirementRevision({ current_revision: 1, state: "approved" }, 1),
  );
});
test("product and measurement validation rejects unsupported or oversized input", () => {
  assert.throws(() =>
    productSchema.parse({ name: "App", repositoryUrl: "javascript:alert(1)" }),
  );
  assert.throws(() =>
    usageSchema.parse({
      organizationId: "wrong",
      provider: "openai",
      category: "llm",
      eventKey: "x",
      units: -1,
      unit: "tokens",
    }),
  );
});
test("repository size accrues only bounded observed intervals", () => {
  const previous = {
    size_bytes: 1024 ** 3,
    measured_at: "2026-09-17T10:00:00Z",
  };
  assert.equal(
    storageAccrual(previous, new Date("2026-09-17T10:15:00Z"), 45),
    0.25,
  );
  assert.equal(
    storageAccrual(previous, new Date("2026-09-17T12:00:00Z"), 45),
    null,
  );
  assert.equal(
    storageAccrual(previous, new Date("2026-09-17T09:00:00Z"), 45),
    null,
  );
});
test("OpenCost allocations preserve units and distinguish estimates from actual provider cost", () => {
  const events = openCostMeasurements(
    {
      cpuCoreHours: 2,
      cpuCost: 0.06,
      ramByteHours: 2 * 1024 ** 3,
      ramCost: 0.01,
      pvByteHours: 4 * 1024 ** 3,
      pvCost: 0.001,
    },
    {
      organizationId: "a",
      productId: "b",
      namespace: "product-b-preview",
      start: "2026-09-17T09:00:00Z",
      end: "2026-09-17T10:00:00Z",
      currency: "USD",
    },
  );
  assert.equal(events.length, 3);
  assert.equal(events[0].units, 2);
  assert.equal(events[1].units, 2);
  assert.equal(events[2].units, 4);
  assert.equal(events[0].estimatedCostMicros, 60000);
  assert.equal(events[0].actualCostMicros, undefined);
  assert.match(String(events[0].metadata?.measurement), /Allocated/);
});
test("zero OpenCost prices remain unpriced until an operator explicitly trusts them", () => {
  const context = {
    organizationId: "a",
    productId: "b",
    namespace: "product-b-preview",
    start: "2026-09-17T09:00:00Z",
    end: "2026-09-17T10:00:00Z",
    currency: "USD",
  };
  assert.equal(
    openCostMeasurements({ cpuCoreHours: 2, cpuCost: 0 }, context)[0]
      .estimatedCostMicros,
    undefined,
  );
  assert.equal(
    openCostMeasurements(
      { cpuCoreHours: 2, cpuCost: 0 },
      { ...context, trustZeroCosts: true },
    )[0].estimatedCostMicros,
    0,
  );
});
