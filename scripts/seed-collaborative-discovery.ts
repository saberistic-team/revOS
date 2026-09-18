import { randomUUID } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  workflowDrafts,
  agents,
} from "../packages/database/src";
import { draftSchema } from "../packages/shared/src/builder";
import { check } from "../apps/api/src/builder";
import { seedParticipation } from "./seed-participation";

export const collaborativeGuidance = `Named human participation:\nUse the Identify key players skill early to inspect this customer's People directory and identify confirmed stakeholders, responsibilities, missing roles, and evidence. Propose missing contacts for confirmation; never invent their emails or send invitations. When a confirmed stakeholder's input is needed, select Collect stakeholder input and use the named participant question tool. Ask one focused question at a time with priority and why it matters. A named question pauses this run until a customer answers and a reviewer accepts or rejects the answer; only accepted answers become customer-confirmed knowledge. If the directory has no confirmed primary contact, use the existing ask-human conversation to ask the operator to add/confirm one in Organizations → People, then continue from their response. Keep role-specific questions with the appropriate person and route unresolved ownership or final decisions to the primary contact. Reuse accepted answers and existing organization knowledge; do not repeatedly ask already answered questions. Preserve disagreements and uncertainties. Continue normal research, reports, artifacts, and review gates using the source workflow's instructions.`;

/** A new published workflow; source workflows, drafts, versions, and running execution snapshots are untouched. */
export async function seedCollaborativeDiscovery(
  sourceWorkflowId = process.env.SOURCE_DISCOVERY_WORKFLOW_ID,
) {
  const capabilities = await seedParticipation();
  const skillIds = capabilities.skills.map((s) => s.versionId),
    slug = "collaborative-customer-discovery";
  return db.transaction(async (tx) => {
    await tx.execute(
      require("drizzle-orm")
        .sql`SELECT pg_advisory_xact_lock(hashtext('seed-collaborative-discovery'))`,
    );
    const existing = (
      await tx.select().from(workflows).where(eq(workflows.slug, slug))
    )[0];
    if (existing)
      return {
        workflowId: existing.id,
        versionId: existing.currentVersionId,
        created: false,
        capabilities,
      };
    const rows = (
      await pool.query(
        `SELECT w.id FROM workflow w WHERE w.current_version_id IS NOT NULL AND w.slug<>$1 AND ($2::uuid IS NULL OR w.id=$2) AND ($2::uuid IS NOT NULL OR w.name ILIKE '%discovery%') AND EXISTS (SELECT 1 FROM workflow_step s WHERE s.workflow_version_id=w.current_version_id AND s.type='agent_loop' AND s.configuration->>'provider'='openai') ORDER BY w.updated_at DESC`,
        [slug, sourceWorkflowId || null],
      )
    ).rows;
    if (!rows.length)
      throw Error(
        "Publish an OpenAI Discovery workflow first, or set SOURCE_DISCOVERY_WORKFLOW_ID",
      );
    const source = (
      await tx.select().from(workflows).where(eq(workflows.id, rows[0].id))
    )[0];
    const version = (
      await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, source.currentVersionId!))
    )[0];
    const sourceSteps = await tx
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, version.id))
      .orderBy(asc(workflowSteps.position));
    const sourceDraft = (
      await tx
        .select()
        .from(workflowDrafts)
        .where(eq(workflowDrafts.workflowId, source.id))
    )[0];
    const agent = (
      await tx
        .select()
        .from(agents)
        .where(eq(agents.organizationId, source.organizationId))
        .orderBy(asc(agents.createdAt))
    )[0];
    if (!agent) throw Error("Source organization has no agent");
    const definition = draftSchema.parse({
      name: "Collaborative Customer Discovery",
      description:
        "Discovery with named stakeholders, customer onboarding questions, attributed answer review, and organization knowledge updates.",
      agentId: sourceDraft?.definition.agentId || agent.id,
      goal: version.goal,
      instructions: version.sopMarkdown + "\n\n" + collaborativeGuidance,
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
      steps: sourceSteps.map((step) => ({
        key: step.key,
        name: step.name,
        type: step.type,
        skillVersionId: step.skillVersionId,
        configuration:
          step.type === "agent_loop"
            ? {
                ...step.configuration,
                skillVersionIds: [
                  ...new Set([
                    ...((step.configuration.skillVersionIds as string[]) || []),
                    ...skillIds,
                  ]),
                ],
                allowHumanQuestions: true,
                goal: [step.configuration.goal, collaborativeGuidance]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : step.configuration,
      })),
    });
    await check(tx, source.organizationId, definition);
    const id = randomUUID(),
      versionId = randomUUID();
    await tx
      .insert(workflows)
      .values({
        id,
        organizationId: source.organizationId,
        name: definition.name,
        slug,
        description: definition.description,
      });
    await tx
      .insert(workflowVersions)
      .values({
        id: versionId,
        workflowId: id,
        version: 1,
        goal: definition.goal,
        sopMarkdown: definition.instructions,
        inputSchema: definition.inputSchema as any,
        outputSchema: definition.outputSchema as any,
        createdBy: "participation-onboarding",
      });
    await tx
      .insert(workflowSteps)
      .values(
        definition.steps.map((s, position) => ({
          workflowVersionId: versionId,
          key: s.key,
          name: s.name,
          position,
          type: s.type,
          skillVersionId: s.skillVersionId,
          configuration: s.configuration,
        })),
      );
    await tx
      .insert(workflowDrafts)
      .values({
        workflowId: id,
        revision: 1,
        publishedRevision: 1,
        definition,
      });
    await tx
      .update(workflows)
      .set({ currentVersionId: versionId })
      .where(eq(workflows.id, id));
    return {
      workflowId: id,
      versionId,
      created: true,
      sourceWorkflowId: source.id,
      sourceVersionId: version.id,
      capabilities,
    };
  });
}
if (require.main === module)
  seedCollaborativeDiscovery()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .finally(() => pool.end());
