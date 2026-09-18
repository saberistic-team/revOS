import { z } from "zod";

export const dnsName = z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const sourceCommit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const immutableImage = z.string().min(20).max(500).regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/);
const command = z.array(z.string().min(1).max(500)).min(1).max(20);
export const codingBudgetSchema = z.object({
  chunkTurns: z.number().int().min(10).max(1000).default(200),
  totalTurns: z.number().int().min(10).max(10000).default(2000),
  maxSeconds: z.number().int().min(60).max(86400).default(21600),
  maxCostUsd: z.number().positive().max(10000).optional(),
  maxStalledChunks: z.number().int().min(1).max(5).default(2),
}).strict().refine(x => x.totalTurns >= x.chunkTurns, "Total turn budget must cover one checkpoint interval");
export type CodingBudget = z.infer<typeof codingBudgetSchema>;

export const serviceConfigSchema = z.object({
  provider: z.enum(["argocd", "external_gitops"]).default("argocd"),
  executor: z.enum(["openhands", "kelos"]).default("openhands"),
  port: z.number().int().min(1024).max(65535).default(8080),
  healthPath: z.string().max(200).regex(/^\/[A-Za-z0-9_./-]*$/).default("/health"),
  previewHost: z.string().max(253).regex(/^[a-z0-9.-]+$/),
  liveHost: z.string().max(253).regex(/^[a-z0-9.-]+$/).optional(),
  ingressClass: dnsName.default("revos-products"),
  publicPort: z.number().int().min(1).max(65535).optional(),
  tlsSecretName: dnsName.optional(),
  imagePullSecret: dnsName.optional(),
  // Only names of existing namespace-local secrets, never values.
  secretRefs: z.array(z.object({ env: z.string().regex(/^[A-Z][A-Z0-9_]*$/), secret: dnsName, key: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).max(30).default([]),
  database: z.object({ secret: dnsName, key: z.string().regex(/^[A-Za-z0-9_.-]+$/).default("DATABASE_URL") }).strict().optional(),
  migrationCommand: command.optional(),
  testCommand: command.default(["python", "-m", "unittest", "discover", "-s", "tests"]),
  cpu: z.string().regex(/^(?:[1-9][0-9]*m|[1-9][0-9]*)$/).default("500m"),
  memory: z.string().regex(/^[1-9][0-9]*(Mi|Gi)$/).default("512Mi"),
  replicas: z.number().int().min(1).max(5).default(1),
  budget: codingBudgetSchema.default(codingBudgetSchema.parse({})),
}).strict().refine(x => !x.migrationCommand || !!x.database, "A migration command requires a database secret reference");
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export const serviceBuildSchema = z.object({ brief: z.string().trim().min(1).max(12000), requestId: z.uuid(), parentBuildId: z.uuid().optional() }).strict();
export const releaseRequestSchema = z.object({ buildId: z.uuid(), environment: z.enum(["preview", "live"]), requestId: z.uuid() }).strict();
export const releaseReportSchema = z.object({ sourceCommit, image: immutableImage, testsPassed: z.literal(true) }).strict();
export function releaseNamespace(productId: string, environment: "preview" | "live") {
  return `product-${z.uuid().parse(productId)}-${environment}`;
}

export type ServiceReleaseStatus = {
  serviceReleaseId: string; productId: string; organizationId: string;
  state: string; environment: "preview" | "live"; url?: string; error?: string;
};
