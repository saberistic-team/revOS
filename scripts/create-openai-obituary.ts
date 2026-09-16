// Create a separate live-model edition of the original seeded workflow via authoring APIs.
import { writeFileSync } from "node:fs";
const base = process.env.API_URL ?? "http://localhost:3000";
async function api(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(JSON.stringify(d));
  return d;
}
async function main() {
  const name = "Obituary Property Lead Research — OpenAI";
  const list = await api("/workflows");
  const existing = list.find((w: any) => w.name === name);
  if (existing) {
    console.log(
      JSON.stringify({ workflowId: existing.id, alreadyExists: true }),
    );
    return;
  }
  const original = list.find(
    (w: any) => w.slug === "obituary-property-lead-research",
  );
  if (!original) throw Error("Seed the original workflow first");
  const source = await api("/workflows/" + original.id);
  const catalog = await api("/builder/catalog");
  const copy = await api("/builder/workflows", {
    organizationId: original.organizationId,
    name,
    duplicateId: original.id,
  });
  const d = copy.draft.definition;
  d.name = name;
  d.description =
    "OpenAI reasoning across the original five research stages. Property search uses synthetic fixtures; no live records or outreach.";
  const policyId = "10000000-0000-4000-8000-000000000006";
  const labels: Record<string, string> = {
    extract_obituary: "Extract obituary information",
    resolve_identity: "Resolve candidate identity",
    find_property: "Find candidate properties",
    research_property: "Research candidate properties",
    qualify_lead: "Produce the research report",
  };
  const steps = [];
  for (const step of source.steps) {
    const old = catalog.skills.find((s: any) => s.id === step.skillVersionId);
    if (!old) throw Error("Original skill missing");
    const toolId = old.configuration.toolId;
    const configuration: any = {
      allowedToolIds: toolId ? [toolId] : [],
      allowedKnowledgeIds: [policyId],
    };
    if (toolId) {
      const { toolId: _, mockResponse: __, ...trusted } = old.configuration;
      configuration.toolConfigurations = { [toolId]: trusted };
    }
    const outputSchema =
      step.key === "qualify_lead"
        ? {
            ...source.version.outputSchema,
            required: [
              ...source.version.outputSchema.required,
              "outreachAllowed",
            ],
            properties: {
              ...source.version.outputSchema.properties,
              outreachAllowed: { const: false },
            },
          }
        : toolId
          ? catalog.tools.find((t: any) => t.id === toolId).outputSchema
          : old.outputSchema;
    const instructions =
      old.instructions +
      "\nWork only on this stage. Fetch the allowed evidence policy before completing it. Use only the provided input and recorded tool results. Keep source provenance and uncertainty. This edition uses synthetic property data: never present it as verified ownership or a real lead. Return the stage output as JSON; do not request human review in this session. The final report flags downstream review." +
      (toolId
        ? "\nYou must request the permitted property-search tool with the candidate information as arguments. Wait for its recorded result. Return that result, including its synthetic flag and properties; do not fabricate search results."
        : "") +
      (step.key === "qualify_lead"
        ? "\nReturn synthetic=true, reviewRequired=true, outreachAllowed=false, and evidence-backed conclusions. No outreach occurs in this workflow."
        : "");
    const skill = await api("/builder/skills", {
      organizationId: original.organizationId,
      name: (labels[step.key] || old.name) + " — OpenAI",
      description: "Live-model edition of " + old.name,
      instructions,
      inputSchema: old.inputSchema,
      outputSchema,
      configuration,
    });
    steps.push({
      key: step.key,
      name: labels[step.key] || step.name,
      type: "skill",
      skillVersionId: skill.id,
      configuration: {
        ...step.configuration,
        provider: "openai",
        model: "gpt-4.1-mini",
        goal: labels[step.key] || step.name,
        outputSchema,
        maxTurns: 8,
        maxToolCalls: 2,
        maxSkillSelections: 1,
        allowHumanReview: false,
      },
    });
  }
  d.steps = steps;
  const saved = await api(
    "/builder/workflows/" + copy.workflow.id,
    { revision: copy.draft.revision, definition: d },
    "PUT",
  );
  await api("/builder/workflows/" + copy.workflow.id + "/validate", {
    revision: saved.draft.revision,
  });
  const published = await api(
    "/builder/workflows/" + copy.workflow.id + "/publish",
    { revision: saved.draft.revision },
  );
  const run = await api("/workflows/" + copy.workflow.id + "/runs", {
    input: {
      obituaryText:
        "SYNTHETIC TEST ONLY: Jordan Example of Example County died January 1, 2026. Survived by spouse Taylor Example. This is fictional test data, not a public obituary.",
    },
  });
  const result = {
    workflowId: copy.workflow.id,
    version: published.version,
    runId: run.id,
  };
  writeFileSync("/tmp/openai-obituary-created.json", JSON.stringify(result));
  console.log(JSON.stringify(result));
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const current = await api("/runs/" + run.id);
    if (current.status === "failed") throw Error(current.error);
    if (current.status === "completed") {
      const sessions = await api("/runs/" + run.id + "/sessions");
      let toolCalls = 0;
      for (const s of sessions) {
        const detail = await api("/sessions/" + s.id);
        toolCalls += detail.turns.filter(
          (t: any) => t.decision.action === "call_tool" && t.outcome,
        ).length;
      }
      if (sessions.length !== 5 || toolCalls < 1)
        throw Error(
          "Expected five live sessions and a recorded property-search tool call",
        );
      console.log(
        JSON.stringify({
          status: current.status,
          sessions: sessions.length,
          toolCalls,
          output: current.output,
        }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error(
    "Live run exceeded observation window; inspect its persisted run for status.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
