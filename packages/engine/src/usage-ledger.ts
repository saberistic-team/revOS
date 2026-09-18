import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../../database/src";
import {
  billingTermsSchema,
  priceUnits,
  rateSchema,
  usageSchema,
} from "../../shared/src/product-platform";

type Queryable = Pick<PoolClient, "query">;
export type UsageInput = z.input<typeof usageSchema>;
export function canonicalUsageHash(value: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export async function ledgerTransaction<T>(
  action: (client: PoolClient) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await action(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function assertScope(
  c: Queryable,
  org: string,
  table: string,
  id: string | null | undefined,
) {
  if (
    id &&
    !(
      await c.query(
        `SELECT id FROM ${table} WHERE id=$1 AND organization_id=$2`,
        [id, org],
      )
    ).rowCount
  )
    throw Error("Usage attribution is outside this organization");
}
/** Immutable measurements. eventKey identifies a provider operation; attemptId distinguishes paid retries. */
export async function recordUsage(
  input: UsageInput,
  client?: Queryable,
): Promise<any> {
  const b = usageSchema.parse(input);
  if (b.actualCostMicros !== undefined && b.estimatedCostMicros !== undefined)
    throw Error("Supply actual cost or estimated cost, not both");
  if (!client) return ledgerTransaction((c) => recordUsage(input, c));
  const c = client;
  await assertScope(c, b.organizationId, "platform_product", b.productId);
  await assertScope(c, b.organizationId, "platform_campaign", b.campaignId);
  if (b.campaignId) {
    const campaign = (
      await c.query(
        "SELECT product_id FROM platform_campaign WHERE id=$1 AND organization_id=$2",
        [b.campaignId, b.organizationId],
      )
    ).rows[0];
    if (
      b.productId &&
      campaign.product_id &&
      b.productId !== campaign.product_id
    )
      throw Error("Campaign and product attribution disagree");
    b.productId ??= campaign.product_id;
  }
  if (b.buildId) {
    const build = (
      await c.query(
        "SELECT product_id FROM code_build WHERE id=$1 AND organization_id=$2",
        [b.buildId, b.organizationId],
      )
    ).rows[0];
    if (
      !build ||
      (b.productId && build.product_id && b.productId !== build.product_id)
    )
      throw Error("Build attribution is outside this product or organization");
    b.productId ??= build.product_id;
  }
  if (
    b.runId &&
    !(
      await c.query(
        "SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=$1 AND coalesce(r.customer_organization_id,t.organization_id)=$2",
        [b.runId, b.organizationId],
      )
    ).rowCount
  )
    throw Error("Run attribution is outside this organization");
  const hash = canonicalUsageHash(b);
  const measuredAt = b.measuredAt ?? new Date().toISOString();
  const rate =
    b.actualCostMicros === undefined && b.estimatedCostMicros === undefined
      ? (
          await c.query(
            "SELECT * FROM usage_rate WHERE organization_id=$1 AND provider=$2 AND category=$3 AND unit=$4 AND currency=$5 AND effective_at<=$6 ORDER BY effective_at DESC LIMIT 1",
            [
              b.organizationId,
              b.provider,
              b.category,
              b.unit,
              b.currency,
              measuredAt,
            ],
          )
        ).rows[0]
      : null;
  const cost =
    b.actualCostMicros ??
    b.estimatedCostMicros ??
    (rate
      ? priceUnits(b.units, Number(rate.amount_micros), Number(rate.per_units))
      : null);
  const status =
    b.actualCostMicros !== undefined
      ? "actual"
      : b.estimatedCostMicros !== undefined || rate
        ? "estimated"
        : "unpriced";
  const inserted = await c.query(
    `INSERT INTO usage_event(organization_id,product_id,campaign_id,run_id,build_id,provider,category,event_key,attempt_id,payload_hash,units,unit,measured_at,cost_micros,cost_status,currency,rate_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(organization_id,provider,event_key,attempt_id) DO NOTHING RETURNING *`,
    [
      b.organizationId,
      b.productId ?? null,
      b.campaignId ?? null,
      b.runId ?? null,
      b.buildId ?? null,
      b.provider,
      b.category,
      b.eventKey,
      b.attemptId,
      hash,
      b.units,
      b.unit,
      measuredAt,
      cost,
      status,
      b.currency,
      rate?.id ?? null,
      JSON.stringify(b.metadata),
    ],
  );
  if (inserted.rowCount) return { ...inserted.rows[0], duplicate: false };
  const existing = (
    await c.query(
      "SELECT * FROM usage_event WHERE organization_id=$1 AND provider=$2 AND event_key=$3 AND attempt_id=$4",
      [b.organizationId, b.provider, b.eventKey, b.attemptId],
    )
  ).rows[0];
  if (!existing || existing.payload_hash !== hash)
    throw Error("Usage event key was already recorded with different data");
  return { ...existing, duplicate: true };
}
export async function reconcileUsage(
  org: string,
  eventId: string,
  raw: unknown,
) {
  const b = z
    .object({
      reconciliationKey: z.string().min(1).max(240),
      actualCostMicros: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      source: z.string().trim().min(1).max(2000),
    })
    .parse(raw);
  return ledgerTransaction(async (c) => {
    if (
      !(
        await c.query(
          "SELECT id FROM usage_event WHERE id=$1 AND organization_id=$2",
          [eventId, org],
        )
      ).rowCount
    )
      throw Error("Usage event not found");
    const row = (
      await c.query(
        "INSERT INTO usage_reconciliation(organization_id,usage_event_id,reconciliation_key,actual_cost_micros,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,reconciliation_key) DO NOTHING RETURNING *",
        [org, eventId, b.reconciliationKey, b.actualCostMicros, b.source],
      )
    ).rows[0];
    if (row) return row;
    const old = (
      await c.query(
        "SELECT * FROM usage_reconciliation WHERE organization_id=$1 AND reconciliation_key=$2",
        [org, b.reconciliationKey],
      )
    ).rows[0];
    if (
      old.usage_event_id !== eventId ||
      Number(old.actual_cost_micros) !== b.actualCostMicros ||
      old.source !== b.source
    )
      throw Error("Reconciliation key already used");
    return old;
  });
}
export async function createRate(org: string, raw: unknown) {
  const b = rateSchema.parse(raw);
  return (
    await pool.query(
      "INSERT INTO usage_rate(organization_id,provider,category,unit,amount_micros,per_units,currency,effective_at,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        org,
        b.provider,
        b.category,
        b.unit,
        b.amountMicros,
        b.perUnits,
        b.currency,
        b.effectiveAt,
        b.source,
      ],
    )
  ).rows[0];
}
export function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw Error("Use a month in YYYY-MM format");
  const start = new Date(month + "-01T00:00:00.000Z"),
    end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  if (!Number.isFinite(start.getTime())) throw Error("Invalid month");
  return [start.toISOString(), end.toISOString()] as const;
}
export async function usageSummary(
  org: string,
  {
    productId,
    campaignId,
    month = new Date().toISOString().slice(0, 7),
  }: { productId?: string; campaignId?: string; month?: string } = {},
) {
  await assertScope(pool, org, "platform_product", productId);
  await assertScope(pool, org, "platform_campaign", campaignId);
  const [start, end] = monthRange(month);
  const filter =
    "u.organization_id=$1 AND ($2::uuid IS NULL OR u.product_id=$2) AND ($3::uuid IS NULL OR u.campaign_id=$3) AND u.measured_at>=$4 AND u.measured_at<$5";
  const from = `FROM usage_event u LEFT JOIN LATERAL(SELECT actual_cost_micros FROM usage_reconciliation WHERE usage_event_id=u.id ORDER BY created_at DESC,id DESC LIMIT 1) a ON true WHERE ${filter}`;
  const values = [org, productId ?? null, campaignId ?? null, start, end];
  const [groups, events, rates, budgets, terms] = await Promise.all([
    pool.query(
      `SELECT u.provider,u.category,u.unit,u.currency,sum(u.units)::text AS units,count(*)::int AS events,count(*) FILTER(WHERE coalesce(a.actual_cost_micros,u.cost_micros) IS NULL)::int AS unpriced_events,coalesce(sum(coalesce(a.actual_cost_micros,u.cost_micros)),0)::text AS cost_micros,count(*) FILTER(WHERE a.actual_cost_micros IS NULL AND u.cost_status='estimated')::int AS estimated_events ${from} GROUP BY u.provider,u.category,u.unit,u.currency ORDER BY u.category,u.provider`,
      values,
    ),
    pool.query(
      `SELECT u.*,coalesce(a.actual_cost_micros,u.cost_micros)::text AS effective_cost_micros,CASE WHEN a.actual_cost_micros IS NOT NULL THEN 'actual' ELSE u.cost_status END AS effective_cost_status ${from} ORDER BY u.measured_at DESC,u.id LIMIT 100`,
      values,
    ),
    pool.query(
      "SELECT * FROM usage_rate WHERE organization_id=$1 ORDER BY effective_at DESC,created_at DESC LIMIT 200",
      [org],
    ),
    pool.query(
      "SELECT * FROM organization_budget WHERE organization_id=$1 AND product_id IS NOT DISTINCT FROM $2::uuid AND month=$3",
      [org, productId ?? null, month],
    ),
    pool.query(
      "SELECT * FROM billing_terms WHERE organization_id=$1 AND product_id IS NOT DISTINCT FROM $2::uuid ORDER BY revision DESC LIMIT 1",
      [org, productId ?? null],
    ),
  ]);
  return {
    month,
    productId: productId ?? null,
    campaignId: campaignId ?? null,
    groups: groups.rows,
    events: events.rows,
    rates: rates.rows,
    budgets: budgets.rows,
    feeConfiguration: terms.rows[0] ?? null,
    accountingNotice:
      "Usage accrues here. No invoices or charges are created. Unpriced usage is not free. Hosted tool calls are observed calls, not provider-billed sessions.",
  };
}
export async function setBudget(org: string, raw: unknown) {
  const b = z
    .object({
      productId: z.uuid().nullable().optional(),
      month: z.string(),
      amountMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .default("USD"),
    })
    .parse(raw);
  monthRange(b.month);
  await assertScope(pool, org, "platform_product", b.productId);
  return (
    await pool.query(
      "INSERT INTO organization_budget(organization_id,product_id,month,amount_micros,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,(coalesce(product_id,'00000000-0000-0000-0000-000000000000'::uuid)),month,currency) DO UPDATE SET amount_micros=excluded.amount_micros RETURNING *",
      [org, b.productId ?? null, b.month, b.amountMicros, b.currency],
    )
  ).rows[0];
}
/** Future commercial terms are configuration only: no invoice, payment or collection path. */
export async function configureFees(org: string, raw: unknown) {
  const b = billingTermsSchema.parse(raw);
  return ledgerTransaction(async (c) => {
    await assertScope(c, org, "platform_product", b.productId);
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "fees:" + org + ":" + (b.productId ?? ""),
    ]);
    return (
      await c.query(
        "INSERT INTO billing_terms(organization_id,product_id,revision,effective_month,terms) SELECT $1,$2,coalesce(max(revision),0)+1,$3,$4 FROM billing_terms WHERE organization_id=$1 AND product_id IS NOT DISTINCT FROM $2::uuid RETURNING *",
        [org, b.productId ?? null, b.effectiveMonth, JSON.stringify(b)],
      )
    ).rows[0];
  });
}
