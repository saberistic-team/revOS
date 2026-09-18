import { z } from "zod";
export const knowledgeBodySchema = z.object({
  productId: z.uuid().nullable().optional(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/, "Title must be a single line"),
  category: z.enum([
    "business",
    "research",
    "leads",
    "opportunities",
    "decisions",
    "questions",
    "notes",
  ]),
  content: z.string().trim().min(1).max(180000),
  evidence: z.enum([
    "researched",
    "inferred",
    "customer_confirmed",
    "unverified",
  ]),
  relatedIds: z.array(z.uuid()).max(30).default([]),
});
export const skillBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000),
  instructions: z.string().trim().min(1).max(30000),
  inputSchema: z.record(z.string(), z.any()),
  outputSchema: z.record(z.string(), z.any()),
  configuration: z.record(z.string(), z.any()),
});
export const assistantOutputSchema = z.object({
  explanation: z.string(),
  questions: z.array(z.string()),
  citations: z.array(z.string()),
  proposals: z.array(
    z.object({
      kind: z.enum([
        "knowledge",
        "workflow",
        "skill",
        "run",
        "product",
        "participant",
        "participant_question",
        "product_record",
        "campaign",
        "requirement",
      ]),
      targetId: z.string().nullable(),
      title: z.string(),
      reason: z.string(),
      bodyJson: z.string(),
    }),
  ),
});
export interface WorkspaceActivities {
  prepareRunKnowledgeJob(runId: string): Promise<string>;
  executeWorkspaceJob(id: string): Promise<void>;
  failWorkspaceJob(input: { id: string; error: string }): Promise<void>;
}
export function knowledgeMarkdown(doc: {
  id: string;
  title: string;
  category: string;
  evidence: string;
  content: string;
  relatedIds: string[];
  provenance: unknown;
  revision: number;
}) {
  const { content, ...meta } = doc;
  return `<!-- revos:${JSON.stringify(meta).replace(/</g, "\\u003c")} -->\n# ${doc.title}\n\nEvidence: **${doc.evidence}** · Category: ${doc.category} · Revision: ${doc.revision}\n\n${content}\n`;
}
export function resultMarkdown(value: unknown, depth = 2): string {
  if (value === null || value === undefined) return "Not provided";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value))
    return value
      .map((v, i) => `### Item ${i + 1}\n\n${resultMarkdown(v, depth + 1)}`)
      .join("\n\n");
  return Object.entries(value)
    .map(
      ([k, v]) =>
        `${"#".repeat(Math.min(depth, 6))} ${k.replace(/_/g, " ")}\n\n${resultMarkdown(v, depth + 1)}`,
    )
    .join("\n\n");
}
