/**
 * Update Collaborative Delivery workflows (v1 → v2):
 *  - Add domain skills to each step
 *  - Add explicit question-asking guidance to each step goal
 *  - Insert a human_review gate after every agent_loop step
 *  - Enhance SOP instructions
 *
 * Safe: no live engagements use the Collaborative Customer Delivery chain.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  workflowDrafts,
  engagementTemplates,
  skills,
  skillVersions,
} from "../packages/database/src";
import { draftSchema } from "../packages/shared/src/builder";
import { check } from "../apps/api/src/builder";

// ── Domain skills (v3 from Customer Opportunity Discovery) ──────────────────
const DOMAIN_SKILLS = {
  understand_customer: "0c98dd55-dfbe-44f2-8e4c-9c827c34b5c4",
  map_revenue_model: "4466a6b3-8396-4122-9227-70c96072d3c5",
  identify_value_opportunities: "fc8d3963-c600-44af-8c79-8590bbe3d663",
  define_ideal_lead: "b709a0b2-e22d-4fe8-a83a-d96f8bd0c68d",
  design_qualification_model: "4a05caf0-b13e-46b3-aba3-5174c26f0c31",
  discover_lead_sources: "983781cb-d234-4077-abd6-939998368904",
  analyze_market_participants: "8365136f-459e-4872-a715-e98f62394873",
  audit_customer_operations: "1b4b3a17-c0e2-4fbb-8f2f-0d4dceb74f98",
  analyze_market_trends: "4aa8353a-cf89-4d91-91ad-ae397ccaad96",
  identify_revenue_streams: "1ff80d8b-424f-4e7c-a1cc-5d6a753d182e",
  prioritize_opportunities: "aa9bf757-b595-44ac-9144-9394db0c9152",
  design_offer: "735ebf27-253f-4865-9b92-a0452f79ae44",
  design_compensation_model: "396c780a-4fff-4b46-8de5-f7a54c284d1c",
} as const;

// Build-and-release skill (v1) — NOTE: this is the skill_version ID, not the skill ID
const BUILD_SKILL = "564e74d6-3293-4dd8-bfdd-fd28f86d63bc";

// Knowledge documents shared by domain skills
const KNOWLEDGE_IDS = [
  "acd0871d-69fe-459e-a0f9-77a8cda3ffd1", // Discovery Principles
  "e3fe6a16-b202-469c-b292-0684a6590d01", // Lead Qualification Principles
];

// Participation skills already on the collaborative steps
const PARTICIPATION_SKILLS = [
  "56954061-c875-45b6-8bb8-ce960ec54673",
  "1ac4b4cd-f2cd-4918-bf8a-f8854cb5ec62",
  "3ad9a566-6d3a-415c-b24f-e6015d9361b3",
  "564e74d6-3293-4dd8-bfdd-fd28f86d63bc",
];

// ── Per-step question + review guidance appended to every agent_loop goal ──
const STEP_QUESTION_REVIEW_GUIDANCE = `
Ask questions:
- Before starting work, list the 2-3 most important facts you still need and ask the operator for each one using ask_human or Collect stakeholder input — one question at a time, stating why each answer matters.
- If a stakeholder's answer is ambiguous, follow up before proceeding; never silently fill gaps with assumptions.
- Preserve every customer statement, disagreement, and unknown explicitly in your output.

Request review after this step:
- Before marking this step complete, produce a concise review-ready summary: what was done, key findings, open questions, and what you need the reviewer to confirm or correct.
- Use request_review so the reviewer can accept, reject, or request changes; only accepted results advance the engagement.
- If you are unsure whether the step is complete, request review rather than guessing.`;

// ── Enhanced SOP instructions ────────────────────────────────────────────────
const ENHANCED_SOP_ADDITION = `
Collaboration and review gates:
- Every agent_loop step ends with an explicit human_review gate. The reviewer (engagement coordinator or named stakeholder) must accept, reject, or request changes before the next step begins.
- Ask focused questions early and often — one at a time, with priority and why it matters. A named question pauses the run until answered and reviewed.
- Never invent customer facts, metrics, prices, or stakeholder details. Label every unknown explicitly.
- Reuse accepted answers and existing organization knowledge; do not re-ask already-answered questions.
- Each step's output must be review-ready: structured, sourced where possible, with open questions clearly flagged.`;

// ── Skill mapping per step key ──────────────────────────────────────────────
function domainSkillsForStep(stepKey: string): string[] {
  const map: Record<string, string[]> = {
    // Discovery
    initial_landscape: [
      DOMAIN_SKILLS.understand_customer,
      DOMAIN_SKILLS.analyze_market_participants,
      DOMAIN_SKILLS.analyze_market_trends,
      DOMAIN_SKILLS.identify_value_opportunities,
    ],
    customer_conversation: [
      DOMAIN_SKILLS.understand_customer,
      DOMAIN_SKILLS.map_revenue_model,
    ],
    discovery_brief: [
      DOMAIN_SKILLS.understand_customer,
      DOMAIN_SKILLS.identify_value_opportunities,
      DOMAIN_SKILLS.map_revenue_model,
      DOMAIN_SKILLS.define_ideal_lead,
      DOMAIN_SKILLS.discover_lead_sources,
      DOMAIN_SKILLS.analyze_market_participants,
      DOMAIN_SKILLS.audit_customer_operations,
      DOMAIN_SKILLS.analyze_market_trends,
      DOMAIN_SKILLS.identify_revenue_streams,
      DOMAIN_SKILLS.prioritize_opportunities,
    ],
    // Research
    research_plan: [
      DOMAIN_SKILLS.analyze_market_participants,
      DOMAIN_SKILLS.analyze_market_trends,
      DOMAIN_SKILLS.discover_lead_sources,
      DOMAIN_SKILLS.audit_customer_operations,
      DOMAIN_SKILLS.identify_revenue_streams,
    ],
    research_evidence: [
      DOMAIN_SKILLS.analyze_market_participants,
      DOMAIN_SKILLS.analyze_market_trends,
      DOMAIN_SKILLS.discover_lead_sources,
      DOMAIN_SKILLS.audit_customer_operations,
      DOMAIN_SKILLS.identify_revenue_streams,
      DOMAIN_SKILLS.identify_value_opportunities,
    ],
    research_demonstration: [
      DOMAIN_SKILLS.analyze_market_participants,
      DOMAIN_SKILLS.analyze_market_trends,
      DOMAIN_SKILLS.discover_lead_sources,
      DOMAIN_SKILLS.identify_value_opportunities,
      DOMAIN_SKILLS.design_qualification_model,
    ],
    // Proposal
    offer_design: [
      DOMAIN_SKILLS.design_offer,
      DOMAIN_SKILLS.design_compensation_model,
      DOMAIN_SKILLS.define_ideal_lead,
      DOMAIN_SKILLS.prioritize_opportunities,
      DOMAIN_SKILLS.map_revenue_model,
    ],
    proposal_package: [
      DOMAIN_SKILLS.design_offer,
      DOMAIN_SKILLS.design_compensation_model,
      DOMAIN_SKILLS.define_ideal_lead,
      DOMAIN_SKILLS.identify_value_opportunities,
    ],
    // Product
    product_brief: [
      DOMAIN_SKILLS.understand_customer,
      DOMAIN_SKILLS.define_ideal_lead,
      DOMAIN_SKILLS.identify_value_opportunities,
      DOMAIN_SKILLS.map_revenue_model,
    ],
    build_product: [BUILD_SKILL],
    product_handoff: [
      DOMAIN_SKILLS.understand_customer,
      DOMAIN_SKILLS.design_offer,
      DOMAIN_SKILLS.identify_value_opportunities,
    ],
  };
  return map[stepKey] ?? [];
}

/** Enrich a single agent_loop step's configuration */
function enrichStepConfig(
  step: { key: string; name: string; configuration: Record<string, any> },
  extraSkillIds: string[],
): Record<string, any> {
  const cfg = { ...step.configuration };
  const allSkillIds = [
    ...new Set([
      ...PARTICIPATION_SKILLS,
      ...extraSkillIds,
      ...(cfg.skillVersionIds ?? []),
    ]),
  ];
  // Dedup while preserving order
  const seen = new Set<string>();
  cfg.skillVersionIds = allSkillIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Add allowed/required knowledge for domain skills
  cfg.allowedKnowledgeIds = [...new Set([...(cfg.allowedKnowledgeIds ?? []), ...KNOWLEDGE_IDS])];
  cfg.requiredKnowledgeIds = [...new Set([...(cfg.requiredKnowledgeIds ?? []), ...KNOWLEDGE_IDS])];

  // Enhance goal with question + review guidance
  const existingGoal = cfg.goal ?? "";
  cfg.goal = [existingGoal, STEP_QUESTION_REVIEW_GUIDANCE]
    .filter(Boolean)
    .join("\n\n");

  // Ensure review/question flags
  cfg.allowHumanReview = true;
  cfg.allowHumanQuestions = true;

  // Raise limits slightly for more comprehensive work
  cfg.maxTurns = Math.max(cfg.maxTurns ?? 40, 40);
  cfg.maxToolCalls = Math.max(cfg.maxToolCalls ?? 12, 12);
  cfg.maxSkillSelections = Math.max(cfg.maxSkillSelections ?? 4, 6);

  return cfg;
}

/** Build the new steps array: agent_loop steps interleaved with human_review gates */
function buildNewSteps(
  oldSteps: Array<{
    key: string;
    name: string;
    type: string;
    skillVersionId: string | null;
    configuration: Record<string, any>;
  }>,
): Array<{
  key: string;
  name: string;
  type: string;
  skillVersionId: string | null;
  configuration: Record<string, any>;
  position?: number;
}> {
  const newSteps: Array<{
    key: string;
    name: string;
    type: string;
    skillVersionId: string | null;
    configuration: Record<string, any>;
    position?: number;
  }> = [];
  let position = 0;

  for (const step of oldSteps) {
    if (step.type !== "agent_loop") {
      newSteps.push({ ...step, position: position++ });
      continue;
    }

    // 1. The enriched agent_loop step
    newSteps.push({
      key: step.key,
      name: step.name,
      type: "agent_loop",
      skillVersionId: null,
      configuration: enrichStepConfig(step, domainSkillsForStep(step.key)),
      position: position++,
    });

    // 2. A human_review gate after this step
    newSteps.push({
      key: `review_${step.key}`,
      name: `Review ${step.name}`,
      type: "human_review",
      skillVersionId: null,
      configuration: {
        goal: `Review the completed "${step.name}" step.\n\nConfirm that:\n- All required outputs are present and correctly structured.\n- Customer statements are attributed and unknowns are labeled.\n- Questions asked during this step are documented with answers or pending status.\n- The findings are sufficient to proceed to the next step.\n\nApprove to continue, reject to send back, or request specific changes.`,
        allowHumanReview: true,
        allowHumanQuestions: true,
      },
      position: position++,
    });
  }

  return newSteps;
}

/** Transform a draft definition into v2 */
function transformDraft(definition: any): any {
  const cloned = structuredClone(definition);
  cloned.instructions = [cloned.instructions, ENHANCED_SOP_ADDITION]
    .filter(Boolean)
    .join("\n\n");

  cloned.steps = buildNewSteps(
    cloned.steps.map((s: any) => ({
      key: s.key,
      name: s.name,
      type: s.type,
      skillVersionId: s.skillVersionId ?? null,
      configuration: s.configuration ?? {},
    })),
  );

  return cloned;
}

// ── Main update ─────────────────────────────────────────────────────────────
interface WorkflowRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  currentVersionId: string | null;
  organizationId: string;
}

interface VersionRecord {
  id: string;
  workflowId: string;
  version: number;
  goal: string;
  sopMarkdown: string;
  inputSchema: any;
  outputSchema: any;
  createdBy: string;
}

interface DraftRecord {
  workflowId: string;
  revision: number;
  publishedRevision: number | null;
  definition: any;
}

interface StepRecord {
  id: string;
  workflowVersionId: string;
  key: string;
  name: string;
  position: number;
  type: string;
  skillVersionId: string | null;
  configuration: any;
}

interface RunResult {
  workflowId: string;
  versionId: string;
  created: boolean;
  stepsAdded: number;
  reviewGatesAdded: number;
}

export async function updateCollaborativeDeliveryV2(): Promise<RunResult[]> {
  const targetSlugs = [
    "collaborative-delivery-discovery",
    "collaborative-delivery-research",
    "collaborative-delivery-proposal",
    "collaborative-delivery-product",
  ];

  return db.transaction(async (tx: any) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('update-collaborative-delivery-v2'))`,
    );

    // 1. Find the Collaborative Customer Delivery template (to get org_id)
    const [chain] = await tx
      .select()
      .from(engagementTemplates)
      .where(eq(engagementTemplates.name, "Collaborative Customer Delivery"));
    if (!chain) throw Error("Collaborative Customer Delivery template not found");

    const results: RunResult[] = [];

    for (const slug of targetSlugs) {
      // 2. Read current workflow + version + draft + steps
      const [workflow] = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.slug, slug), eq(workflows.organizationId, chain.organizationId)));

      if (!workflow) {
        console.warn(`⚠️  Workflow ${slug} not found, skipping`);
        continue;
      }
      if (!workflow.currentVersionId) {
        throw Error(`Workflow ${slug} has no current version`);
      }

      const [version] = await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, workflow.currentVersionId));

      if (!version) throw Error(`No version for ${slug}`);

      const [draft] = await tx
        .select()
        .from(workflowDrafts)
        .where(eq(workflowDrafts.workflowId, workflow.id));

      if (!draft) throw Error(`No draft for ${slug}`);

      const oldSteps = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowVersionId, version.id))
        .orderBy(asc(workflowSteps.position));

      // 3. Transform
      const newDefinition = transformDraft(draft.definition);
      const newSteps = newDefinition.steps;
      const agentLoopCount = newSteps.filter((s: any) => s.type === "agent_loop").length;
      const reviewCount = newSteps.filter((s: any) => s.type === "human_review").length;

      // 4. Validate (with debug)
      try {
        await check(tx, chain.organizationId, newDefinition);
      } catch (err: any) {
        console.error(`❌ check() failed for ${workflow.name}: ${err.message}`);
        // Log which skill IDs are in the new steps
        for (const s of newSteps) {
          if (s.type === "agent_loop" && Array.isArray(s.configuration.skillVersionIds)) {
            for (const id of s.configuration.skillVersionIds) {
              const [row] = await tx
                .select()
                .from(skillVersions)
                .innerJoin(skills, eq(skills.id, skillVersions.skillId))
                .where(eq(skillVersions.id, id));
              if (!row) {
                console.error(`  MISSING skill version: ${id} (step: ${s.key})`);
              } else {
                console.error(
                  `  skill ${id}: ${row.skill.name} v${row.skill_version.version} exec=${row.skill_version.executionType} org=${row.skill.organizationId}`,
                );
              }
            }
          }
        }
        throw err;
      }

      // 5. Create new version
      const newVersionId = randomUUID();
      const newVersion = version.version + 1;

      await tx.insert(workflowVersions).values({
        id: newVersionId,
        workflowId: workflow.id,
        version: newVersion,
        goal: newDefinition.goal,
        sopMarkdown: newDefinition.instructions,
        inputSchema: newDefinition.inputSchema,
        outputSchema: newDefinition.outputSchema,
        createdBy: `collaborative-delivery-v2:${workflow.id}:${version.id}`,
      });

      // 6. Create new steps
      for (let i = 0; i < newSteps.length; i++) {
        const s = newSteps[i];
        await tx.insert(workflowSteps).values({
          id: randomUUID(),
          workflowVersionId: newVersionId,
          key: s.key,
          name: s.name,
          position: i,
          type: s.type,
          skillVersionId: s.skillVersionId,
          configuration: s.configuration,
        });
      }

      // 7. Update workflow to point to new version
      await tx
        .update(workflows)
        .set({ currentVersionId: newVersionId, updatedAt: new Date() })
        .where(eq(workflows.id, workflow.id));

      // 8. Update draft published revision
      await tx
        .update(workflowDrafts)
        .set({ publishedRevision: newVersion, revision: newVersion, updatedAt: new Date() })
        .where(eq(workflowDrafts.workflowId, workflow.id));

      results.push({
        workflowId: workflow.id,
        versionId: newVersionId,
        created: true,
        stepsAdded: newSteps.length - oldSteps.length,
        reviewGatesAdded: reviewCount,
      });

      console.log(
        `✅ ${workflow.name} (v${version.version} → v${newVersion}): ` +
          `${newSteps.length} steps (${agentLoopCount} agent_loop + ${reviewCount} human_review)`,
      );
    }

    return results;
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  updateCollaborativeDeliveryV2()
    .then((results) => {
      console.log("\n📋 Summary:");
      for (const r of results) {
        console.log(
          `  ${r.workflowId}: +${r.stepsAdded} steps, ${r.reviewGatesAdded} review gates`,
        );
      }
      console.log(`\n✅ Updated ${results.length} workflows to v2`);
    })
    .catch((err) => {
      console.error("❌ Update failed:", err);
      process.exit(1);
    })
    .finally(() => pool.end());
}
