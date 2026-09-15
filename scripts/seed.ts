import { eq } from "drizzle-orm";
import {
  db,
  pool,
  organizations,
  agents,
  workflows,
  workflowVersions,
  workflowSteps,
  skills,
  skillVersions,
  tools,
  knowledge,
} from "../packages/database/src";
import type { Json } from "../packages/shared/src";
export const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  agent: "10000000-0000-4000-8000-000000000002",
  workflow: "10000000-0000-4000-8000-000000000003",
  version: "10000000-0000-4000-8000-000000000004",
  tool: "10000000-0000-4000-8000-000000000005",
  knowledge: "10000000-0000-4000-8000-000000000006",
};
export const syntheticInput = {
  obituaryText:
    "SYNTHETIC TEST FIXTURE. Jordan Example of Example County died on 2026-01-01. Spouse: Taylor Example. All people, dates, addresses, and evidence are fictional.",
};
export const sop = `# Obituary Property Lead Research

## Goal
Identify potentially relevant real-estate opportunities originating from
public obituary information and produce an evidence-backed research report
for human review.

## Input
One or more of:
- obituary URL
- obituary text
- person's name
- geographic location

## Process
1. Extract person information from the obituary.
2. Resolve the person's identity.
3. Find possible property ownership matches.
4. Research candidate properties.
5. Qualify the opportunity.
6. Produce an evidence-backed lead report.

## Rules
Never silently assume two people are the same person.
Distinguish:
- facts
- evidence
- inference
- uncertainty
Preserve source provenance.
Every important conclusion should have:
- source
- evidence
- confidence
Human review is required before downstream outreach.`;
const source = {
  source: "fixture://jordan-example",
  evidence: "Entirely synthetic Day 1 fixture; not a public record.",
  confidence: 0,
};
const objectSchema = { type: "object" };
export async function seed() {
  await db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({ id: ids.organization, name: "Moses Demo Organization" })
      .onConflictDoNothing();
    await tx
      .insert(agents)
      .values({
        id: ids.agent,
        organizationId: ids.organization,
        name: "Real Estate Lead Researcher",
        instructions:
          "Preserve provenance and distinguish facts from inference. Require human review before outreach.",
      })
      .onConflictDoNothing();
    await tx
      .insert(workflows)
      .values({
        id: ids.workflow,
        organizationId: ids.organization,
        name: "Obituary Property Lead Research",
        slug: "obituary-property-lead-research",
        description:
          "Synthetic demonstration of database-configured execution.",
      })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, ids.version));
    // Seed never edits a published version or silently changes existing fixtures.
    if (existing) return;
    await tx
      .insert(tools)
      .values({
        id: ids.tool,
        name: "Synthetic Property Search",
        slug: "property.search",
        handler: "property.search",
        inputSchema: objectSchema,
        outputSchema: { type: "object", required: ["synthetic", "properties"] },
      })
      .onConflictDoNothing();
    await tx
      .insert(knowledge)
      .values({
        id: ids.knowledge,
        organizationId: ids.organization,
        name: "Demo safety and evidence policy",
        type: "markdown",
        content:
          "All data is synthetic. No live research or outreach. Identity matches remain unverified.",
      })
      .onConflictDoNothing();
    await tx
      .insert(workflowVersions)
      .values({
        id: ids.version,
        workflowId: ids.workflow,
        version: 1,
        goal: "Find evidence-backed real estate leads from obituary information",
        sopMarkdown: sop,
        inputSchema: {
          type: "object",
          required: ["obituaryText"],
          properties: { obituaryText: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["synthetic", "reviewRequired", "conclusions"],
          properties: {
            synthetic: { const: true },
            reviewRequired: { const: true },
            conclusions: { type: "array" },
          },
        },
        createdBy: "seed",
      });
    const fixtures: {
      key: string;
      instructions: string;
      response: Json;
      tool?: boolean;
    }[] = [
      {
        key: "extract_obituary",
        instructions:
          "Extract full name, aliases, approximate location, death date, relatives, spouse, and geographic clues. Do not infer absent facts.",
        response: {
          synthetic: true,
          fullName: "Jordan Example",
          aliases: [],
          location: "Example County",
          dateOfDeath: "2026-01-01",
          spouse: "Taylor Example",
          relatives: ["Taylor Example"],
          geographicClues: ["Example County"],
          ...source,
        },
      },
      {
        key: "resolve_identity",
        instructions:
          "Resolve candidate identity cautiously. Do not silently merge people. Preserve uncertainty and sources.",
        response: {
          synthetic: true,
          candidate: "Jordan Example",
          identityVerified: false,
          uncertainty: "No independent source available",
          ...source,
        },
      },
      {
        key: "find_property",
        instructions:
          "Find possible property matches and retain source provenance.",
        tool: true,
        response: {
          synthetic: true,
          properties: [
            {
              address: "123 Example Street",
              county: "Example County",
              possibleOwner: "Jordan Example",
              ownershipVerified: false,
              ...source,
            },
          ],
        },
      },
      {
        key: "research_property",
        instructions:
          "Research candidate properties. Separate facts, inference, uncertainty, and evidence.",
        response: {
          synthetic: true,
          address: "123 Example Street",
          facts: [],
          inferences: ["A fictional candidate property exists in the fixture"],
          uncertainty: ["Ownership and identity are not verified"],
          ...source,
        },
      },
      {
        key: "qualify_lead",
        instructions:
          "Produce an evidence-backed research report. Include source, evidence, confidence, and uncertainty for each conclusion. Require human review before any outreach.",
        response: {
          synthetic: true,
          reviewRequired: true,
          qualification: "unverified_demo_only",
          person: "Jordan Example",
          property: "123 Example Street",
          conclusions: [
            {
              statement:
                "Synthetic candidate only; no real opportunity established",
              kind: "inference",
              ...source,
            },
          ],
          uncertainty: ["Identity unverified", "Ownership unverified"],
          outreachAllowed: false,
        },
      },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const n = String(index + 10).padStart(12, "0");
      const skillId = `20000000-0000-4000-8000-${n}`,
        versionId = `30000000-0000-4000-8000-${n}`,
        stepId = `40000000-0000-4000-8000-${n}`;
      await tx
        .insert(skills)
        .values({
          id: skillId,
          organizationId: ids.organization,
          name: fixture.key,
          slug: fixture.key,
        });
      await tx
        .insert(skillVersions)
        .values({
          id: versionId,
          skillId,
          version: 1,
          instructions: fixture.instructions,
          executionType: fixture.tool ? "tool" : "llm",
          inputSchema: objectSchema,
          outputSchema: objectSchema,
          configuration: fixture.tool
            ? { toolId: ids.tool, syntheticResults: fixture.response }
            : { mockResponse: fixture.response },
        });
      await tx
        .insert(workflowSteps)
        .values({
          id: stepId,
          workflowVersionId: ids.version,
          key: fixture.key,
          name: fixture.key,
          position: index,
          type: "skill",
          skillVersionId: versionId,
          configuration: {
            inputFrom:
              index === 0 ? "initial" : index === 4 ? "context" : "previous",
          },
        });
    }
    await tx
      .update(workflows)
      .set({ currentVersionId: ids.version })
      .where(eq(workflows.id, ids.workflow));
  });
  console.log(
    "Seed ready: Moses Demo Organization → Workflow v1 → 5 versioned skills",
  );
}
if (require.main === module)
  seed()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
