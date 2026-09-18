import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  pgEnum,
  check,
  AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Json, ExecutionDefinition } from "../../shared/src";
const id = () => uuid("id").primaryKey().defaultRandom();
const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const schema = (name: string) =>
  jsonb(name).$type<Json>().notNull().default({});
export const status = pgEnum("execution_status", [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export const stepType = pgEnum("step_type", [
  "skill",
  "human_review",
  "agent_loop",
]);
export const executionType = pgEnum("execution_type", ["llm", "tool", "agent"]);
export const organizations = pgTable("organization", {
  kind: text("kind").notNull().default("customer"),
  domain: text("domain").unique(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  id: id(),
  name: text("name").notNull(),
  createdAt: created(),
  updatedAt: updated(),
});
export const agents = pgTable("agent", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  instructions: text("instructions").notNull(),
  createdAt: created(),
  updatedAt: updated(),
});
export const workflows = pgTable(
  "workflow",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => workflowVersions.id,
    ),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("workflow_org_slug").on(t.organizationId, t.slug)],
);
export const workflowVersions = pgTable(
  "workflow_version",
  {
    id: id(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    version: integer("version").notNull(),
    goal: text("goal").notNull(),
    sopMarkdown: text("sop_markdown").notNull(),
    inputSchema: schema("input_schema"),
    outputSchema: schema("output_schema"),
    createdAt: created(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("workflow_version_number").on(t.workflowId, t.version),
    check("positive_workflow_version", sql`${t.version} > 0`),
  ],
);
export const skills = pgTable(
  "skill",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    createdAt: created(),
  },
  (t) => [uniqueIndex("skill_org_slug").on(t.organizationId, t.slug)],
);
export const skillVersions = pgTable(
  "skill_version",
  {
    id: id(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    instructions: text("instructions").notNull(),
    executionType: executionType("execution_type").notNull(),
    inputSchema: schema("input_schema"),
    outputSchema: schema("output_schema"),
    configuration: jsonb("configuration")
      .$type<Record<string, Json>>()
      .notNull()
      .default({}),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("skill_version_number").on(t.skillId, t.version),
    check("positive_skill_version", sql`${t.version} > 0`),
  ],
);
export const workflowSteps = pgTable(
  "workflow_step",
  {
    id: id(),
    workflowVersionId: uuid("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    type: stepType("type").notNull(),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id),
    configuration: jsonb("configuration")
      .$type<Record<string, Json>>()
      .notNull()
      .default({}),
  },
  (t) => [
    uniqueIndex("step_position").on(t.workflowVersionId, t.position),
    uniqueIndex("step_key").on(t.workflowVersionId, t.key),
    check(
      "step_skill_required",
      sql`(${t.type} = 'skill' AND ${t.skillVersionId} IS NOT NULL) OR (${t.type}::text IN ('human_review', 'agent_loop') AND ${t.skillVersionId} IS NULL)`,
    ),
  ],
);
export const tools = pgTable("tool", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  handler: text("handler").notNull(),
  inputSchema: schema("input_schema"),
  outputSchema: schema("output_schema"),
});
export const knowledge = pgTable("knowledge", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Json>().notNull().default({}),
  createdAt: created(),
  updatedAt: updated(),
});
export const tasks = pgTable("task", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id),
  input: schema("input"),
  status: status("status").notNull().default("pending"),
  createdAt: created(),
});
export const runs = pgTable("run", {
  customerOrganizationId: uuid("customer_organization_id").references(
    () => organizations.id,
  ),
  organizationResolution: jsonb("organization_resolution").$type<
    Record<string, any>
  >(),
  id: id(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  workflowVersionId: uuid("workflow_version_id")
    .notNull()
    .references(() => workflowVersions.id),
  temporalWorkflowId: text("temporal_workflow_id").notNull().unique(),
  status: status("status").notNull().default("pending"),
  input: schema("input"),
  output: jsonb("output").$type<Json>(),
  executionDefinition: jsonb(
    "execution_definition",
  ).$type<ExecutionDefinition>(),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: created(),
});
export const runSteps = pgTable(
  "run_step",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    status: status("status").notNull(),
    input: schema("input"),
    output: jsonb("output").$type<Json>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("run_step_once").on(t.runId, t.workflowStepId)],
);
export const corrections = pgTable("correction", {
  id: id(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  runStepId: uuid("run_step_id").references(() => runSteps.id),
  type: text("type").notNull(),
  originalValue: schema("original_value"),
  correctedValue: schema("corrected_value"),
  reason: text("reason").notNull(),
  metadata: schema("metadata"),
  createdAt: created(),
});

export const reasoningSessions = pgTable(
  "reasoning_session",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id),
    input: schema("input"),
    snapshot: jsonb("snapshot")
      .$type<import("../../shared/src/session").SessionSnapshot>()
      .notNull(),
    status: status("status").notNull().default("running"),
    output: jsonb("output").$type<Json>(),
    error: text("error"),
    reviewId: text("review_id"),
    createdAt: created(),
    updatedAt: updated(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("reasoning_session_step").on(t.runId, t.workflowStepId)],
);
export const reasoningTurns = pgTable(
  "reasoning_turn",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => reasoningSessions.id),
    turn: integer("turn").notNull(),
    request: jsonb("request")
      .$type<import("../../shared/src/session").ReasonRequest>()
      .notNull(),
    decision: jsonb("decision")
      .$type<import("../../shared/src/session").AgentDecision>()
      .notNull(),
    outcome: jsonb("outcome").$type<{
      state: import("../../shared/src/session").SessionState;
      result: Json;
    }>(),
    createdAt: created(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("reasoning_turn_once").on(t.sessionId, t.turn),
    check("positive_turn", sql`${t.turn} >= 0`),
  ],
);

export const workflowDrafts = pgTable("workflow_draft", {
  workflowId: uuid("workflow_id")
    .primaryKey()
    .references(() => workflows.id),
  revision: integer("revision").notNull().default(1),
  publishedRevision: integer("published_revision"),
  definition: jsonb("definition")
    .$type<import("../../shared/src/builder").WorkflowDraft>()
    .notNull(),
  updatedAt: updated(),
});

export const artifactJobs = pgTable("artifact_job", {
  id: id(),
  sourceKey: text("source_key").notNull().unique(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  workflowStepId: uuid("workflow_step_id")
    .notNull()
    .references(() => workflowSteps.id),
  sessionId: uuid("session_id").references(() => reasoningSessions.id),
  turn: integer("turn"),
  skillVersionId: uuid("skill_version_id").references(() => skillVersions.id),
  title: text("title").notNull(),
  sourceHash: text("source_hash").notNull(),
  sourceOutput: jsonb("source_output").$type<Json>().notNull(),
  settings: jsonb("settings")
    .$type<import("../../shared/src/outputs").OutputSettings>()
    .notNull(),
  state: text("state").notNull().default("pending"),
  error: text("error"),
  summary: text("summary"),
  providerFiles:
    jsonb("provider_files").$type<
      { containerId: string; fileId: string; filename: string }[]
    >(),
  createdAt: created(),
  updatedAt: updated(),
});
export const artifactFiles = pgTable("artifact_file", {
  id: id(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => artifactJobs.id),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  contentBase64: text("content_base64").notNull(),
  createdAt: created(),
});

export const kbDocuments = pgTable("kb_document", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  title: text("title").notNull(),
  category: text("category").notNull(),
  content: text("content").notNull(),
  evidence: text("evidence").notNull().default("unverified"),
  relatedIds: jsonb("related_ids").$type<string[]>().notNull().default([]),
  provenance: jsonb("provenance").$type<any>().notNull().default({}),
  revision: integer("revision").notNull().default(1),
  fileSha: text("file_sha"),
  commitSha: text("commit_sha"),
  updatedAt: updated(),
  createdAt: created(),
});
export const workspaceChanges = pgTable("workspace_change", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  sourceKey: text("source_key").notNull().unique(),
  kind: text("kind").notNull(),
  targetId: uuid("target_id").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  body: jsonb("body").$type<any>().notNull(),
  before: jsonb("before").$type<any>(),
  baseRevision: integer("base_revision").notNull().default(0),
  provenance: jsonb("provenance").$type<any>().notNull().default({}),
  state: text("state").notNull().default("proposed"),
  error: text("error"),
  commitSha: text("commit_sha"),
  createdAt: created(),
  updatedAt: updated(),
});
export const workspaceThreads = pgTable("workspace_thread", {
  id: id(),
  scope: text("scope")
    .$type<"run" | "library" | "knowledge">()
    .notNull()
    .default("knowledge"),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  title: text("title").notNull(),
  createdAt: created(),
});
export const workspaceMessages = pgTable("workspace_message", {
  id: id(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => workspaceThreads.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<any>().notNull().default({}),
  createdAt: created(),
});
export const workspaceJobs = pgTable("workspace_job", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<any>().notNull(),
  state: text("state").notNull().default("pending"),
  result: jsonb("result").$type<any>(),
  error: text("error"),
  createdAt: created(),
  updatedAt: updated(),
});

export const engagementTemplates = pgTable("engagement_template", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  stages: jsonb("stages")
    .$type<{ name: string; workflowId: string }[]>()
    .notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: created(),
});
export const engagements = pgTable("engagement", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  customerOrganizationId: uuid("customer_organization_id").references(
    () => organizations.id,
  ),
  name: text("name").notNull(),
  state: text("state").notNull().default("running"),
  stages: jsonb("stages").notNull(),
  input: schema("input"),
  stageIndex: integer("stage_index").notNull().default(0),
  error: text("error"),
  createdAt: created(),
  updatedAt: updated(),
});
export const engagementAttempts = pgTable(
  "engagement_attempt",
  {
    id: id(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id),
    stageIndex: integer("stage_index").notNull(),
    revision: integer("revision").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    state: text("state").notNull().default("running"),
    output: jsonb("output"),
    feedback: text("feedback"),
    decisionBy: text("decision_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("engagement_attempt_revision").on(
      t.engagementId,
      t.stageIndex,
      t.revision,
    ),
    uniqueIndex("engagement_attempt_run").on(t.runId),
  ],
);
export const runFeedback = pgTable("run_feedback", {
  id: id(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  content: text("content").notNull(),
  source: text("source").notNull().default("operator"),
  createdAt: created(),
});
export const codeBuilds = pgTable("code_build", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  runId: uuid("run_id").references(() => runs.id),
  sourceKey: text("source_key").notNull().unique(),
  parentId: uuid("parent_id"),
  brief: text("brief").notNull(),
  state: text("state").notNull().default("pending"),
  result: jsonb("result").$type<any>(),
  error: text("error"),
  createdAt: created(),
  updatedAt: updated(),
});
export const productMetadata = pgTable("product_metadata", {
  productId: uuid("product_id").primaryKey().references(() => codeBuilds.id),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  updatedAt: updated(),
});
