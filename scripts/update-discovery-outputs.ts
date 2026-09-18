// Publish a new version through the authoring API; historical runs remain pinned.
import { writeFileSync } from "node:fs";
const base = process.env.API_URL || "http://localhost:3000";
async function api(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  if (!r.ok) throw Error(JSON.stringify(v));
  return v;
}
function presentation(name: string) {
  return /prioriti|opportunit|offer/.test(name)
    ? "cards"
    : /source|market_participant|compensation|revenue_stream/.test(name)
      ? "table"
      : "report";
}
async function main() {
  const workflowId = process.argv[2];
  if (!workflowId)
    throw Error("Supply the Customer Opportunity Discovery workflow ID");
  const current = await api("/builder/workflows/" + workflowId);
  if (current.workflow.name !== "Customer Opportunity Discovery")
    throw Error("Unexpected workflow");
  const catalog = await api("/builder/catalog");
  const definition = structuredClone(current.draft.definition);
  const map = new Map<string, string>();
  for (const step of definition.steps) {
    for (const id of step.configuration.skillVersionIds ||
      (step.skillVersionId ? [step.skillVersionId] : [])) {
      if (map.has(id)) continue;
      const skill = catalog.skills.find((s: any) => s.id === id);
      if (!skill) throw Error("Missing pinned skill");
      const formats = /discover_lead_sources|prioritize_opportunities/.test(
        skill.name,
      )
        ? ["xlsx"]
        : ["pdf"];
      const outputs = {
        presentation: presentation(skill.name),
        artifacts: {
          mode: "always",
          formats,
          instructions:
            "Create a concise, readable deliverable for this completed skill. Preserve evidence, assumptions, and unanswered questions. Do not add research or invented metrics.",
        },
      };
      const existing = catalog.skills.find(
        (s: any) =>
          s.skillId === skill.skillId &&
          JSON.stringify(s.configuration.outputs) === JSON.stringify(outputs),
      );
      const created =
        existing ||
        (await api("/builder/skills", {
          organizationId: current.workflow.organizationId,
          skillId: skill.skillId,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          inputSchema: skill.inputSchema,
          outputSchema: skill.outputSchema,
          configuration: { ...skill.configuration, outputs },
        }));
      map.set(id, created.id);
    }
    if (step.configuration.skillVersionIds)
      step.configuration.skillVersionIds =
        step.configuration.skillVersionIds.map((id: string) => map.get(id));
    if (step.skillVersionId) step.skillVersionId = map.get(step.skillVersionId);
    step.configuration.outputs = {
      presentation:
        step.key === "design_compensation_model"
          ? "report"
          : presentation(step.key),
      artifacts: {
        mode: step.key === "design_compensation_model" ? "always" : "manual",
        formats:
          step.key === "design_compensation_model" ? ["pdf", "pptx"] : ["pdf"],
        instructions:
          "Produce the Customer Opportunity Brief with clear sections, supporting sources, explicit unknowns, and recommended next actions. Preserve the saved findings without new research.",
      },
    };
  }
  const saved = await api(
    "/builder/workflows/" + workflowId,
    { revision: current.draft.revision, definition },
    "PUT",
  );
  await api("/builder/workflows/" + workflowId + "/validate", {
    revision: saved.draft.revision,
  });
  const result = {
    workflowId,
    revision: saved.draft.revision,
    skillsUpdated: map.size,
    ...(process.argv.includes("--publish")
      ? await api("/builder/workflows/" + workflowId + "/publish", {
          revision: saved.draft.revision,
        })
      : {}),
  };
  writeFileSync(
    "/tmp/discovery-outputs-update.json",
    JSON.stringify(result, null, 2),
  );
  console.log(result);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
