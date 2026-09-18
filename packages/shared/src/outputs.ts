import { z } from "zod";
export const outputSettingsSchema = z.object({
  presentation: z
    .enum(["auto", "report", "cards", "table", "diagram"])
    .default("auto"),
  artifacts: z
    .object({
      mode: z.enum(["manual", "always", "model"]).default("manual"),
      formats: z
        .array(z.enum(["pdf", "xlsx", "pptx", "png"]))
        .max(4)
        .default([]),
      instructions: z.string().max(6000).default(""),
    })
    .default({ mode: "manual", formats: [], instructions: "" }),
});
export type OutputSettings = z.infer<typeof outputSettingsSchema>;
export type ArtifactFormat = OutputSettings["artifacts"]["formats"][number];
export interface OutputSource {
  runId: string;
  workflowStepId: string;
  sessionId?: string;
  turn?: number;
  fixedSkill?: boolean;
}
export interface ArtifactWorkflowInput {
  source: OutputSource;
  // Only explicit UI requests supply an override; automatic generation uses pinned settings.
  settings?: OutputSettings;
  manual?: boolean;
}
export interface ArtifactActivities {
  prepareArtifact(input: ArtifactWorkflowInput): Promise<string | null>;
  generateArtifact(jobId: string): Promise<void>;
  failArtifact(args: { jobId: string; error: string }): Promise<void>;
}

// Canonical JSON keeps cache keys stable across database JSONB and request key order.
export function stableOutputJson(value: unknown): string {
  function normalize(v: any): any {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => [k, normalize(v[k])]),
      );
    return v;
  }
  return JSON.stringify(normalize(value));
}
