import { z } from "zod";

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalId = z.uuid().nullable().optional();
export const productSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(10000).default(""),
  ownerPersonId: optionalId,
  repositoryUrl: z
    .string()
    .trim()
    .max(2000)
    .default("")
    .refine(
      (v) => !v || /^https?:\/\//.test(v),
      "Use an HTTP or HTTPS repository URL",
    ),
  runtimeKind: z.enum(["static", "service"]).default("static"),
});
export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(10000),
  productId: optionalId,
  ownerPersonId: optionalId,
  stakeholderIds: z.array(z.uuid()).max(100).default([]),
  successMeasure: z.string().trim().max(4000).default(""),
  budgetMicros: money.nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
});
export const requirementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20000),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(2000))
    .min(1)
    .max(50),
  evidence: z
    .array(
      z.object({
        kind: z.enum(["document", "answer", "run", "url", "note"]),
        reference: z.string().trim().min(1).max(2000),
        label: z.string().trim().max(240).default(""),
      }),
    )
    .max(100)
    .default([]),
  author: z.string().trim().min(1).max(160).default("operator"),
});
export const requirementDecisionSchema = z.object({
  revision: z.number().int().positive(),
  action: z.enum(["approve", "request_changes", "reject"]),
  actor: z.string().trim().min(1).max(160),
  feedback: z.string().trim().max(10000).default(""),
});
export const usageSchema = z.object({
  organizationId: z.uuid(),
  productId: optionalId,
  campaignId: optionalId,
  runId: optionalId,
  buildId: optionalId,
  provider: z.string().trim().min(1).max(80),
  category: z.enum([
    "llm",
    "llm_input",
    "llm_cached_input",
    "llm_output",
    "hosted_tools",
    "api",
    "compute",
    "storage",
    "network",
    "database",
    "temporal",
    "forgejo",
  ]),
  eventKey: z.string().trim().min(1).max(240),
  attemptId: z.string().max(160).default(""),
  units: z
    .number()
    .finite()
    .nonnegative()
    .max(1e12)
    .refine(
      (v) => Number.isSafeInteger(Math.round(v * 1e6)),
      "Usage precision exceeds supported range",
    ),
  unit: z.string().trim().min(1).max(80),
  measuredAt: z.iso.datetime().optional(),
  actualCostMicros: money.optional(),
  estimatedCostMicros: money.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  metadata: z
    .record(z.string(), z.unknown())
    .default({})
    .refine(
      (v) => Buffer.byteLength(JSON.stringify(v), "utf8") <= 8192,
      "Usage metadata is too large",
    ),
});
export const rateSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  category: usageSchema.shape.category,
  unit: z.string().trim().min(1).max(80),
  amountMicros: money,
  perUnits: z.number().int().positive().max(1e12),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  effectiveAt: z.iso.datetime(),
  source: z.string().trim().min(1).max(2000),
});
export const billingTermsSchema = z
  .object({
    productId: optionalId,
    installationFeeMicros: money.nullable().default(null),
    installationMilestone: z
      .string()
      .trim()
      .max(500)
      .default("Customer acceptance"),
    monthlyFeeMicros: money.nullable().default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    effectiveMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    usagePricing: z
      .array(
        z.object({
          category: usageSchema.shape.category,
          unit: z.string().trim().min(1).max(80),
          amountMicros: money,
          perUnits: z.number().int().positive().max(1e12),
          includedUnits: z.number().finite().nonnegative().max(1e12).default(0),
        }),
      )
      .max(30)
      .default([]),
    notes: z.string().trim().max(4000).default(""),
  })
  .refine(
    (t) =>
      new Set(t.usagePricing.map((p) => p.category + ":" + p.unit)).size ===
      t.usagePricing.length,
    "Only one price per usage unit is allowed",
  );

/** Monetary arithmetic uses integers; round up only once per aggregated line. */
export function priceUnits(
  units: number,
  amountMicros: number,
  perUnits: number,
) {
  if (
    ![units, amountMicros, perUnits].every(Number.isFinite) ||
    units < 0 ||
    amountMicros < 0 ||
    perUnits <= 0 ||
    !Number.isSafeInteger(amountMicros) ||
    !Number.isSafeInteger(perUnits)
  )
    throw Error("Invalid price or units");
  const scaled = Math.round(units * 1e6);
  if (!Number.isSafeInteger(scaled)) throw Error("Usage amount is too large");
  const denominator = BigInt(perUnits) * 1000000n;
  const value =
    (BigInt(scaled) * BigInt(amountMicros) + denominator - 1n) / denominator;
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Cost exceeds supported amount");
  return Number(value);
}
