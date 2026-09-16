import { eq } from "drizzle-orm";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  skills,
  skillVersions,
} from "../packages/database/src";
import { seed, ids } from "./seed";
import type { AgentDecision } from "../packages/shared/src/session";
export const agentIds = {
  skill: "50000000-0000-4000-8000-000000000001",
  skillVersion: "50000000-0000-4000-8000-000000000002",
  workflow: "50000000-0000-4000-8000-000000000003",
  version: "50000000-0000-4000-8000-000000000004",
  liveWorkflow: "50000000-0000-4000-8000-000000000005",
  liveVersion: "50000000-0000-4000-8000-000000000006",
};
export const finalReport = {
  synthetic: true,
  reviewRequired: true,
  outreachAllowed: false,
  conclusions: [
    {
      statement: "Only synthetic evidence was examined.",
      source: "fixture://jordan-example",
      confidence: 0,
    },
  ],
};
export const agentDecisions: AgentDecision[] = [
  {
    action: "select_skill",
    target: agentIds.skillVersion,
    payload: JSON.stringify({ personName: "Jordan Example" }),
    summary: "Select the permitted research capability.",
  },
  {
    action: "fetch_knowledge",
    target: ids.knowledge,
    payload: "{}",
    summary: "Fetch the evidence policy into session context.",
  },
  {
    action: "call_tool",
    target: ids.tool,
    payload: JSON.stringify({ personName: "Jordan Example" }),
    summary: "Request synthetic property evidence.",
  },
  {
    action: "complete_skill",
    target: agentIds.skillVersion,
    payload: JSON.stringify(finalReport),
    summary: "Record the evidence-backed synthetic report.",
  },
  {
    action: "final",
    target: null,
    payload: JSON.stringify(finalReport),
    summary: "Return the completed report for human review.",
  },
];
export async function seedAgent() {
  await seed();
  await db.transaction(async (tx) => {
    await tx
      .insert(skills)
      .values({
        id: agentIds.skill,
        organizationId: ids.organization,
        name: "Research synthetic property evidence",
        slug: "agent-property-research",
        description:
          "Research a fictional property candidate, preserve evidence and uncertainty, and produce a report.",
      })
      .onConflictDoNothing();
    await tx
      .insert(skillVersions)
      .values({
        id: agentIds.skillVersion,
        skillId: agentIds.skill,
        version: 1,
        executionType: "agent",
        instructions:
          "First fetch the allowed evidence policy, then use the permitted property search tool to gather evidence about the synthetic candidate. Return a report with synthetic=true, reviewRequired=true, outreachAllowed=false, and a conclusions array. Clearly label all evidence as fictional. Never infer verified ownership.",
        inputSchema: {
          type: "object",
          required: ["personName"],
          properties: { personName: { type: "string" } },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: [
            "synthetic",
            "reviewRequired",
            "outreachAllowed",
            "conclusions",
          ],
          properties: {
            synthetic: { const: true },
            reviewRequired: { const: true },
            outreachAllowed: { const: false },
            conclusions: { type: "array" },
          },
        },
        configuration: {
          allowedKnowledgeIds: [ids.knowledge],
          allowedToolIds: [ids.tool],
          toolConfigurations: {
            [ids.tool]: {
              syntheticResults: {
                synthetic: true,
                properties: [
                  {
                    address: "123 Example Street",
                    owner: "Jordan Example",
                    ownershipVerified: false,
                    source: "fixture://jordan-example",
                  },
                ],
              },
            },
          },
        },
      })
      .onConflictDoNothing();
    for (const live of [false, true]) {
      const workflowId = live ? agentIds.liveWorkflow : agentIds.workflow,
        versionId = live ? agentIds.liveVersion : agentIds.version;
      const [existing] = await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, versionId));
      if (existing) continue;
      await tx
        .insert(workflows)
        .values({
          id: workflowId,
          organizationId: ids.organization,
          name: live
            ? "Agent Research — OpenAI"
            : "Agent Research — Offline SDK",
          slug: live ? "agent-research-openai" : "agent-research-mock",
        })
        .onConflictDoNothing();
      await tx
        .insert(workflowVersions)
        .values({
          id: versionId,
          workflowId,
          version: 1,
          goal: "Select the right skill and collect synthetic property evidence for a report",
          sopMarkdown:
            "Select the available research skill, use its tools to gather evidence, complete the skill, then return the final report. All data is fictional. Never conduct outreach.",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            required: [
              "synthetic",
              "reviewRequired",
              "outreachAllowed",
              "conclusions",
            ],
            properties: {
              synthetic: { const: true },
              reviewRequired: { const: true },
              outreachAllowed: { const: false },
              conclusions: { type: "array" },
            },
          },
          createdBy: "agent-seed",
        });
      await tx
        .insert(workflowSteps)
        .values({
          workflowVersionId: versionId,
          key: "agent_research",
          name: "Model-selected research",
          position: 0,
          type: "agent_loop",
          configuration: {
            provider: live ? "openai" : "mock",
            model: "gpt-4.1-mini",
            skillVersionIds: [agentIds.skillVersion],
            maxTurns: 12,
            maxToolCalls: 4,
            maxSkillSelections: 2,
            allowHumanReview: false,
            mockDecisions:
              agentDecisions as unknown as import("../packages/shared/src").Json,
          },
        });
      await tx
        .update(workflows)
        .set({ currentVersionId: versionId })
        .where(eq(workflows.id, workflowId));
    }
  });
  console.log(
    "Agent demo workflows seeded: agent-research-mock and agent-research-openai",
  );
}
if (require.main === module)
  seedAgent()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
