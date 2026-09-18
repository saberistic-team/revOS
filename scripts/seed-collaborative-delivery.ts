import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  workflows,
  workflowVersions,
  workflowSteps,
  workflowDrafts,
  agents,
  engagementTemplates,
} from "../packages/database/src";
import {
  draftSchema,
  type WorkflowDraft,
} from "../packages/shared/src/builder";
import { check } from "../apps/api/src/builder";
import { seedParticipation } from "./seed-participation";
import { seedBackendBuildSkill } from "./seed-backend-build-skill";
import { collaborativeGuidance } from "./seed-collaborative-discovery";
import { chainStagesSchema } from "../packages/shared/src/engagement";

/** Add capabilities while retaining every source step, review gate, output contract and build requirement. */
export function collaborativeStageDefinition(
  source: WorkflowDraft,
  name: string,
  skillIds: string[],
): WorkflowDraft {
  const cloned = structuredClone(source);
  cloned.name = name;
  cloned.description =
    "Named stakeholder questions and reviewed customer feedback throughout " +
    name.replace(/^Collaborative (?:Customer )?/, "").toLowerCase() +
    ".";
  cloned.instructions = source.instructions + "\n\n" + collaborativeGuidance;
  cloned.steps = cloned.steps.map((step) =>
    step.type !== "agent_loop"
      ? step
      : {
          ...step,
          configuration: {
            ...step.configuration,
            skillVersionIds: [
              ...new Set([
                ...(step.configuration.skillVersionIds || []),
                ...skillIds,
              ]),
            ],
            allowHumanQuestions: true,
            goal: [step.configuration.goal, collaborativeGuidance]
              .filter(Boolean)
              .join("\n\n"),
          },
        },
  );
  return draftSchema.parse(cloned);
}

/** New workflows + chain only. Existing published definitions, drafts and running engagements are never modified. */
export async function seedCollaborativeDelivery(
  sourceTemplateId = process.env.SOURCE_DELIVERY_TEMPLATE_ID,
) {
  const capabilities = await seedParticipation(),
    backendSkill = await seedBackendBuildSkill(),
    skillIds = [
      ...capabilities.skills.map((s) => s.versionId),
      backendSkill.versionId,
    ];
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('seed-collaborative-delivery'))`,
    );
    const templates = (
      await tx.execute(
        sql`SELECT e.* FROM engagement_template e JOIN organization o ON o.id=e.organization_id WHERE o.kind='platform' AND e.name<>'Collaborative Customer Delivery' AND jsonb_array_length(e.stages)=4 AND (${sourceTemplateId || null}::uuid IS NULL OR e.id=${sourceTemplateId || null}::uuid) ORDER BY e.created_at DESC,e.id DESC`,
      )
    ).rows as any[];
    const sourceTemplate = templates.find((t) => {
      const names = t.stages.map((s: any) => s.name.toLowerCase());
      return (
        /discovery|understand|lead/.test(names[0]) &&
        /research/.test(names[1]) &&
        /proposal/.test(names[2]) &&
        /product/.test(names[3])
      );
    });
    if (!sourceTemplate)
      throw Error(
        "No published four-stage customer delivery template was found; set SOURCE_DELIVERY_TEMPLATE_ID to a Discovery → Research → Proposal → Product template",
      );
    const sourceStages = chainStagesSchema.parse(sourceTemplate.stages);
    const existing = (
      await tx
        .select()
        .from(engagementTemplates)
        .where(
          and(
            eq(
              engagementTemplates.organizationId,
              sourceTemplate.organization_id,
            ),
            eq(engagementTemplates.name, "Collaborative Customer Delivery"),
          ),
        )
    )[0];
    if (existing) {
      const provenance = [];
      for (const stage of existing.stages) {
        const [w] = await tx
          .select()
          .from(workflows)
          .where(eq(workflows.id, stage.workflowId));
        const [v] = await tx
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.id, w.currentVersionId!));
        provenance.push({
          name: stage.name,
          workflowId: w.id,
          versionId: v.id,
          createdBy: v.createdBy,
        });
      }
      return {
        templateId: existing.id,
        created: false,
        stages: existing.stages,
        provenance,
        capabilities,
        backendSkill,
      };
    }
    const sourceAgent = (
      await tx
        .select()
        .from(agents)
        .where(eq(agents.organizationId, sourceTemplate.organization_id))
        .orderBy(asc(agents.createdAt))
    )[0];
    if (!sourceAgent) throw Error("Source template organization has no agent");
    const stages: { name: string; workflowId: string }[] = [],
      provenance: any[] = [];
    for (const [index, stage] of sourceStages.entries()) {
      const [source] = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, stage.workflowId),
            eq(workflows.organizationId, sourceTemplate.organization_id),
          ),
        );
      if (!source?.currentVersionId)
        throw Error(
          `${stage.name} must have a published workflow in the template organization`,
        );
      const [version] = await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, source.currentVersionId));
      const steps = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowVersionId, version.id))
        .orderBy(asc(workflowSteps.position));
      if (!steps.some((s) => s.type === "agent_loop"))
        throw Error(
          `${stage.name} has no agent loop to receive collaboration skills`,
        );
      const [draft] = await tx
        .select()
        .from(workflowDrafts)
        .where(eq(workflowDrafts.workflowId, source.id));
      const original = draftSchema.parse({
        name: source.name,
        description: source.description,
        agentId: draft?.definition.agentId || sourceAgent.id,
        goal: version.goal,
        instructions: version.sopMarkdown,
        inputSchema: version.inputSchema,
        outputSchema: version.outputSchema,
        steps: steps.map((s) => ({
          key: s.key,
          name: s.name,
          type: s.type,
          skillVersionId: s.skillVersionId,
          configuration: s.configuration,
        })),
      });
      const definition = collaborativeStageDefinition(
        original,
        index === 0
          ? "Collaborative Delivery — Discovery"
          : "Collaborative Customer " + stage.name,
        skillIds,
      );
      await check(tx, sourceTemplate.organization_id, definition);
      // Reuse the standalone collaborative discovery only when its published execution definition exactly matches this source.
      let reuse: typeof workflows.$inferSelect | undefined;
      if (index === 0) {
        const [candidate] = await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, sourceTemplate.organization_id),
              eq(workflows.slug, "collaborative-customer-discovery"),
            ),
          );
        if (candidate?.currentVersionId) {
          const [candidateVersion] = await tx
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.id, candidate.currentVersionId));
          const candidateSteps = await tx
            .select()
            .from(workflowSteps)
            .where(eq(workflowSteps.workflowVersionId, candidateVersion.id))
            .orderBy(asc(workflowSteps.position));
          if (
            candidateVersion.goal === definition.goal &&
            candidateVersion.sopMarkdown === definition.instructions &&
            isDeepStrictEqual(
              candidateVersion.inputSchema,
              definition.inputSchema,
            ) &&
            isDeepStrictEqual(
              candidateVersion.outputSchema,
              definition.outputSchema,
            ) &&
            isDeepStrictEqual(
              candidateSteps.map((s) => ({
                key: s.key,
                name: s.name,
                type: s.type,
                skillVersionId: s.skillVersionId,
                configuration: s.configuration,
              })),
              definition.steps,
            )
          )
            reuse = candidate;
        }
      }
      if (reuse) {
        stages.push({ name: stage.name, workflowId: reuse.id });
        provenance.push({
          name: stage.name,
          sourceWorkflowId: source.id,
          sourceVersionId: version.id,
          workflowId: reuse.id,
          versionId: reuse.currentVersionId,
          reused: true,
        });
        continue;
      }
      const workflowId = randomUUID(),
        versionId = randomUUID(),
        slug =
          "collaborative-delivery-" +
          ["discovery", "research", "proposal", "product"][index];
      const collision = (
        await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.organizationId, sourceTemplate.organization_id),
              eq(workflows.slug, slug),
            ),
          )
      )[0];
      if (collision)
        throw Error(
          `Workflow slug ${slug} already exists outside this chain; inspect it before creating a new chain`,
        );
      await tx.insert(workflows).values({
        id: workflowId,
        organizationId: sourceTemplate.organization_id,
        name: definition.name,
        slug,
        description: definition.description,
      });
      await tx.insert(workflowVersions).values({
        id: versionId,
        workflowId,
        version: 1,
        goal: definition.goal,
        sopMarkdown: definition.instructions,
        inputSchema: definition.inputSchema as any,
        outputSchema: definition.outputSchema as any,
        createdBy: `collaborative-delivery:${sourceTemplate.id}:${source.id}:${version.id}`,
      });
      await tx.insert(workflowSteps).values(
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
        .values({ workflowId, revision: 1, publishedRevision: 1, definition });
      await tx
        .update(workflows)
        .set({ currentVersionId: versionId })
        .where(eq(workflows.id, workflowId));
      stages.push({ name: stage.name, workflowId });
      provenance.push({
        name: stage.name,
        sourceWorkflowId: source.id,
        sourceVersionId: version.id,
        workflowId,
        versionId,
        reused: false,
      });
    }
    const [chain] = await tx
      .insert(engagementTemplates)
      .values({
        organizationId: sourceTemplate.organization_id,
        name: "Collaborative Customer Delivery",
        stages,
        revision: 1,
      })
      .returning();
    return {
      templateId: chain.id,
      created: true,
      sourceTemplateId: sourceTemplate.id,
      sourceTemplateRevision: sourceTemplate.revision,
      stages,
      provenance,
      capabilities,
      backendSkill,
    };
  });
}
if (require.main === module)
  seedCollaborativeDelivery()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .finally(() => pool.end());
