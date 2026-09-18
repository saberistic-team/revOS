import { and, eq } from "drizzle-orm";
import {
  db,
  runs,
  runSteps,
  reasoningSessions,
  reasoningTurns,
} from "../../database/src";
import {
  outputSettingsSchema,
  type OutputSource,
} from "../../shared/src/outputs";
export async function loadOutputSource(source: OutputSource) {
  const [run] = await db.select().from(runs).where(eq(runs.id, source.runId));
  const step = run?.executionDefinition?.steps.find(
    (s) => s.id === source.workflowStepId,
  );
  if (!step) throw new Error("Output step not found in this run");
  if (source.sessionId !== undefined) {
    const [session] = await db
      .select()
      .from(reasoningSessions)
      .where(
        and(
          eq(reasoningSessions.id, source.sessionId),
          eq(reasoningSessions.runId, source.runId),
          eq(reasoningSessions.workflowStepId, source.workflowStepId),
        ),
      );
    if (!session || source.turn === undefined)
      throw new Error("Skill output session not found");
    const [turn] = await db
      .select()
      .from(reasoningTurns)
      .where(
        and(
          eq(reasoningTurns.sessionId, session.id),
          eq(reasoningTurns.turn, source.turn),
        ),
      );
    if (!turn?.outcome || turn.decision.action !== "complete_skill")
      throw new Error("Skill output is not complete");
    const skill = session.snapshot.catalog.find(
      (s) => s.id === turn.decision.target,
    );
    if (!skill) throw new Error("Pinned skill not found");
    return {
      title: skill.name,
      output: JSON.parse(turn.decision.payload),
      settings: outputSettingsSchema.parse(skill.configuration.outputs ?? {}),
      skillVersionId: skill.id,
    };
  }
  const [saved] = await db
    .select()
    .from(runSteps)
    .where(
      and(
        eq(runSteps.runId, source.runId),
        eq(runSteps.workflowStepId, source.workflowStepId),
      ),
    );
  if (saved?.status !== "completed")
    throw new Error("Step output is not complete");
  if (
    source.fixedSkill &&
    (step.type !== "skill" ||
      !step.skill ||
      step.skill.executionType === "agent")
  )
    throw new Error("This step has no fixed skill output");
  const configuration = source.fixedSkill
    ? step.skill?.configuration
    : step.configuration;
  return {
    title: step.name,
    output: saved.output ?? null,
    settings: outputSettingsSchema.parse(configuration?.outputs ?? {}),
    skillVersionId: source.fixedSkill ? step.skill?.id : undefined,
  };
}
