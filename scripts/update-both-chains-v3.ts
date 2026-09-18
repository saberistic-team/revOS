/**
 * Update both chains to v3 — comprehensive, collaborative, stakeholder-driven:
 *
 * Collaborative Customer Delivery:   v2 → v3
 * Discovery v2 family:               v1 → v2
 *
 * Both chains get:
 *  - Domain skills (broad, 4-8 per step) + participation skills
 *  - Knowledge IDs (Discovery Principles + Lead Qualification Principles)
 *  - Human review gate after every agent_loop step
 *  - Per-step output formats (report/table/cards/pptx/none)
 *  - Required + allowed tools per step (participant tools, web research, build tools, knowledge)
 *  - Per-step goals with explicit deliverables, MEDDIC-style stakeholder questions,
 *    low-hanging fruit identification, value-vs-complexity prioritization
 *
 * Discovery methodology grounding:
 *  - Stakeholder mapping (economic buyer, decision maker, champion, influencers, end users)
 *  - Problem discovery: pain, cost of inaction, current state
 *  - Process discovery: how work flows, where gaps are
 *  - Market/landscape: competitors, alternatives, trends
 *  - Value quantification: revenue, cost, risk, time
 *  - Low-hanging fruit: quick wins = low effort + high impact + high confidence
 *  - Value vs complexity matrix for prioritization
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

// ── Skill IDs ────────────────────────────────────────────────────────────────
const S = {
  understand_customer:           "0c98dd55-dfbe-44f2-8e4c-9c827c34b5c4", // v3
  map_revenue_model:            "4466a6b3-8396-4122-9227-70c96072d3c5", // v3
  identify_value_opportunities: "fc8d3963-c600-44af-8c79-8590bbe3d663", // v3
  define_ideal_lead:            "b709a0b2-e22d-4fe8-a83a-d96f8bd0c68d", // v3
  design_qualification_model:   "4a05caf0-b13e-46b3-aba3-5174c26f0c31", // v3
  discover_lead_sources:        "983781cb-d234-4077-abd6-939998368904", // v3
  analyze_market_participants:  "8365136f-459e-4872-a715-e98f62394873", // v3
  audit_customer_operations:    "1b4b3a17-c0e2-4fbb-8f2f-0d4dceb74f98", // v3
  analyze_market_trends:        "4aa8353a-cf89-4d91-91ad-ae397ccaad96", // v3
  identify_revenue_streams:     "1ff80d8b-424f-4e7c-a1cc-5d6a753d182e", // v3
  prioritize_opportunities:     "aa9bf757-b595-44ac-9144-9394db0c9152", // v3
  design_offer:                 "735ebf27-253f-4865-9b92-a0452f79ae44", // v3
  design_compensation_model:    "396c780a-4fff-4b46-8de5-f7a54c284d1c", // v3
  build_product:                "564e74d6-3293-4dd8-bfdd-fd28f86d63bc", // v1 - Build and release
};

// ── Participation skills (v1) ────────────────────────────────────────────────
const P = {
  engagement_research:      "56954061-c875-45b6-8bb8-ce960ec54673",
  identify_key_players:     "1ac4b4cd-f2cd-4918-bf8a-f8854cb5ec62",
  collect_stakeholder_input:"3ad9a566-6d3a-415c-b24f-e6015d9361b3",
};

// ── Knowledge ────────────────────────────────────────────────────────────────
const K = {
  discovery_principles:    "acd0871d-69fe-459e-a0f9-77a8cda3ffd1",
  lead_qualification:      "e3fe6a16-b202-469c-b292-0684a6590d01",
};

// ── Tools ────────────────────────────────────────────────────────────────────
const T = {
  web_research:              "9121a7a9-f0ff-47c1-9dc6-8bb3d2caf755",
  list_participants:         "23c334ec-5259-4a66-8ecc-3ec0a929cd46",
  propose_participant:       "8dc74d12-9f25-436d-aed0-8c9a22fb6bbe",
  ask_participant:           "8188bb1c-f524-417a-8b1d-129a6398082c",
  read_reviewed_answer:      "55bf61a5-92ae-432b-bef2-f0ae542b55ba",
  propose_knowledge:         "88eb0618-58bf-4c47-afbd-7f7da22d332d",
  search_knowledge:          "6b2b3651-4705-406c-b2cf-79345d133086",
  build_openhands:           "bb945f47-d5b3-459c-85b3-62ed92569dab",
  revise_build:              "81fa8182-8912-465b-b024-8d22e59273b4",
  inspect_build:             "369b8a9e-3287-461a-9a46-f20505f6000a",
  create_preview:            "bf529466-6f91-4e43-bc59-5fc6b0e310e6",
  inspect_hosting:           "4ccf2166-0053-4ccc-b691-7222a61b8e14",
  prepare_backend_release:   "355602c1-4541-4f7c-9ad9-9d9268cbc355",
};

// ── Per-step output config ───────────────────────────────────────────────────
const OUTPUTS = {
  report:     { artifacts: { mode: "manual", formats: ["pdf"], instructions: "Produce a clear, structured report with sections, evidence, assumptions, and unknowns. Preserve all source citations and stakeholder attributions." }, presentation: "report" },
  report_alw: { artifacts: { mode: "always", formats: ["pdf"], instructions: "Create a concise, readable deliverable. Preserve evidence, assumptions, and unanswered questions. Do not add invented metrics." }, presentation: "report" },
  cards:      { artifacts: { mode: "manual", formats: ["pdf"], instructions: "Present findings as clear option cards with rationale, evidence, confidence, and recommended next step." }, presentation: "cards" },
  cards_alw:  { artifacts: { mode: "always", formats: ["pdf"], instructions: "Present findings as clear option cards. Preserve evidence and assumptions." }, presentation: "cards" },
  table:      { artifacts: { mode: "manual", formats: ["pdf", "xlsx"], instructions: "Present findings as a structured table with columns for key attributes, evidence, confidence, and source." }, presentation: "table" },
  table_alw:  { artifacts: { mode: "always", formats: ["pdf", "xlsx"], instructions: "Present findings as a structured table. Preserve evidence and assumptions." }, presentation: "table" },
  pptx:       { artifacts: { mode: "manual", formats: ["pdf", "pptx"], instructions: "Produce a customer-facing deck: problem, approach, deliverables, timeline, risks, next steps, and acceptance criteria." }, presentation: "report" },
  pptx_alw:   { artifacts: { mode: "always", formats: ["pdf", "pptx"], instructions: "Produce a customer-facing deck. Preserve evidence and assumptions." }, presentation: "report" },
  build:      { artifacts: { mode: "manual", formats: [], instructions: "No document artifact — this step produces executable builds and deployments." }, presentation: "report" },
};

// ── Common stakeholder + review guidance appended to every agent_loop goal ──
const STAKEHOLDER_REVIEW_GUIDANCE = `
Stakeholder engagement:
- Use List organization participants early to identify confirmed stakeholders, their roles, and evidence.
- Use Identify key players to find the economic buyer, decision maker, champion, influencers, and end users.
- Propose missing contacts with Propose organization participant for human confirmation — never invent emails or send invitations.
- When a confirmed stakeholder's input is needed, use Ask organization participant. Ask one focused question at a time with priority and why it matters. A named question pauses this run until a customer answers and a reviewer accepts or rejects the answer; only accepted answers become customer-confirmed knowledge.
- Use Read reviewed participant answer to check for already-accepted answers before asking again.
- Keep role-specific questions with the appropriate person; route unresolved ownership or final decisions to the primary contact.
- Reuse accepted answers and existing organization knowledge; do not repeatedly ask already-answered questions.

Low-hanging fruit and prioritization:
- Identify low-hanging fruit explicitly: changes that are quick to implement, require minimal resources, have high confidence, and deliver measurable impact. Flag these separately from larger strategic opportunities.
- Use a value vs complexity lens: for each opportunity, estimate impact (revenue, cost savings, risk reduction, time savings) vs effort. Prioritize high-impact, low-effort items first.
- Distinguish confirmed quick wins from those that still need validation.

Knowledge persistence:
- When you identify a finding that should be persisted for future steps or engagements, use Propose knowledge correction to capture it for human review — never commit findings automatically.
- Search organization knowledge before starting to avoid re-researching known facts.

Request review after this step:
- Before marking this step complete, produce a concise review-ready summary: what was done, key findings, open questions, stakeholders consulted, low-hanging fruit identified, and what you need the reviewer to confirm or correct.
- Use request_review so the reviewer can accept, reject, or request changes; only accepted results advance the engagement.
- If unsure whether the step is complete, request review rather than guessing.`;

// ── SOP addition ─────────────────────────────────────────────────────────────
const SOP_V3 = `
Collaboration and review gates:
- Every agent_loop step ends with an explicit human_review gate. The reviewer (engagement coordinator or named stakeholder) must accept, reject, or request changes before the next step begins.
- Ask focused questions early and often — one at a time, with priority and why it matters. A named question pauses the run until answered and reviewed.
- Identify the economic buyer, decision maker, champion, influencers, and end users before designing solutions.
- Never invent customer facts, metrics, prices, stakeholder details, or email addresses. Label every unknown explicitly.
- Reuse accepted answers and existing organization knowledge; do not re-ask already-answered questions.
- Each step's output must be review-ready: structured, sourced where possible, with open questions clearly flagged.
- Identify low-hanging fruit explicitly: quick wins = low effort + high impact + high confidence. Separate from strategic opportunities.
- Use value vs complexity prioritization: plot each opportunity on impact vs effort and prioritize high-impact, low-effort first.
- Preserve all stakeholder statements, disagreements, and uncertainties — do not resolve them silently.`;

// ── Per-step skill assignment ────────────────────────────────────────────────
function stepSkills(key: string): string[] {
  const base = [P.engagement_research, P.identify_key_players, P.collect_stakeholder_input];
  const map: Record<string, string[]> = {
    initial_landscape:       [...base, S.understand_customer, S.analyze_market_participants, S.analyze_market_trends],
    customer_conversation:   [...base, S.understand_customer, S.map_revenue_model],
    discovery_brief:         [...base, S.understand_customer, S.identify_value_opportunities, S.map_revenue_model, S.define_ideal_lead, S.discover_lead_sources, S.analyze_market_participants, S.audit_customer_operations, S.analyze_market_trends, S.identify_revenue_streams, S.prioritize_opportunities],
    research_plan:           [...base, S.analyze_market_participants, S.analyze_market_trends, S.discover_lead_sources, S.audit_customer_operations, S.identify_revenue_streams],
    research_evidence:       [...base, S.analyze_market_participants, S.analyze_market_trends, S.discover_lead_sources, S.audit_customer_operations, S.identify_revenue_streams, S.identify_value_opportunities],
    research_demonstration:  [...base, S.analyze_market_participants, S.analyze_market_trends, S.discover_lead_sources, S.identify_value_opportunities, S.design_qualification_model],
    offer_design:            [...base, S.design_offer, S.design_compensation_model, S.define_ideal_lead, S.prioritize_opportunities, S.map_revenue_model, S.identify_value_opportunities],
    proposal_package:        [...base, S.design_offer, S.design_compensation_model, S.define_ideal_lead, S.identify_value_opportunities, S.map_revenue_model],
    product_brief:           [...base, S.understand_customer, S.define_ideal_lead, S.identify_value_opportunities, S.map_revenue_model],
    build_product:           [...base, S.build_product, S.understand_customer, S.define_ideal_lead, S.identify_value_opportunities],
    product_handoff:         [...base, S.understand_customer, S.design_offer, S.identify_value_opportunities, S.map_revenue_model],
  };
  return map[key] ?? base;
}

// ── Per-step tool assignment ─────────────────────────────────────────────────
function stepTools(key: string): { required: string[]; allowed: string[] } {
  const map: Record<string, { required: string[]; allowed: string[] }> = {
    initial_landscape:       { required: [T.list_participants, T.ask_participant, T.search_knowledge], allowed: [T.web_research, T.propose_participant, T.propose_knowledge] },
    customer_conversation:   { required: [T.list_participants, T.ask_participant, T.read_reviewed_answer, T.search_knowledge], allowed: [T.web_research, T.propose_participant, T.propose_knowledge] },
    discovery_brief:         { required: [T.list_participants, T.read_reviewed_answer, T.search_knowledge], allowed: [T.web_research, T.propose_participant, T.propose_knowledge] },
    research_plan:           { required: [T.list_participants, T.search_knowledge], allowed: [T.web_research, T.propose_participant, T.propose_knowledge] },
    research_evidence:       { required: [T.web_research, T.search_knowledge], allowed: [T.list_participants, T.ask_participant, T.propose_participant, T.propose_knowledge] },
    research_demonstration:  { required: [T.list_participants, T.read_reviewed_answer, T.search_knowledge], allowed: [T.web_research, T.propose_participant, T.propose_knowledge] },
    offer_design:            { required: [T.list_participants, T.read_reviewed_answer, T.search_knowledge], allowed: [T.propose_participant, T.propose_knowledge] },
    proposal_package:        { required: [T.list_participants, T.read_reviewed_answer, T.search_knowledge], allowed: [T.propose_participant, T.propose_knowledge] },
    product_brief:           { required: [T.list_participants, T.search_knowledge], allowed: [T.propose_participant, T.propose_knowledge] },
    build_product:           { required: [T.build_openhands, T.inspect_build], allowed: [T.revise_build, T.create_preview, T.inspect_hosting, T.list_participants, T.ask_participant, T.read_reviewed_answer, T.propose_knowledge] },
    product_handoff:         { required: [T.list_participants, T.read_reviewed_answer, T.inspect_build, T.inspect_hosting], allowed: [T.search_knowledge, T.propose_participant, T.propose_knowledge] },
  };
  return map[key] ?? { required: [], allowed: [] };
}

// ── Per-step output config ───────────────────────────────────────────────────
function stepOutputs(key: string): Record<string, any> {
  const map: Record<string, Record<string, any>> = {
    initial_landscape:     OUTPUTS.report_alw,
    customer_conversation: OUTPUTS.report_alw,
    discovery_brief:       OUTPUTS.report_alw,
    research_plan:         OUTPUTS.report_alw,
    research_evidence:     OUTPUTS.table_alw,
    research_demonstration:OUTPUTS.report_alw,
    offer_design:          OUTPUTS.cards_alw,
    proposal_package:      OUTPUTS.pptx_alw,
    product_brief:         OUTPUTS.report_alw,
    build_product:         OUTPUTS.build,
    product_handoff:       OUTPUTS.report_alw,
  };
  return map[key] ?? OUTPUTS.report_alw;
}

// ── Per-step maxTurns / maxToolCalls / maxSkillSelections ───────────────────
function stepLimits(key: string): { maxTurns: number; maxToolCalls: number; maxSkillSelections: number } {
  const researchSteps = new Set(["initial_landscape", "research_plan", "research_evidence", "research_demonstration", "customer_conversation", "discovery_brief"]);
  const synthesisSteps = new Set(["offer_design", "proposal_package", "product_brief", "product_handoff"]);
  const buildSteps = new Set(["build_product"]);
  if (researchSteps.has(key)) return { maxTurns: 40, maxToolCalls: 12, maxSkillSelections: 8 };
  if (synthesisSteps.has(key)) return { maxTurns: 40, maxToolCalls: 8, maxSkillSelections: 8 };
  if (buildSteps.has(key)) return { maxTurns: 60, maxToolCalls: 12, maxSkillSelections: 8 };
  return { maxTurns: 40, maxToolCalls: 12, maxSkillSelections: 8 };
}

// ── Transform draft → v3/v2 ─────────────────────────────────────────────────
function transformDraft(definition: any): any {
  const cloned = structuredClone(definition);
  cloned.instructions = [cloned.instructions, SOP_V3].filter(Boolean).join("\n\n");

  const newSteps: Array<{
    key: string; name: string; type: string;
    skillVersionId: string | null;
    configuration: Record<string, any>;
    position: number;
  }> = [];
  let pos = 0;

  for (const step of cloned.steps) {
    if (step.type !== "agent_loop") {
      newSteps.push({ ...step, position: pos++ });
      continue;
    }

    const skills = stepSkills(step.key);
    const tools = stepTools(step.key);
    const outputs = stepOutputs(step.key);
    const limits = stepLimits(step.key);
    const existingCfg = step.configuration ?? {};
    const existingGoal = existingCfg.goal ?? "";

    newSteps.push({
      key: step.key,
      name: step.name,
      type: "agent_loop",
      skillVersionId: null,
      configuration: {
        ...existingCfg,
        goal: [existingGoal, STAKEHOLDER_REVIEW_GUIDANCE].filter(Boolean).join("\n\n"),
        skillVersionIds: skills,
        allowedKnowledgeIds: [...new Set([...(step.configuration?.allowedKnowledgeIds ?? []), K.discovery_principles, K.lead_qualification])],
        requiredKnowledgeIds: [...new Set([...(step.configuration?.requiredKnowledgeIds ?? []), K.discovery_principles, K.lead_qualification])],
        allowedToolIds: [...new Set([...(step.configuration?.allowedToolIds ?? []), ...tools.allowed])],
        requiredToolIds: [...new Set([...(step.configuration?.requiredToolIds ?? []), ...tools.required])],
        outputs,
        allowHumanReview: true,
        allowHumanQuestions: true,
        maxTurns: limits.maxTurns,
        maxToolCalls: limits.maxToolCalls,
        maxSkillSelections: limits.maxSkillSelections,
      },
      position: pos++,
    });

    newSteps.push({
      key: `review_${step.key}`,
      name: `Review ${step.name}`,
      type: "human_review",
      skillVersionId: null,
      configuration: {
        goal: `Review the completed "${step.name}" step.\n\nConfirm that:\n- All required outputs are present and correctly structured.\n- Customer statements are attributed to named stakeholders and unknowns are labeled.\n- Questions asked during this step are documented with answers or pending status.\n- Low-hanging fruit candidates are identified and separated from strategic opportunities.\n- Knowledge corrections have been proposed where findings should be persisted.\n- The findings are sufficient to proceed to the next step.\n\nApprove to continue, reject to send back, or request specific changes.`,
        allowHumanReview: true,
        allowHumanQuestions: true,
      },
      position: pos++,
    });
  }

  cloned.steps = newSteps;
  return cloned;
}

// ── Main ─────────────────────────────────────────────────────────────────────
interface Result {
  slug: string;
  name: string;
  fromVersion: number;
  toVersion: number;
  steps: number;
  reviewGates: number;
  created: boolean;
}

export async function updateBothChainsV3(): Promise<Result[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('update-both-chains-v3'))`);

    const chain = (
      await tx.select().from(engagementTemplates).where(eq(engagementTemplates.name, "Collaborative Customer Delivery"))
    )[0];
    if (!chain) throw Error("Collaborative Customer Delivery template not found");
    const orgId = chain.organizationId;

    const results: Result[] = [];

    // ── Collaborative Delivery v2 → v3 ──
    const cdSlugs = [
      "collaborative-delivery-discovery",
      "collaborative-delivery-research",
      "collaborative-delivery-proposal",
      "collaborative-delivery-product",
    ];
    for (const slug of cdSlugs) {
      const [wf] = await tx.select().from(workflows).where(and(eq(workflows.slug, slug), eq(workflows.organizationId, orgId)));
      if (!wf) { console.warn(`⚠️  ${slug} not found, skipping`); continue; }
      if (!wf.currentVersionId) throw Error(`${slug} has no current version`);

      const [ver] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, wf.currentVersionId));
      const [draft] = await tx.select().from(workflowDrafts).where(eq(workflowDrafts.workflowId, wf.id));
      if (!draft) throw Error(`${slug} has no draft`);

      const oldSteps = await tx.select().from(workflowSteps).where(eq(workflowSteps.workflowVersionId, ver.id)).orderBy(asc(workflowSteps.position));
      const newDef = transformDraft(draft.definition, "");
      const newSteps = newDef.steps;
      const reviews = newSteps.filter((s) => s.type === "human_review").length;

      await check(orgId, newDef);

      const newVerId = randomUUID();
      const newVer = ver.version + 1;
      await tx.insert(workflowVersions).values({
        id: newVerId, workflowId: wf.id, version: newVer,
        goal: newDef.goal, sopMarkdown: newDef.instructions,
        inputSchema: newDef.inputSchema, outputSchema: newDef.outputSchema,
        createdBy: `collaborative-delivery-v3:${wf.id}:${ver.id}`,
      });
      for (let i = 0; i < newSteps.length; i++) {
        const s = newSteps[i];
        await tx.insert(workflowSteps).values({
          id: randomUUID(), workflowVersionId: newVerId, key: s.key, name: s.name,
          position: i, type: s.type, skillVersionId: s.skillVersionId, configuration: s.configuration,
        });
      }
      await tx.update(workflows).set({ currentVersionId: newVerId, updatedAt: new Date() }).where(eq(workflows.id, wf.id));
      await tx.update(workflowDrafts).set({ publishedRevision: newVer, revision: newVer, updatedAt: new Date() }).where(eq(workflowDrafts.workflowId, wf.id));

      results.push({ slug, name: wf.name, fromVersion: ver.version, toVersion: newVer, steps: newSteps.length, reviewGates: reviews, created: true });
      console.log(`✅ ${wf.name} (v${ver.version} → v${newVer}): ${newSteps.length} steps, ${reviews} review gates`);
    }

    // ── Discovery v2 family v1 → v2 ──
    const dv2Slugs = [
      { slug: "workflow-7d3546a9-8bbb-43ea-868f-8f0daad871bf", name: "Discovery v2 — Understand the Lead" },
      { slug: "workflow-b742dff2-205a-45f9-add3-4827fc8593d6", name: "Discovery v2 — Research and Validate" },
      { slug: "workflow-4a6c6ab5-64fe-4c86-ac52-c17a32f3466f", name: "Discovery v2 — Customer Proposal" },
      { slug: "workflow-d4efe2f1-e7a3-4a9b-9e88-e320f37b42e1", name: "Discovery v2 — Product and Preview" },
    ];
    for (const item of dv2Slugs) {
      const slug = item.slug;
      const name = item.name;
      const [wf] = await tx.select().from(workflows).where(eq(workflows.slug, slug));
      if (!wf) { console.warn(`⚠️  ${slug} not found, skipping`); continue; }
      if (!wf.currentVersionId) throw Error(`${slug} has no current version`);

      const [ver] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, wf.currentVersionId));
      const [draft] = await tx.select().from(workflowDrafts).where(eq(workflowDrafts.workflowId, wf.id));
      if (!draft) throw Error(`${slug} has no draft`);

      const oldSteps = await tx.select().from(workflowSteps).where(eq(workflowSteps.workflowVersionId, ver.id)).orderBy(asc(workflowSteps.position));
      const newDef = transformDraft(draft.definition);
      console.log(`  📋 ${slug}: newDef keys = ${JSON.stringify(Object.keys(newDef))}, hasGoal=${!!newDef.goal}, hasInstructions=${!!newDef.instructions}, hasSteps=${newDef.steps?.length}, hasAgentId=${!!newDef.agentId}, hasInput=${!!newDef.inputSchema}, hasOutput=${!!newDef.outputSchema}`);
      const newSteps = newDef.steps;
      const reviews = newSteps.filter((s) => s.type === "human_review").length;

      await check(orgId, newDef);

      const newVerId = randomUUID();
      const newVer = ver.version + 1;
      await tx.insert(workflowVersions).values({
        id: newVerId, workflowId: wf.id, version: newVer,
        goal: newDef.goal, sopMarkdown: newDef.instructions,
        inputSchema: newDef.inputSchema, outputSchema: newDef.outputSchema,
        createdBy: `discovery-v2-v3:${wf.id}:${ver.id}`,
      });
      for (let i = 0; i < newSteps.length; i++) {
        const s = newSteps[i];
        await tx.insert(workflowSteps).values({
          id: randomUUID(), workflowVersionId: newVerId, key: s.key, name: s.name,
          position: i, type: s.type, skillVersionId: s.skillVersionId, configuration: s.configuration,
        });
      }
      await tx.update(workflows).set({ currentVersionId: newVerId, updatedAt: new Date() }).where(eq(workflows.id, wf.id));
      await tx.update(workflowDrafts).set({ publishedRevision: newVer, revision: newVer, updatedAt: new Date() }).where(eq(workflowDrafts.workflowId, wf.id));

      results.push({ slug, name, fromVersion: ver.version, toVersion: newVer, steps: newSteps.length, reviewGates: reviews, created: true });
      console.log(`✅ ${name} (v${ver.version} → v${newVer}): ${newSteps.length} steps, ${reviews} review gates`);
    }

    return results;
  });
}

if (require.main === module) {
  updateBothChainsV3()
    .then((r) => { console.log(`\n✅ Updated ${r.length} workflows to v3`); process.exit(0); })
    .catch((err) => { console.error("❌", err); process.exit(1); })
    .finally(() => pool.end());
}
