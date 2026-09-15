import { eq, and, asc, sql } from "drizzle-orm";
import { ApplicationFailure } from "@temporalio/activity";
import {
  db,
  runs,
  tasks,
  workflowVersions,
  workflowSteps,
  agents,
  knowledge,
  skillVersions,
  tools,
  runSteps,
} from "../../../database/src";
import { validate, ToolRegistry, ModelProvider } from "../../../engine/src";
import type {
  Activities,
  ExecutionDefinition,
  Status,
} from "../../../shared/src";
export function createActivities(
  registry: ToolRegistry,
  provider: ModelProvider,
): Activities {
  async function setStatus(
    runId: string,
    status: Status,
    extra: Partial<typeof runs.$inferInsert> = {},
  ) {
    await db.transaction(async (tx) => {
      const [run] = await tx
        .update(runs)
        .set({ status, ...extra })
        .where(eq(runs.id, runId))
        .returning();
      if (!run) throw ApplicationFailure.nonRetryable("Run not found");
      await tx.update(tasks).set({ status }).where(eq(tasks.id, run.taskId));
    });
  }
  const activities: Activities = {
    async loadExecutionDefinition(args) {
      return db.transaction(
        async (tx) => {
          const [run] = await tx
            .select()
            .from(runs)
            .where(eq(runs.id, args.runId))
            .for("update");
          if (!run || run.workflowVersionId !== args.workflowVersionId)
            throw ApplicationFailure.nonRetryable("Run/version mismatch");
          const [same] = await tx
            .select({
              ok: sql<boolean>`${runs.input} = ${JSON.stringify(args.input)}::jsonb`,
            })
            .from(runs)
            .where(eq(runs.id, args.runId));
          if (!same.ok)
            throw ApplicationFailure.nonRetryable("Run/input mismatch");
          if (run.executionDefinition) return run.executionDefinition;
          const [task] = await tx
            .select()
            .from(tasks)
            .where(eq(tasks.id, run.taskId));
          const [version] = await tx
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.id, args.workflowVersionId));
          const [agent] = await tx
            .select()
            .from(agents)
            .where(
              and(
                eq(agents.id, task.agentId),
                eq(agents.organizationId, task.organizationId),
              ),
            );
          if (!version || version.workflowId !== task.workflowId || !agent)
            throw ApplicationFailure.nonRetryable("Invalid task configuration");
          const steps = await tx
            .select()
            .from(workflowSteps)
            .where(eq(workflowSteps.workflowVersionId, version.id))
            .orderBy(asc(workflowSteps.position));
          if (!steps.length)
            throw ApplicationFailure.nonRetryable("Workflow has no steps");
          const definition: ExecutionDefinition = {
            workflow: {
              id: version.workflowId,
              version: version.version,
              goal: version.goal,
              sopMarkdown: version.sopMarkdown,
              inputSchema: version.inputSchema,
              outputSchema: version.outputSchema,
            },
            agent: { name: agent.name, instructions: agent.instructions },
            knowledge: await tx
              .select({ name: knowledge.name, content: knowledge.content })
              .from(knowledge)
              .where(eq(knowledge.organizationId, task.organizationId)),
            tools: [],
            steps: [],
          };
          for (const step of steps) {
            const [skill] = step.skillVersionId
              ? await tx
                  .select()
                  .from(skillVersions)
                  .where(eq(skillVersions.id, step.skillVersionId))
              : [];
            if (step.type === "skill" && !skill)
              throw ApplicationFailure.nonRetryable("Skill version missing");
            if (skill?.executionType === "tool") {
              const toolId = skill.configuration.toolId;
              if (typeof toolId !== "string")
                throw ApplicationFailure.nonRetryable("toolId is required");
              const [tool] = await tx
                .select()
                .from(tools)
                .where(eq(tools.id, toolId));
              if (!tool)
                throw ApplicationFailure.nonRetryable("Tool not found");
              if (!definition.tools.some((t) => t.id === tool.id))
                definition.tools.push(tool);
            }
            definition.steps.push({ ...step, skill });
          }
          validate(
            definition.workflow.inputSchema,
            args.input,
            "Workflow input",
          );
          await tx
            .update(runs)
            .set({ executionDefinition: definition })
            .where(eq(runs.id, run.id));
          return definition;
        },
        { isolationLevel: "repeatable read" },
      );
    },
    async markRunRunning(runId) {
      await setStatus(runId, "running", {
        startedAt: sql`coalesce(${runs.startedAt}, now())` as unknown as Date,
      });
    },
    async markRunWaiting(runId) {
      await setStatus(runId, "waiting");
    },
    async executeSkill({ skill, input, definition }) {
      validate(skill.inputSchema, input, "Skill input");
      let output;
      if (skill.executionType === "tool") {
        const tool = definition.tools.find(
          (t) => t.id === skill.configuration.toolId,
        );
        if (!tool)
          throw ApplicationFailure.nonRetryable("Tool binding missing");
        output = await activities.executeTool({
          tool,
          input,
          configuration: skill.configuration,
        });
      } else if (skill.executionType === "llm") {
        output = (
          await provider.generate({
            instructions: skill.instructions,
            input,
            outputSchema: skill.outputSchema,
            configuration: skill.configuration,
            context: {
              workflow: definition.workflow,
              agent: definition.agent,
              knowledge: definition.knowledge,
            },
          })
        ).output;
      } else
        throw ApplicationFailure.nonRetryable(
          "Unsupported skill execution type",
        );
      validate(skill.outputSchema, output, "Skill output");
      return output;
    },
    async executeTool({ tool, input, configuration }) {
      validate(tool.inputSchema, input, "Tool input");
      const output = await registry.resolve(tool.handler)(input, configuration);
      validate(tool.outputSchema, output, "Tool output");
      return output;
    },
    async saveRunStep(args) {
      const [run] = await db.select().from(runs).where(eq(runs.id, args.runId));
      const [step] = await db
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.id, args.workflowStepId),
            eq(workflowSteps.workflowVersionId, run.workflowVersionId),
          ),
        );
      if (!step)
        throw ApplicationFailure.nonRetryable(
          "Step does not belong to run version",
        );
      const terminal = ["completed", "failed", "cancelled"].includes(
        args.status,
      );
      const values = {
        ...args,
        startedAt: new Date(),
        completedAt: terminal ? new Date() : null,
      };
      await db
        .insert(runSteps)
        .values(values)
        .onConflictDoUpdate({
          target: [runSteps.runId, runSteps.workflowStepId],
          set: {
            status: args.status,
            input: args.input,
            output: args.output,
            error: args.error,
            completedAt: values.completedAt,
          },
        });
    },
    async completeRun({ runId, output, outputSchema }) {
      validate(outputSchema, output, "Workflow output");
      await setStatus(runId, "completed", { output, completedAt: new Date() });
    },
    async failRun({ runId, error, cancelled }) {
      await setStatus(runId, cancelled ? "cancelled" : "failed", {
        error,
        completedAt: new Date(),
      });
    },
  };
  return activities;
}
