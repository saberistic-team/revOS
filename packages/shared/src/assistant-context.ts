import { z } from "zod";
export const assistantContextSchema = z.object({
  kind: z
    .enum([
      "organization",
      "document",
      "product",
      "campaign",
      "concept",
      "workflow",
      "chain",
      "skill",
      "tool",
      "knowledge",
      "run",
      "engagement",
      "step",
      "build",
      "review",
    ])
    .optional(),
  id: z.string().max(160).optional(),
  label: z.string().max(400).optional(),
  workflowId: z.uuid().nullish(),
  runId: z.uuid().nullish(),
  engagementId: z.uuid().nullish(),
  attemptId: z.uuid().nullish(),
  buildId: z.uuid().nullish(),
  documentId: z.uuid().nullish(),
  productId: z.uuid().nullish(),
  campaignId: z.uuid().nullish(),
  chainId: z.uuid().nullish(),
  skillVersionId: z.uuid().nullish(),
  toolId: z.uuid().nullish(),
  knowledgeId: z.uuid().nullish(),
  conceptId: z.string().max(160).nullish(),
  workflowStepId: z.string().max(160).nullish(),
  stageIndex: z.number().int().min(0).max(100).optional(),
  version: z.union([z.string().max(160), z.number()]).nullish(),
  draftRevision: z.number().int().positive().optional(),
  unsaved: z.boolean().optional(),
});
export type AssistantContext = z.infer<typeof assistantContextSchema>;
export function assertContextScope(scope: string, c: AssistantContext) {
  if (c.kind === "campaign" && !c.campaignId)
    throw Error("Select a saved campaign.");
  if (c.campaignId && (c.documentId || c.conceptId))
    throw Error("Choose one primary item: a campaign, document or concept.");
  if (c.documentId && c.productId)
    throw Error("Choose one primary item: a document or a product.");
  if (
    scope !== "knowledge" &&
    (c.documentId || c.productId || c.conceptId || c.campaignId)
  )
    throw Error("This selection belongs in Organizations.");
  if (
    scope !== "library" &&
    (c.chainId || c.skillVersionId || c.toolId || c.knowledgeId)
  )
    throw Error("This selection belongs in Library.");
  if (scope !== "run" && (c.runId || c.engagementId || c.attemptId))
    throw Error("This selection belongs in Run.");
  if (scope === "knowledge" && (c.workflowId || c.workflowStepId))
    throw Error("Workflow selection belongs in Run or Library.");
}
