import type { Json } from "../../shared/src";
import type {
  AgentDecision,
  ReasonRequest,
  SessionConfig,
  SessionSnapshot,
} from "../../shared/src/session";
import { validate } from "./index";
export function missingSkillRequirements(
  request: ReasonRequest,
  snapshot: SessionSnapshot,
) {
  const skill = snapshot.catalog.find(
    (s) => s.id === request.state.activeSkillId,
  );
  if (!skill) return [];
  const configuration = skill.configuration;
  const missing = (
    Array.isArray(configuration.requiredKnowledgeIds)
      ? configuration.requiredKnowledgeIds
      : []
  )
    .filter((id) => !request.state.fetchedKnowledgeIds.includes(String(id)))
    .map((id) => `knowledge:${id}`);
  // Require a recorded call after the current skill selection, not a call by an unrelated skill.
  let selected = -1;
  request.events.forEach((e, i) => {
    if (e.decision.action === "select_skill") selected = i;
  });
  for (const id of Array.isArray(configuration.requiredToolIds)
    ? configuration.requiredToolIds
    : [])
    if (
      !request.events
        .slice(selected + 1)
        .some(
          (e) => e.decision.action === "call_tool" && e.decision.target === id,
        )
    )
      missing.push(`tool:${id}`);
  return missing;
}
export function sessionConfig(
  configuration: Record<string, Json>,
  overrides: { provider?: string; model?: string } = {},
): SessionConfig {
  const bounded = (key: string, fallback: number, max: number) => {
    const n = configuration[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${key}: allowed 1..${max}`);
    return n;
  };
  const provider = overrides.provider ?? configuration.provider ?? "mock";
  if (provider !== "mock" && provider !== "openai")
    throw new Error("Unsupported agent provider");
  const model = overrides.model ?? configuration.model ?? "gpt-4.1-mini";
  if (typeof model !== "string" || !model.length)
    throw new Error("Model is required");
  return {
    provider,
    model,
    maxTurns: bounded("maxTurns", 12, 50),
    maxToolCalls: bounded("maxToolCalls", 8, 50),
    maxSkillSelections: bounded("maxSkillSelections", 4, 20),
    maxContextBytes: bounded("maxContextBytes", 128000, 500000),
    maxOutputTokens: bounded("maxOutputTokens", 2000, 8000),
    allowHumanReview: configuration.allowHumanReview === true,
    allowHumanQuestions: configuration.allowHumanQuestions !== false,
    mockDecisions: (configuration.mockDecisions ??
      []) as unknown as AgentDecision[],
  };
}
export function validateDecision(
  decision: AgentDecision,
  request: ReasonRequest,
  snapshot: SessionSnapshot,
): Json {
  const { state } = request;
  if (state.revisionPending && ["complete_skill", "final"].includes(decision.action))
    throw Error("Address the review feedback and request_review again. Human approval is required before completing the revision.");
  const skill = snapshot.catalog.find((s) => s.id === state.activeSkillId);
  let value: Json;
  try {
    value =
      decision.action === "fetch_knowledge" && decision.payload.trim() === ""
        ? {}
        : JSON.parse(decision.payload);
  } catch {
    throw new Error("Decision payload must be valid JSON");
  }
  if (decision.action === "select_skill") {
    if (skill)
      throw new Error("Complete the active skill before selecting another");
    if (state.selections >= snapshot.config.maxSkillSelections)
      throw new Error("Skill selection limit reached");
    const selected = snapshot.catalog.find((s) => s.id === decision.target);
    if (!selected) throw new Error("Skill is not in the pinned catalog");
    validate(selected.inputSchema, value, "Selected skill input");
  } else if (decision.action === "call_tool") {
    if (!skill) throw new Error("Select a skill before calling a tool");
    const allowed = skill.configuration.allowedToolIds;
    if (!Array.isArray(allowed) || !allowed.includes(decision.target))
      throw new Error("Tool is not allowed by the active skill");
    if (state.toolCalls >= snapshot.config.maxToolCalls)
      throw new Error("Tool call limit reached");
    const tool = snapshot.definition.tools.find(
      (t) => t.id === decision.target,
    );
    if (!tool) throw new Error("Tool missing from snapshot");
    validate(tool.inputSchema, value, "Agent tool input");
    const completedBuilds = request.currentBuilds?.filter((build) => build.state === "completed") ?? [];
    if (tool.handler === "openhands.start_build" && state.revisionPending && completedBuilds.length) {
      throw Error(
        `This review revision already has completed build ${completedBuilds[0].id}. ` +
        "Do not start a fresh build. If code changes are needed, call openhands.revise_build " +
        `with buildId \"${completedBuilds[0].id}\" and the requested changes. ` +
        "If only review or explanation was requested, inspect/reuse the completed build and its existing preview, then request_review again. " +
        "currentBuilds gives the current status; earlier tool outcomes are historical and may show an earlier failure.",
      );
    }
    if (tool.handler === "openhands.revise_build" && value && typeof value === "object" && !Array.isArray(value)) {
      const parent = request.currentBuilds?.find((build) => build.id === value.buildId);
      if (parent && parent.state !== "completed")
        throw Error(`Build ${parent.id} is currently ${parent.state}; revise_build requires a completed parent. Inspect this build or choose a completed build from currentBuilds.`);
      // This bounded list is not a permission catalog. The tool handler checks
      // same-customer ownership for valid parents outside the current session.
    }
  } else if (decision.action === "fetch_knowledge") {
    const allowed = skill?.configuration.allowedKnowledgeIds;
    if (
      !skill ||
      !Array.isArray(allowed) ||
      !allowed.includes(decision.target) ||
      !snapshot.definition.knowledge.some((k) => k.id === decision.target)
    )
      throw new Error("Knowledge is not allowed by the active skill");
    if (state.fetchedKnowledgeIds.includes(decision.target!))
      throw new Error("Knowledge is already in context");
  } else if (decision.action === "complete_skill") {
    if (!skill || decision.target !== skill.id)
      throw new Error("No matching active skill");
    if (missingSkillRequirements(request, snapshot).length)
      throw new Error("Required skill evidence has not been retrieved");
    validate(skill.outputSchema, value, "Selected skill output");
  } else if (decision.action === "final") {
    if (skill || state.completedSkills.length === 0)
      throw new Error(
        "Complete at least one selected skill before final output",
      );
    if (decision.target !== null) throw new Error("Final target must be null");
    validate(snapshot.outputSchema, value, "Agent final output");
  } else if (decision.action === "ask_human") {
    if (!snapshot.config.allowHumanQuestions)
      throw new Error("Human questions are not enabled");
    if (decision.target !== null)
      throw new Error("Question target must be null");
    validate(
      {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 1, maxLength: 4000 },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
      value,
      "Human question",
    );
  } else if (decision.action === "request_review") {
    if (!snapshot.config.allowHumanReview)
      throw new Error("Human review is not enabled");
    if (decision.target !== null) throw new Error("Review target must be null");
  } else throw new Error("Unsupported agent action");
  return value;
}
export function checkPayloadSize(value: unknown, max: number) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > max)
    throw new Error(
      `Reasoning context or result exceeds configured size limit: ${bytes} bytes supplied, ${max} bytes allowed. Shorten text while preserving required fields.`,
    );
}

/** Stored knowledge bodies are fetched on demand, not included in model context.
 * Keep the immutable snapshot intact; fetched results in request still count.
 */
export function checkReasoningContextSize(request: unknown, snapshot: SessionSnapshot) {
  const contextSnapshot = {
    ...snapshot,
    definition: {
      ...snapshot.definition,
      knowledge: snapshot.definition.knowledge.map(k => ({ id: k.id, name: k.name })),
    },
  };
  checkPayloadSize({ request, snapshot: contextSnapshot }, snapshot.config.maxContextBytes);
}
