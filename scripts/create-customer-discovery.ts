// Business configuration is authored through the same API as the builder.
// Deliberately does not publish or approve the final human review.
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync("config/customer-opportunity-discovery.json", "utf8"),
);
const base = process.env.API_URL || "http://localhost:3000";
async function api(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const response = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}
async function main() {
  const catalog = await api("/builder/catalog");
  const organization =
    catalog.organizations.find((o: any) => o.name === "revOS") ??
    (await api("/builder/organizations", { name: "revOS" }));
  const agent =
    catalog.agents.find(
      (a: any) =>
        a.name === config.agentName && a.organizationId === organization.id,
    ) ??
    (await api("/builder/agents", {
      organizationId: organization.id,
      name: config.agentName,
      instructions: config.agentInstructions,
      description:
        "Commercial discovery, qualification, opportunity prioritization, and measurable offers across industries.",
    }));
  const tool = await api("/builder/tools/enable", {
    slug: "openai-web-research",
  });
  const knowledgeIds: string[] = [];
  for (const k of config.knowledge) {
    const existing = catalog.knowledge.find(
      (x: any) => x.name === k.name && x.organizationId === organization.id,
    );
    const item =
      existing ??
      (await api("/builder/knowledge", {
        organizationId: organization.id,
        ...k,
      }));
    knowledgeIds.push(item.id);
  }
  const ids: Record<string, string> = {};
  for (const s of config.skills) {
    const existing = catalog.skills.find(
      (x: any) => x.name === s.name && x.organizationId === organization.id,
    );
    const skill =
      (existing?.configuration.requiredKnowledgeIds &&
      JSON.stringify(existing.configuration.outputs) ===
        JSON.stringify(s.outputs)
        ? existing
        : undefined) ??
      (await api("/builder/skills", {
        ...(existing ? { skillId: existing.skillId } : {}),
        organizationId: organization.id,
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        inputSchema: { type: "object" },
        outputSchema: { type: "object", minProperties: 1 },
        configuration: {
          outputs: s.outputs,
          allowedToolIds: s.research ? [tool.id] : [],
          allowedKnowledgeIds: knowledgeIds,
          requiredKnowledgeIds: knowledgeIds,
          requiredToolIds: s.research ? [tool.id] : [],
        },
      }));
    ids[s.name] = skill.id;
  }
  const workflows = await api("/workflows");
  const existing = workflows.find((w: any) => w.name === config.name);
  if (existing)
    throw Error(
      `Workflow already exists (${existing.id}); inspect and update its draft instead of duplicating it.`,
    );
  const created = await api("/builder/workflows", {
    organizationId: organization.id,
    name: config.name,
  });
  const definition = {
    name: config.name,
    description:
      "Reusable commercial discovery: customer economics, ideal leads, WATCH conditions, cited market research, prioritized opportunities, measurable offers, and human approval.",
    agentId: agent.id,
    goal: config.goal,
    instructions: config.instructions,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    steps: [
      ...config.steps.map((s: any, index: number) => ({
        key: s.key,
        name: s.name,
        type: "agent_loop",
        skillVersionId: null,
        configuration: {
          captureKnowledge: index === 0 && config.captureKnowledge === true,
          outputs: s.outputs,
          inputFrom: "context",
          provider: "openai",
          model: "gpt-4.1",
          goal: s.goal,
          skillVersionIds: s.skills.map((n: string) => ids[n]),
          outputSchema: s.final ? config.outputSchema : s.outputSchema,
          maxTurns: 16,
          maxToolCalls: 2,
          maxSkillSelections: s.skills.length,
          maxOutputTokens: 6000,
          maxContextBytes: 500000,
          allowHumanReview: false,
          allowHumanQuestions: true,
        },
      })),
      {
        key: "human_review",
        name: "Review Customer Opportunity Brief",
        type: "human_review",
        skillVersionId: null,
        configuration: {
          inputFrom: "previous",
          outputMode: "input",
          instructions:
            "Review assumptions, opportunity ranking, qualification and WATCH criteria, offer, and compensation. Approve only if sufficient to move into deeper research or execution.",
        },
      },
    ],
  };
  const saved = await api(
    `/builder/workflows/${created.workflow.id}`,
    { revision: created.draft.revision, definition },
    "PUT",
  );
  await api(`/builder/workflows/${created.workflow.id}/validate`, {
    revision: saved.draft.revision,
  });
  const tested = await api(`/builder/workflows/${created.workflow.id}/test`, {
    revision: saved.draft.revision,
    input: config.testInput,
  });
  const result = {
    workflowId: created.workflow.id,
    revision: saved.draft.revision,
    runId: tested.run.id,
  };
  writeFileSync(
    "/tmp/customer-discovery-created.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
