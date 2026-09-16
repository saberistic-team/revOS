import { z } from "zod";
const contract = z.record(z.string(), z.unknown());
export const draftSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).default(""),
  agentId: z.uuid(),
  goal: z.string().max(12000),
  instructions: z.string().max(30000),
  inputSchema: contract,
  outputSchema: contract,
  steps: z
    .array(
      z.object({
        key: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .max(60),
        name: z.string().trim().min(1).max(160),
        type: z.enum(["agent_loop", "skill", "human_review"]),
        skillVersionId: z.uuid().nullable().default(null),
        configuration: z.record(z.string(), z.any()).default({}),
      }),
    )
    .max(30),
});
export type WorkflowDraft = z.infer<typeof draftSchema>;
