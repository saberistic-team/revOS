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
export const stepType = pgEnum("step_type", ["skill", "human_review"]);
export const executionType = pgEnum("execution_type", ["llm", "tool"]);
export const organizations = pgTable("organization", {
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
      sql`(${t.type} = 'skill' AND ${t.skillVersionId} IS NOT NULL) OR (${t.type} = 'human_review' AND ${t.skillVersionId} IS NULL)`,
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
