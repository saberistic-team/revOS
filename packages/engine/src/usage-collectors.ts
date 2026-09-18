import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "../../database/src";
import { forgejo } from "./forgejo";
import {
  ledgerTransaction,
  recordUsage,
  type UsageInput,
} from "./usage-ledger";

const GiB = 1024 ** 3;
export const collectionConfigSchema = z.object({
  forgejoEnabled: z.boolean(),
  openCostEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
});
export async function collectionStatus(org: string) {
  const [config, samples] = await Promise.all([
    pool.query(
      "SELECT * FROM usage_collection_config WHERE organization_id=$1",
      [org],
    ),
    pool.query(
      "SELECT DISTINCT ON(provider,resource_key) product_id,provider,resource_key,size_bytes,measured_at FROM usage_storage_sample WHERE organization_id=$1 ORDER BY provider,resource_key,measured_at DESC",
      [org],
    ),
  ]);
  return {
    configuration: config.rows[0] || {
      forgejo_enabled: true,
      opencost_enabled: false,
      interval_minutes: 15,
      last_collected_at: null,
      last_error: null,
    },
    capabilities: {
      collectorEnabled: process.env.PLATFORM_DISPATCH_ENABLED === "true",
      forgejoConfigured: !!process.env.FORGEJO_TOKEN,
      openCostConfigured: !!process.env.OPENCOST_URL,
    },
    storageSamples: samples.rows,
  };
}
export async function configureCollection(org: string, raw: unknown) {
  const b = collectionConfigSchema.parse(raw);
  return (
    await pool.query(
      "INSERT INTO usage_collection_config(organization_id,forgejo_enabled,opencost_enabled,interval_minutes) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET forgejo_enabled=$2,opencost_enabled=$3,interval_minutes=$4,updated_at=now() RETURNING *",
      [org, b.forgejoEnabled, b.openCostEnabled, b.intervalMinutes],
    )
  ).rows[0];
}
export function storageAccrual(
  previous: { size_bytes: string | number; measured_at: string | Date },
  sampledAt: Date,
  maxGapMinutes: number,
) {
  const elapsed =
    (sampledAt.getTime() - new Date(previous.measured_at).getTime()) / 3600000;
  if (elapsed <= 0 || elapsed > maxGapMinutes / 60) return null;
  return Math.round((Number(previous.size_bytes) / GiB) * elapsed * 1e6) / 1e6;
}
export async function recordStorageSample(input: {
  organizationId: string;
  productId?: string;
  resourceKey: string;
  sizeBytes: number;
  sampledAt: Date;
  intervalMinutes: number;
}) {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw Error("Invalid repository storage size");
  const bucket = new Date(
    Math.floor(input.sampledAt.getTime() / (input.intervalMinutes * 60000)) *
      input.intervalMinutes *
      60000,
  );
  return ledgerTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "storage:" + input.organizationId + ":" + input.resourceKey,
    ]);
    const previous = (
      await c.query(
        "SELECT * FROM usage_storage_sample WHERE organization_id=$1 AND provider='forgejo' AND resource_key=$2 ORDER BY measured_at DESC LIMIT 1",
        [input.organizationId, input.resourceKey],
      )
    ).rows[0];
    const sample = (
      await c.query(
        "INSERT INTO usage_storage_sample(organization_id,product_id,provider,resource_key,size_bytes,bucket_start,measured_at) VALUES($1,$2,'forgejo',$3,$4,$5,$6) ON CONFLICT(organization_id,provider,resource_key,bucket_start) DO NOTHING RETURNING *",
        [
          input.organizationId,
          input.productId ?? null,
          input.resourceKey,
          input.sizeBytes,
          bucket,
          input.sampledAt,
        ],
      )
    ).rows[0];
    if (!sample || !previous) return { recorded: !!sample, accrued: false };
    const units = storageAccrual(
      previous,
      input.sampledAt,
      input.intervalMinutes * 3,
    );
    if (units === null) return { recorded: true, accrued: false, gap: true };
    await recordUsage(
      {
        organizationId: input.organizationId,
        productId: input.productId,
        provider: "forgejo",
        category: "forgejo",
        eventKey: "storage:" + sample.id,
        unit: "gib_hours",
        units,
        measuredAt: input.sampledAt.toISOString(),
        metadata: {
          repository: input.resourceKey,
          measurementMethod:
            "Previous observed Git repository size multiplied by elapsed time",
          from: new Date(previous.measured_at).toISOString(),
          to: input.sampledAt.toISOString(),
          sizeBytes: Number(previous.size_bytes),
          coverage:
            "Git repository storage only; excludes LFS, packages and backups",
        },
      },
      c,
    );
    return { recorded: true, accrued: true };
  });
}
export function openCostMeasurements(
  allocation: any,
  {
    organizationId,
    productId,
    namespace,
    start,
    end,
    currency,
    trustZeroCosts = false,
  }: {
    organizationId: string;
    productId: string;
    namespace: string;
    start: string;
    end: string;
    currency: string;
    trustZeroCosts?: boolean;
  },
): UsageInput[] {
  const components = [
    {
      quantity: "cpuCoreHours",
      cost: "cpuCost",
      category: "compute" as const,
      unit: "cpu_core_hours",
      scale: 1,
    },
    {
      quantity: "ramByteHours",
      cost: "ramCost",
      category: "compute" as const,
      unit: "ram_gib_hours",
      scale: GiB,
    },
    {
      quantity: "pvByteHours",
      cost: "pvCost",
      category: "storage" as const,
      unit: "pv_gib_hours",
      scale: GiB,
    },
  ];
  return components
    .filter(
      (c) =>
        typeof allocation[c.quantity] === "number" &&
        Number.isFinite(allocation[c.quantity]) &&
        allocation[c.quantity] >= 0,
    )
    .map((c) => ({
      organizationId,
      productId,
      provider: "opencost",
      category: c.category,
      eventKey: namespace + ":" + start + ":" + end + ":" + c.quantity,
      unit: c.unit,
      units: Math.round((allocation[c.quantity] / c.scale) * 1e6) / 1e6,
      measuredAt: end,
      ...(typeof allocation[c.cost] === "number" &&
      Number.isFinite(allocation[c.cost]) &&
      (allocation[c.cost] > 0 || (trustZeroCosts && allocation[c.cost] === 0))
        ? { estimatedCostMicros: Math.round(allocation[c.cost] * 1e6) }
        : {}),
      currency,
      metadata: {
        namespace,
        start,
        end,
        costBasis:
          "OpenCost allocation estimate; provider invoice not reconciled",
        measurement:
          "Allocated resources; includes requested capacity, not just utilization",
      },
    }));
}
async function collectForgejo(
  org: string,
  products: any[],
  intervalMinutes: number,
) {
  const owner = encodeURIComponent(process.env.FORGEJO_OWNER || "revos");
  const repos = [
    { name: "knowledge-" + org, productId: undefined },
    { name: "products-" + org, productId: undefined },
    ...products.map((p) => ({ name: "product-" + p.id, productId: p.id })),
    ...products.map((p) => ({ name: "delivery-" + p.id, productId: p.id })),
  ];
  for (const repo of repos) {
    const result = await forgejo(`/repos/${owner}/${repo.name}`);
    if (!result) continue;
    // Forgejo's Gitea-compatible repository API reports Git size in KiB.
    if (
      typeof result.size !== "number" ||
      !Number.isFinite(result.size) ||
      result.size < 0
    )
      continue;
    await recordStorageSample({
      organizationId: org,
      productId: repo.productId,
      resourceKey: repo.name,
      sizeBytes: Math.round(result.size * 1024),
      sampledAt: new Date(),
      intervalMinutes,
    });
  }
}
async function collectOpenCost(
  org: string,
  products: any[],
  lastCollected?: Date,
) {
  const base = process.env.OPENCOST_URL;
  if (!base) throw Error("OpenCost endpoint is not configured");
  // Fixed completed UTC hours avoid overlapping windows and idempotency drift.
  const endMs = Math.floor(Date.now() / 3600000) * 3600000;
  const first = Math.max(
    endMs - 24 * 3600000,
    lastCollected
      ? Math.floor(new Date(lastCollected).getTime() / 3600000) * 3600000
      : endMs - 3600000,
  );
  const currency = process.env.OPENCOST_CURRENCY || "USD";
  for (let from = first; from < endMs; from += 3600000) {
    const start = new Date(from).toISOString(),
      end = new Date(from + 3600000).toISOString();
    const url = new URL("allocation", base.replace(/\/$/, "") + "/");
    url.searchParams.set("window", start + "," + end);
    url.searchParams.set("aggregate", "namespace");
    url.searchParams.set("accumulate", "true");
    url.searchParams.set("includeIdle", "false");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: process.env.OPENCOST_TOKEN
        ? { Authorization: "Bearer " + process.env.OPENCOST_TOKEN }
        : {},
    });
    if (!response.ok)
      throw Error("OpenCost request failed (" + response.status + ")");
    const payload = (await response.json()) as any;
    if (!Array.isArray(payload.data))
      throw Error("OpenCost returned no allocation data");
    for (const product of products)
      for (const environment of ["preview", "live"]) {
        const namespace = "product-" + product.id + "-" + environment;
        const allocation = payload.data[0]?.[namespace];
        if (!allocation) continue;
        for (const event of openCostMeasurements(allocation, {
          organizationId: org,
          productId: product.id,
          namespace,
          start,
          end,
          currency,
          trustZeroCosts: process.env.OPENCOST_TRUST_ZERO_COSTS === "true",
        })) {
          // OpenCost recalculates historical estimates. A stored interval remains immutable.
          if (
            (
              await pool.query(
                "SELECT id FROM usage_event WHERE organization_id=$1 AND provider='opencost' AND event_key=$2 AND attempt_id=''",
                [org, event.eventKey],
              )
            ).rowCount
          )
            continue;
          await recordUsage(event);
        }
      }
  }
}
export async function collectOrganizationUsage(org: string) {
  const connection = await pool.connect();
  const lock = "collect-usage:" + org;
  try {
    const acquired = (
      await connection.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [lock],
      )
    ).rows[0].acquired;
    if (!acquired) return { skipped: true };
    const state = (
      await pool.query(
        "INSERT INTO usage_collection_config(organization_id) VALUES($1) ON CONFLICT(organization_id) DO UPDATE SET organization_id=excluded.organization_id RETURNING *",
        [org],
      )
    ).rows[0];
    const products = (
      await pool.query(
        "SELECT id FROM platform_product WHERE organization_id=$1",
        [org],
      )
    ).rows;
    if (state.forgejo_enabled)
      await collectForgejo(org, products, state.interval_minutes);
    if (state.opencost_enabled)
      await collectOpenCost(org, products, state.last_collected_at);
    await pool.query(
      "UPDATE usage_collection_config SET last_collected_at=now(),last_error=NULL WHERE organization_id=$1",
      [org],
    );
    return { collected: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Usage collection failed";
    // Errors from external services may contain response bodies; keep those out of customer UI.
    const safe = message.startsWith("OpenCost")
      ? message
      : "Storage collection failed; check the configured Forgejo connection";
    await pool.query(
      "UPDATE usage_collection_config SET last_error=$2 WHERE organization_id=$1",
      [org, safe],
    );
    return { collected: false, error: safe };
  } finally {
    await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
    connection.release();
  }
}
export async function collectDueUsage() {
  const organizations = (
    await pool.query(
      "SELECT o.id FROM organization o LEFT JOIN usage_collection_config c ON c.organization_id=o.id WHERE (coalesce(c.forgejo_enabled,true) OR coalesce(c.opencost_enabled,false)) AND (c.last_collected_at IS NULL OR c.last_collected_at < now()-make_interval(mins=>c.interval_minutes)) ORDER BY c.last_collected_at NULLS FIRST LIMIT 25",
    )
  ).rows;
  for (const org of organizations) await collectOrganizationUsage(org.id);
}
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function rotateUsageCredential(org: string, productId: string) {
  if (
    !(
      await pool.query(
        "SELECT id FROM platform_product WHERE id=$1 AND organization_id=$2",
        [productId, org],
      )
    ).rowCount
  )
    throw Error("Product not found");
  const token = "usage_" + randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO usage_ingestion_credential(product_id,token_hash) VALUES($1,$2) ON CONFLICT(product_id) DO UPDATE SET token_hash=$2,updated_at=now()",
    [productId, tokenHash(token)],
  );
  return {
    token,
    productId,
    endpoint: "/product-usage/" + productId + "/events",
    notice:
      "Shown once. Keep it in the product backend secret store. Rotating invalidates the previous token.",
  };
}
export async function ingestProductUsage(
  productId: string,
  token: string,
  raw: unknown,
) {
  const credential = (
    await pool.query(
      "SELECT c.token_hash,p.organization_id FROM usage_ingestion_credential c JOIN platform_product p ON p.id=c.product_id WHERE c.product_id=$1",
      [productId],
    )
  ).rows[0];
  const actual = Buffer.from(tokenHash(token)),
    expected = Buffer.from(credential?.token_hash || "0".repeat(64));
  if (!credential || !timingSafeEqual(actual, expected))
    throw Object.assign(Error("Invalid usage credential"), { statusCode: 401 });
  const b = z
    .object({
      eventKey: z.string().min(1).max(240),
      attemptId: z.string().max(160).optional(),
      unit: z.string().min(1).max(80).default("requests"),
      units: z.number().nonnegative().max(1e9),
      measuredAt: z.iso.datetime().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .parse(raw);
  return recordUsage({
    ...b,
    organizationId: credential.organization_id,
    productId,
    provider: "product-api",
    category: "api",
  });
}
