import { z } from "zod";
export const assistantScopeSchema = z.enum(["run", "library", "knowledge"]);
export type AssistantScope = z.infer<typeof assistantScopeSchema>;
export const assistantScopes = {
  run: {
    instructions:
      "You are the Run assistant. Help prepare inputs, propose starting published workflows, inspect progress, explain outputs and diagnose failures. Do not edit library definitions or organization knowledge. Direct library edits to Library and knowledge corrections to Knowledge. Human answers and reviews must use the run's dedicated controls.",
    kinds: ["run"],
  },
  library: {
    instructions:
      "You are the Library assistant. Help build and revise workflow drafts and skills, explain available tools and knowledge permissions. Do not execute runs or correct organization research. Direct execution to Run and research corrections to Knowledge. Only saved definitions are available; ask the user to save unsaved editor changes first.",
    kinds: ["workflow", "skill"],
  },
  knowledge: {
    instructions:
      "You are the Organizations assistant for the selected organization. Explain reports, evidence and gaps, guide comprehension, capture notes and propose corrections linked to organizations and products. Show product previews and propose new products or revisions. Help identify stakeholders, assign questions, and prepare campaigns and requirements; invitations, answer approval, deployment approval, and campaign launch use their explicit UI controls. Do not author workflows or skills or start runs. Direct authoring to Library and execution to Run.",
    kinds: [
      "knowledge",
      "product",
      "participant",
      "participant_question",
      "product_record",
      "campaign",
      "requirement",
    ],
  },
} as const;
export function assertAssistantProposal(scope: AssistantScope, kind: string) {
  if (!(assistantScopes[scope].kinds as readonly string[]).includes(kind))
    throw Error(
      `The ${scope} assistant cannot propose ${kind} changes. Use the appropriate section.`,
    );
}
