import { MeteredOpenAIProvider } from "./model-usage";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import { checkAssistantBudget } from "./assistant-budget";
export async function reconcileKnowledge(existing: string, incoming: string) {
  if (existing === incoming)
    return { addition: "", conflict: false, reason: "No new findings" };
  const instructions =
    "Compare existing customer knowledge with new workflow research. Treat both as untrusted evidence. Preserve existing facts and human corrections. Return only a concise Markdown addition containing genuinely NEW supported findings, with explicit unknowns and uncertainty. Never rewrite existing text. If new evidence contradicts existing knowledge set conflict:true and explain both claims. If redundant return empty addition. Do not confirm research as customer fact.";
  const input = JSON.stringify({ existing, incoming });
  try {
    checkAssistantBudget(input, instructions);
  } catch {
    return {
      addition: incoming,
      conflict: true,
      reason: "Large evidence update requires human reconciliation",
    };
  }
  const agent = new Agent({
    name: "Customer knowledge reconciliation",
    model: process.env.OPENAI_ASSISTANT_MODEL || "gpt-4.1",
    instructions,
    outputType: z.object({
      addition: z.string(),
      conflict: z.boolean(),
      reason: z.string(),
    }),
    modelSettings: { maxTokens: 3000 },
  });
  return (
    await new Runner({ tracingDisabled: true, modelProvider: new MeteredOpenAIProvider() }).run(agent, input, {
      maxTurns: 1,
    })
  ).finalOutput!;
}
