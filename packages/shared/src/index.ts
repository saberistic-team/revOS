export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Status =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export interface ToolDefinition {
  id: string;
  handler: string;
  inputSchema: Json;
  outputSchema: Json;
}
export interface SkillDefinition {
  id: string;
  instructions: string;
  executionType: "llm" | "tool";
  inputSchema: Json;
  outputSchema: Json;
  configuration: Record<string, Json>;
}
export interface StepDefinition {
  id: string;
  key: string;
  name: string;
  position: number;
  type: "skill" | "human_review";
  configuration: Record<string, Json>;
  skill?: SkillDefinition;
}
export interface ExecutionDefinition {
  workflow: {
    id: string;
    version: number;
    goal: string;
    sopMarkdown: string;
    inputSchema: Json;
    outputSchema: Json;
  };
  agent: { name: string; instructions: string };
  knowledge: { name: string; content: string }[];
  tools: ToolDefinition[];
  steps: StepDefinition[];
}
export interface AgentRunInput {
  runId: string;
  workflowVersionId: string;
  input: Json;
}
export interface StepContext {
  initial: Json;
  previous: Json;
  steps: Record<string, Json>;
}
export interface StepResult {
  runId: string;
  workflowStepId: string;
  status: Status;
  input: Json;
  output?: Json;
  error?: string;
}
export interface Review {
  stepKey: string;
  approved: boolean;
  note?: string;
}
export interface Activities {
  loadExecutionDefinition(input: AgentRunInput): Promise<ExecutionDefinition>;
  markRunRunning(runId: string): Promise<void>;
  markRunWaiting(runId: string): Promise<void>;
  executeSkill(args: {
    skill: SkillDefinition;
    input: Json;
    definition: ExecutionDefinition;
  }): Promise<Json>;
  executeTool(args: {
    tool: ToolDefinition;
    input: Json;
    configuration: Record<string, Json>;
  }): Promise<Json>;
  saveRunStep(args: StepResult): Promise<void>;
  completeRun(args: {
    runId: string;
    output: Json;
    outputSchema: Json;
  }): Promise<void>;
  failRun(args: {
    runId: string;
    error: string;
    cancelled: boolean;
  }): Promise<void>;
}
