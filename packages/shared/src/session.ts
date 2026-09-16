import type {
  CatalogSkill,
  ExecutionDefinition,
  Json,
  Status,
  Review,
} from "./index";
export interface AgentDecision {
  action:
    | "select_skill"
    | "fetch_knowledge"
    | "call_tool"
    | "complete_skill"
    | "request_review"
    | "ask_human"
    | "final";
  target: string | null;
  payload: string;
  summary: string;
}
export interface SessionState {
  fetchedKnowledgeIds: string[];
  activeSkillId: string | null;
  activeInput: Json;
  completedSkills: { skillVersionId: string; input: Json; output: Json }[];
  toolCalls: number;
  selections: number;
}
export interface SessionConfig {
  provider: "mock" | "openai";
  model: string;
  maxTurns: number;
  maxToolCalls: number;
  maxSkillSelections: number;
  maxContextBytes: number;
  maxOutputTokens: number;
  allowHumanReview: boolean;
  allowHumanQuestions?: boolean;
  mockDecisions: AgentDecision[];
}
export interface SessionSnapshot {
  stepGoal?: string;
  definition: ExecutionDefinition;
  catalog: CatalogSkill[];
  outputSchema: Json;
  config: SessionConfig;
}
export interface SessionEvent {
  turn: number;
  decision: AgentDecision;
  result: Json;
}
export interface ReasonRequest {
  validationFeedback?: { error: string; previousDecision: AgentDecision };
  sessionId: string;
  turn: number;
  input: Json;
  state: SessionState;
  events: SessionEvent[];
}
export interface HumanAnswer {
  stepKey: string;
  questionId: string;
  answer: string;
}
export interface SessionActivities {
  prepareHumanQuestion(args: {
    sessionId: string;
    turn: number;
  }): Promise<{ question: string; options?: string[] }>;
  openReasoningSession(args: {
    runId: string;
    workflowStepId: string;
    input: Json;
  }): Promise<{ id: string; config: SessionConfig }>;
  reason(args: { sessionId: string; turn: number }): Promise<AgentDecision>;
  applyAgentDecision(args: {
    sessionId: string;
    turn: number;
    review?: Review;
    answer?: HumanAnswer;
  }): Promise<{ state: SessionState; result: Json }>;
  fetchSessionKnowledge(args: {
    sessionId: string;
    turn: number;
  }): Promise<{ state: SessionState; result: Json }>;
  executeSessionTool(args: {
    sessionId: string;
    turn: number;
  }): Promise<{ state: SessionState; result: Json }>;
  setSessionStatus(args: {
    sessionId: string;
    status: Status;
    error?: string;
    output?: Json;
    reviewId?: string | null;
  }): Promise<void>;
}
export function initialSessionState(): SessionState {
  return {
    fetchedKnowledgeIds: [],
    activeSkillId: null,
    activeInput: null,
    completedSkills: [],
    toolCalls: 0,
    selections: 0,
  };
}
