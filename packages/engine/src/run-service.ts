import { randomUUID } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import {
  db,
  workflows,
  workflowVersions,
  workflowSteps,
  agents,
  tasks,
  runs,
  organizations,
} from "../../database/src";
import { validate } from "./index";
import type { Json } from "../../shared/src";
export async function assertWorkflowAccess(workflowId: string, org: string) {
  const w = (
    await db.select().from(workflows).where(eq(workflows.id, workflowId))
  )[0];
  if (!w?.currentVersionId) throw Error("Published workflow not found");
  const owner = (
    await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, w.organizationId))
  )[0];
  if (w.organizationId !== org && owner?.kind !== "platform")
    throw Error("Workflow is outside this organization");
  return w;
}
export async function createWorkflowRun(
  workflowId: string,
  input: Json,
  agentId?: string,
  customerOrganizationId?: string,
  desiredRunId?: string,
  pinnedVersionId?: string,
  bindCustomer = false,
  onCreate?: (tx: any, run: typeof runs.$inferSelect) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    if (desiredRunId) {
      const previous = (
        await tx.select().from(runs).where(eq(runs.id, desiredRunId))
      )[0];
      if (previous) {
        if (onCreate) await onCreate(tx, previous);
        return { run: previous } as const;
      }
    }
    const [workflow] = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    if (!workflow?.currentVersionId)
      return { error: "Published workflow not found", code: 404 } as const;
    const [version] = await tx
      .select()
      .from(workflowVersions)
      .where(
        eq(workflowVersions.id, pinnedVersionId ?? workflow.currentVersionId),
      );
    if (!version || version.workflowId !== workflowId)
      throw Error("Pinned version does not belong to workflow");
    try {
      validate(version.inputSchema, input, "Workflow input");
    } catch (e) {
      return { error: String(e), code: 400 } as const;
    }
    const [firstStep] = await tx
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, version.id))
      .orderBy(asc(workflowSteps.position))
      .limit(1);
    const chosenAgentId = agentId ?? firstStep?.configuration.builderAgentId;
    const candidates = await tx
      .select()
      .from(agents)
      .where(
        typeof chosenAgentId === "string"
          ? and(
              eq(agents.organizationId, workflow.organizationId),
              eq(agents.id, chosenAgentId),
            )
          : eq(agents.organizationId, workflow.organizationId),
      );
    if (candidates.length !== 1)
      return {
        error:
          "Specify a valid agentId when the organization has multiple agents",
        code: 400,
      } as const;
    const [task] = await tx
      .insert(tasks)
      .values({
        organizationId: workflow.organizationId,
        agentId: candidates[0].id,
        workflowId: workflow.id,
        input: input,
      })
      .returning();
    const id = desiredRunId ?? randomUUID();
    const [run] = await tx
      .insert(runs)
      .values({
        id,
        taskId: task.id,
        workflowVersionId: version.id,
        temporalWorkflowId: `run:${id}`,
        customerOrganizationId: bindCustomer
          ? customerOrganizationId
          : undefined,
        organizationResolution: {
          state: bindCustomer ? "resolved" : "pending",
          requestedOrganizationId: customerOrganizationId ?? null,
        },
        input: input,
      })
      .returning();
    if (onCreate) await onCreate(tx, run);
    return { run } as const;
  });
}
