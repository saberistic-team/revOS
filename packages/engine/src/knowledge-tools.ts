import type { Json } from "../../shared/src";
import { z } from "zod";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import {
  db,
  kbDocuments,
  reasoningSessions,
  runs,
  tasks,
} from "../../database/src";
import { ToolRegistry } from "./index";
import { createChange } from "./workspace-service";
export const knowledgeToolDefinitions: {
  name: string;
  slug: string;
  handler: string;
  description: string;
  inputSchema: Json;
  outputSchema: Json;
}[] = [
  {
    name: "Search organization knowledge",
    slug: "organization-knowledge-search",
    handler: "knowledge.search",
    description:
      "Search the current organization’s Forgejo-backed knowledge index. Returns evidence labels, source references and revisions. Executes in a Temporal activity.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        documentId: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["documents"],
      properties: { documents: { type: "array" } },
    },
  },
  {
    name: "Propose knowledge correction",
    slug: "organization-knowledge-propose",
    handler: "knowledge.propose",
    description:
      "Capture a new knowledge note or propose a correction for human review. Never commits or confirms findings automatically.",
    inputSchema: {
      type: "object",
      required: ["title", "content", "reason"],
      additionalProperties: false,
      properties: {
        documentId: { type: "string" },
        baseRevision: { type: "integer" },
        title: { type: "string", maxLength: 200 },
        content: { type: "string", maxLength: 180000 },
        reason: { type: "string", maxLength: 12000 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["changeId", "state"],
      properties: { changeId: { type: "string" }, state: { type: "string" } },
    },
  },
];
async function orgForContext(key?: string) {
  const id = z.uuid().parse(key?.split(":")[0]);
  const [row] = await db
    .select({
      org: sql<string>`coalesce(${runs.customerOrganizationId}, ${tasks.organizationId})`,
    })
    .from(reasoningSessions)
    .innerJoin(runs, eq(runs.id, reasoningSessions.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(reasoningSessions.id, id));
  if (!row)
    throw Error(
      "Organization knowledge tools require a durable reasoning session",
    );
  return row.org;
}
export function registerKnowledgeTools(registry: ToolRegistry) {
  registry.register(
    "knowledge.search",
    async (input, _c, ctx) => {
      const org = await orgForContext(ctx?.idempotencyKey);
      const b = z
        .object({
          query: z.string().min(1).max(300),
          documentId: z.uuid().optional(),
        })
        .parse(input);
      const rows = await db
        .select()
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.organizationId, org),
            b.documentId
              ? eq(kbDocuments.id, b.documentId)
              : or(
                  ilike(kbDocuments.title, "%" + b.query + "%"),
                  ilike(kbDocuments.content, "%" + b.query + "%"),
                ),
          ),
        )
        .limit(10);
      return {
        documents: rows.map((d) => ({
          id: d.id,
          title: d.title,
          content: d.content.slice(0, b.documentId ? 100000 : 5000),
          excerpt: d.content.length > (b.documentId ? 100000 : 5000),
          evidence: d.evidence,
          revision: d.revision,
          provenance: d.provenance,
        })),
      };
    },
    { retrySafe: true },
  );
  registry.register(
    "knowledge.propose",
    async (input, _c, ctx) => {
      const org = await orgForContext(ctx?.idempotencyKey);
      const b = z
        .object({
          documentId: z.uuid().optional(),
          baseRevision: z.number().int().positive().optional(),
          title: z.string(),
          content: z.string(),
          reason: z.string(),
        })
        .parse(input);
      if (b.documentId && !b.baseRevision)
        throw Error(
          "Read the document and supply its baseRevision before proposing a correction",
        );
      const [old] = b.documentId
        ? await db
            .select()
            .from(kbDocuments)
            .where(
              and(
                eq(kbDocuments.id, b.documentId),
                eq(kbDocuments.organizationId, org),
              ),
            )
        : [];
      const c = await createChange({
        organizationId: org,
        kind: "knowledge",
        targetId: b.documentId,
        baseRevision: b.baseRevision ?? 0,
        title: b.title,
        reason: b.reason,
        body: {
          title: b.title,
          content: b.content,
          category: old?.category ?? "notes",
          evidence: "unverified",
          relatedIds: old?.relatedIds ?? [],
        },
        provenance: { sessionTurn: ctx!.idempotencyKey },
        sourceKey: "knowledge-tool:" + ctx!.idempotencyKey,
      });
      return { changeId: c.id, state: c.state };
    },
    { retrySafe: true },
  );
}
