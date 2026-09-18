import { readReviewedParticipantResponses } from "../../../engine/src/participation";
import { runFeedback } from "../../../database/src";
import { desc, eq, and, asc, sql } from "drizzle-orm";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  db,
  runs,
  reasoningSessions,
  reasoningTurns,
  codeBuilds,
} from "../../../database/src";
import { ToolRegistry, validate } from "../../../engine/src";
import {
  sessionConfig,
  validateDecision,
  checkPayloadSize,
  checkReasoningContextSize,
} from "../../../engine/src/agent-policy";
import {
  OpenAIAgentPlanner,
  type AgentPlanner,
} from "../../../engine/src/openai-agent";
import {
  initialSessionState,
  type SessionActivities,
  type ReasonRequest,
  type SessionSnapshot,
} from "../../../shared/src/session";
import type { Json } from "../../../shared/src";
import { validatedReasoning } from "../../../engine/src/validated-reasoning";
const terminal = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
export function createSessionActivities(
  registry: ToolRegistry,
  planner: AgentPlanner = new OpenAIAgentPlanner(),
): SessionActivities {
  async function apply(
    args: {
      sessionId: string;
      turn: number;
      review?: import("../../../shared/src").Review;
      answer?: import("../../../shared/src/session").HumanAnswer;
    },
    executor: "tool" | "knowledge" | "decision",
  ) {
    return db.transaction(async (tx) => {
      const [turn] = await tx
        .select()
        .from(reasoningTurns)
        .where(
          and(
            eq(reasoningTurns.sessionId, args.sessionId),
            eq(reasoningTurns.turn, args.turn),
          ),
        )
        .for("update");
      if (!turn)
        throw ApplicationFailure.nonRetryable("Reasoning turn not found");
      if (turn.outcome) return turn.outcome;
      const [session] = await tx
        .select()
        .from(reasoningSessions)
        .where(eq(reasoningSessions.id, args.sessionId));
      if (!session || terminal(session.status))
        throw ApplicationFailure.nonRetryable("Session is closed");
      const value = validateDecision(
        turn.decision,
        turn.request,
        session.snapshot,
      );
      const state = structuredClone(turn.request.state);
      let result: Json = value;
      const { action, target } = turn.decision;
      if (
        (action === "call_tool"
          ? "tool"
          : action === "fetch_knowledge"
            ? "knowledge"
            : "decision") !== executor
      )
        throw ApplicationFailure.nonRetryable("Incorrect action executor");
      if (action === "select_skill") {
        state.activeSkillId = target;
        state.activeInput = value;
        state.selections++;
        result = { selectedSkillVersionId: target };
      } else if (action === "call_tool") {
        const tool = session.snapshot.definition.tools.find(
          (t) => t.id === target,
        )!;
        const skill = session.snapshot.catalog.find(
          (s) => s.id === state.activeSkillId,
        )!;
        if (!registry.isRetrySafe(tool.handler))
          throw ApplicationFailure.nonRetryable(
            "Tool adapter must declare retry safety before agent use",
          );
        const bindings = skill.configuration.toolConfigurations as
          | Record<string, Record<string, Json>>
          | undefined;
        result = await registry.resolve(tool.handler)(
          value,
          bindings?.[tool.id] ?? {},
          {
            idempotencyKey: `${args.sessionId}:${args.turn}`,
            signal: Context.current().cancellationSignal,
          },
        );
        validate(tool.outputSchema, result, "Tool result");
        state.toolCalls++;
      } else if (action === "fetch_knowledge") {
        const item = session.snapshot.definition.knowledge.find(
          (k) => k.id === target,
        )!;
        result = { id: item.id!, name: item.name, content: item.content };
        state.fetchedKnowledgeIds.push(item.id!);
      } else if (action === "complete_skill") {
        state.completedSkills.push({
          skillVersionId: state.activeSkillId!,
          input: state.activeInput,
          output: value,
        });
        state.activeSkillId = null;
        state.activeInput = null;
      } else if (action === "ask_human") {
        if (
          !args.answer ||
          args.answer.questionId !==
            `question:${args.sessionId}:${args.turn}` ||
          !args.answer.answer.trim() ||
          args.answer.answer.length > 12000
        )
          throw ApplicationFailure.nonRetryable(
            "Matching nonempty human answer is required",
          );
        result = {
          questionId: args.answer.questionId,
          question: (value as { question: string }).question,
          answer: args.answer.answer,
        };
      } else if (action === "request_review") {
        if (
          !args.review ||
          args.review.reviewId !== `${args.sessionId}:${args.turn}`
        )
          throw ApplicationFailure.nonRetryable("Matching review is required");
        if (args.review.action === "revise") {
          if (args.review.approved || !args.review.note?.trim())
            throw ApplicationFailure.nonRetryable("Revision requires feedback and is not an approval");
          state.revisionPending = true;
        } else {
          if (!args.review.approved)
            throw ApplicationFailure.nonRetryable("Human review rejected");
          state.revisionPending = false;
        }
        result = {
          action: args.review.action ?? "approve",
          approved: args.review.approved,
          note: args.review.note ?? "",
          reviewId: args.review.reviewId,
        };
      }
      checkPayloadSize(
        { state, result },
        session.snapshot.config.maxContextBytes,
      );
      const outcome = { state, result };
      await tx
        .update(reasoningTurns)
        .set({ outcome, completedAt: new Date() })
        .where(eq(reasoningTurns.id, turn.id));
      return outcome;
    });
  }
  return {
    async prepareHumanQuestion({ sessionId, turn }) {
      const [row] = await db
        .select()
        .from(reasoningTurns)
        .where(
          and(
            eq(reasoningTurns.sessionId, sessionId),
            eq(reasoningTurns.turn, turn),
          ),
        );
      const [session] = await db
        .select()
        .from(reasoningSessions)
        .where(eq(reasoningSessions.id, sessionId));
      if (!row || !session || row.decision.action !== "ask_human")
        throw ApplicationFailure.nonRetryable("Question turn not found");
      return validateDecision(row.decision, row.request, session.snapshot) as {
        question: string;
        options?: string[];
      };
    },
    async openReasoningSession({ runId, workflowStepId, input }) {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, runId))
          .for("update");
        const step = run?.executionDefinition?.steps.find(
          (s) => s.id === workflowStepId,
        );
        if (!run?.executionDefinition || !step?.catalog?.length)
          throw ApplicationFailure.nonRetryable(
            "Agent catalog is not in the pinned execution definition",
          );
        const [existing] = await tx
          .select()
          .from(reasoningSessions)
          .where(
            and(
              eq(reasoningSessions.runId, runId),
              eq(reasoningSessions.workflowStepId, workflowStepId),
            ),
          );
        if (existing)
          return { id: existing.id, config: existing.snapshot.config };
        const config = sessionConfig(step.configuration, {
          provider: process.env.AGENT_PROVIDER,
          model: process.env.AGENT_MODEL,
        });
        const snapshot: SessionSnapshot = {
          stepGoal:
            typeof step.configuration.goal === "string"
              ? step.configuration.goal
              : step.name,
          definition: run.executionDefinition,
          catalog: step.catalog,
          outputSchema:
            step.configuration.outputSchema ??
            step.skill?.outputSchema ??
            run.executionDefinition.workflow.outputSchema,
          config,
        };
        checkReasoningContextSize({ input }, snapshot);
        const [session] = await tx
          .insert(reasoningSessions)
          .values({ runId, workflowStepId, input, snapshot })
          .returning();
        return { id: session.id, config };
      });
    },
    async reason({ sessionId, turn }) {
      return db.transaction(async (tx) => {
        // Serializes repeated attempts: committed decisions are reused after lost Activity responses.
        const [session] = await tx
          .select()
          .from(reasoningSessions)
          .where(eq(reasoningSessions.id, sessionId))
          .for("update");
        if (!session) throw ApplicationFailure.nonRetryable("Session missing");
        const [existing] = await tx
          .select()
          .from(reasoningTurns)
          .where(
            and(
              eq(reasoningTurns.sessionId, sessionId),
              eq(reasoningTurns.turn, turn),
            ),
          );
        if (existing) return existing.decision;
        if (session.status !== "running")
          throw ApplicationFailure.nonRetryable("Session is not running");
        if (
          !Number.isInteger(turn) ||
          turn < 0 ||
          turn >= session.snapshot.config.maxTurns
        )
          throw ApplicationFailure.nonRetryable("Reasoning turn limit reached");
        const history = await tx
          .select()
          .from(reasoningTurns)
          .where(eq(reasoningTurns.sessionId, sessionId))
          .orderBy(asc(reasoningTurns.turn));
        if (history.length !== turn || history.some((t) => !t.outcome))
          throw ApplicationFailure.nonRetryable("Previous turn is incomplete");
        // Read current execution state only for a newly generated decision.
        // Do not rewrite the immutable start/inspect outcomes in earlier turns.
        const loadCurrentBuilds = (completedOnly = false) => tx
          .select({
            id: codeBuilds.id,
            parentId: codeBuilds.parentId,
            state: sql<string>`left(${codeBuilds.state}, 32)`,
            commit: sql<string | null>`left(${codeBuilds.result}->>'commit', 128)`,
            previewUrl: sql<string | null>`left(${codeBuilds.result}->>'previewUrl', 512)`,
            codeUrl: sql<string | null>`left(${codeBuilds.result}->>'codeUrl', 512)`,
            error: sql<string | null>`left(${codeBuilds.error}, 600)`,
            updatedAt: codeBuilds.updatedAt,
          })
          .from(codeBuilds)
          .innerJoin(runs, and(
            eq(runs.id, codeBuilds.runId),
            eq(runs.customerOrganizationId, codeBuilds.organizationId),
          ))
          .where(and(
            eq(codeBuilds.runId, session.runId),
            sql`split_part(${codeBuilds.sourceKey}, ':', 1) = ${sessionId}`,
            completedOnly ? eq(codeBuilds.state, "completed") : undefined,
          ))
          .orderBy(desc(codeBuilds.updatedAt), desc(codeBuilds.id))
          .limit(completedOnly ? 1 : 12);
        const currentBuilds = await loadCurrentBuilds();
        // Keep the last usable result visible even if many newer attempts failed.
        if (!currentBuilds.some((build) => build.state === "completed"))
          currentBuilds.push(...await loadCurrentBuilds(true));
        const request: ReasonRequest = {
          sessionId,
          turn,
          participantResponses: await readReviewedParticipantResponses(sessionId, session.runId),
          currentBuilds: currentBuilds.map((build) => ({ ...build, updatedAt: build.updatedAt.toISOString() })),
          humanFeedback: await tx
            .select()
            .from(runFeedback)
            .where(eq(runFeedback.runId, session.runId))
            .orderBy(desc(runFeedback.createdAt))
            .limit(8),
          input: session.input,
          state: history.at(-1)?.outcome?.state ?? initialSessionState(),
          events: history.map((t) => ({
            turn: t.turn,
            decision: t.decision,
            result: t.outcome!.result,
          })),
        };
        checkReasoningContextSize(request, session.snapshot);
        const decision = await validatedReasoning(
          planner,
          request,
          session.snapshot,
          Context.current().cancellationSignal,
        );
        await tx
          .insert(reasoningTurns)
          .values({ sessionId, turn, request, decision });
        return decision;
      });
    },
    applyAgentDecision: (args) => apply(args, "decision"),
    fetchSessionKnowledge: (args) => apply(args, "knowledge"),
    executeSessionTool: (args) => apply(args, "tool"),
    async setSessionStatus({ sessionId, status, error, output, reviewId }) {
      await db
        .update(reasoningSessions)
        .set({
          status,
          error,
          output,
          reviewId: reviewId ?? null,
          updatedAt: new Date(),
          completedAt: terminal(status) ? new Date() : null,
        })
        .where(eq(reasoningSessions.id, sessionId));
    },
  };
}
