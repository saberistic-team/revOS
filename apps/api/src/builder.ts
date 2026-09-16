import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import Ajv from "ajv";
import { eq, and, or, isNull, asc, desc, sql } from "drizzle-orm";
import {
  db,
  workflows,
  workflowVersions,
  workflowSteps,
  workflowDrafts,
  organizations,
  agents,
  skills,
  skillVersions,
  tools,
  knowledge,
  tasks,
  runs,
} from "../../../packages/database/src";
import {
  draftSchema,
  type WorkflowDraft,
} from "../../../packages/shared/src/builder";
import { sessionConfig } from "../../../packages/engine/src/agent-policy";
import { validate } from "../../../packages/engine/src";
import { webResearchDefinition } from "../../../packages/engine/src/web-research";
import type { Json } from "../../../packages/shared/src";
const ajv = new Ajv({ strict: false });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    fail(
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  return r.data;
}
function contract(s: unknown) {
  try {
    ajv.compile(s as object);
  } catch (e) {
    fail(`Invalid JSON schema: ${String(e)}`);
  }
}
async function check(tx: Tx, org: string, d: WorkflowDraft) {
  if (!d.goal.trim() || !d.instructions.trim() || !d.steps.length)
    fail("Add a goal, instructions, and at least one step");
  contract(d.inputSchema);
  contract(d.outputSchema);
  const [agent] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, d.agentId), eq(agents.organizationId, org)));
  if (!agent) fail("Choose an agent belonging to this organization");
  const seen = new Set<string>();
  for (const s of d.steps) {
    if (seen.has(s.key)) fail(`Duplicate step key: ${s.key}`);
    const source = s.configuration.inputFrom ?? "previous";
    if (
      !["previous", "initial", "context"].includes(source) &&
      !(
        typeof source === "string" &&
        source.startsWith("steps.") &&
        seen.has(source.slice(6))
      )
    )
      fail(`Invalid input source for ${s.name}`);
    seen.add(s.key);
    const ids =
      s.type === "agent_loop"
        ? s.configuration.skillVersionIds
        : s.type === "skill"
          ? [s.skillVersionId]
          : [];
    if (s.type !== "skill" && s.skillVersionId !== null)
      fail("Only fixed skill steps have a skillVersionId");
    if (
      !Array.isArray(ids) ||
      (s.type !== "human_review" && (!ids.length || ids.length > 20))
    )
      fail(`Choose 1–20 skills for ${s.name}`);
    for (const id of ids) {
      if (!z.uuid().safeParse(id).success) fail("Invalid skill version ID");
      const [row] = await tx
        .select()
        .from(skillVersions)
        .innerJoin(skills, eq(skills.id, skillVersions.skillId))
        .where(eq(skillVersions.id, id));
      if (
        !row ||
        (row.skill.organizationId && row.skill.organizationId !== org)
      )
        fail("Skill is outside the organization catalog");
      if (row.skill_version.executionType !== "agent")
        fail(
          "Builder steps currently require agent skills so all model execution uses OpenAI",
        );
      contract(row.skill_version.inputSchema);
      contract(row.skill_version.outputSchema);
      await checkPermissions(tx, org, row.skill_version.configuration);
    }
    if (s.type !== "human_review") {
      if (s.configuration.provider !== "openai")
        fail("Builder workflows must use OpenAI");
      sessionConfig(s.configuration);
      if (s.configuration.outputSchema) contract(s.configuration.outputSchema);
    }
  }
}
async function checkPermissions(tx: Tx, org: string, c: Record<string, any>) {
  for (const [required, allowed] of [
    ["requiredKnowledgeIds", "allowedKnowledgeIds"],
    ["requiredToolIds", "allowedToolIds"],
  ]) {
    if (
      c[required] !== undefined &&
      (!Array.isArray(c[required]) ||
        c[required].some((id: unknown) => !(c[allowed] ?? []).includes(id)))
    )
      fail(`${required} must be a subset of ${allowed}`);
  }
  if (
    !Array.isArray(c.allowedToolIds ?? []) ||
    !Array.isArray(c.allowedKnowledgeIds ?? [])
  )
    fail("Permission lists must be arrays");
  for (const id of c.allowedToolIds ?? []) {
    if (!z.uuid().safeParse(id).success) fail("Invalid tool ID");
    if (!(await tx.select().from(tools).where(eq(tools.id, id))).length)
      fail("Unknown registered tool");
  }
  for (const id of c.allowedKnowledgeIds ?? []) {
    if (!z.uuid().safeParse(id).success) fail("Invalid knowledge ID");
    if (
      !(
        await tx
          .select()
          .from(knowledge)
          .where(and(eq(knowledge.id, id), eq(knowledge.organizationId, org)))
      ).length
    )
      fail("Knowledge is outside this organization");
  }
}
async function lock(tx: Tx, id: string) {
  const [w] = await tx
    .select()
    .from(workflows)
    .where(eq(workflows.id, id))
    .for("update");
  if (!w) fail("Workflow not found", 404);
  return w;
}
async function getDraft(tx: Tx, w: typeof workflows.$inferSelect) {
  const [existing] = await tx
    .select()
    .from(workflowDrafts)
    .where(eq(workflowDrafts.workflowId, w.id));
  if (existing) return existing;
  const [agent] = await tx
    .select()
    .from(agents)
    .where(eq(agents.organizationId, w.organizationId))
    .orderBy(asc(agents.createdAt));
  if (!agent) fail("Create an agent for this organization first");
  const [v] = w.currentVersionId
    ? await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, w.currentVersionId))
    : [];
  const steps = v
    ? await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowVersionId, v.id))
        .orderBy(asc(workflowSteps.position))
    : [];
  const definition: WorkflowDraft = {
    name: w.name,
    description: w.description,
    agentId: agent.id,
    goal: v?.goal ?? "",
    instructions: v?.sopMarkdown ?? "",
    inputSchema: (v?.inputSchema ?? { type: "object" }) as any,
    outputSchema: (v?.outputSchema ?? { type: "object" }) as any,
    steps: steps.map((s) => ({
      key: s.key,
      name: s.name,
      type: s.type,
      skillVersionId: s.skillVersionId,
      configuration: s.configuration,
    })),
  };
  const [saved] = await tx
    .insert(workflowDrafts)
    .values({ workflowId: w.id, definition })
    .returning();
  return saved;
}
async function version(
  tx: Tx,
  w: typeof workflows.$inferSelect,
  d: WorkflowDraft,
  rev: number,
) {
  const [last] = await tx
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, w.id))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  const [v] = await tx
    .insert(workflowVersions)
    .values({
      workflowId: w.id,
      version: (last?.version ?? 0) + 1,
      goal: d.goal,
      sopMarkdown: d.instructions,
      inputSchema: d.inputSchema as Json,
      outputSchema: d.outputSchema as Json,
      createdBy: `builder:${d.agentId}:draft-${rev}`,
    })
    .returning();
  await tx.insert(workflowSteps).values(
    d.steps.map((s, position) => ({
      ...s,
      workflowVersionId: v.id,
      position,
      configuration: { ...s.configuration, builderAgentId: d.agentId },
    })),
  );
  return v;
}
export function registerBuilder(
  app: FastifyInstance,
  start: (run: typeof runs.$inferSelect) => Promise<void>,
) {
  const wrap = (fn: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      return await fn(r);
    } catch (e: any) {
      if (e.statusCode)
        return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  };
  app.post(
    "/builder/organizations",
    wrap(async (r) => {
      const b = parse(
        z.object({ name: z.string().trim().min(1).max(160) }),
        r.body,
      );
      const [item] = await db.insert(organizations).values(b).returning();
      return item;
    }),
  );
  app.post(
    "/builder/agents",
    wrap(async (r) => {
      const b = parse(
        z.object({
          organizationId: z.uuid(),
          name: z.string().trim().min(1).max(160),
          description: z.string().max(2000).default(""),
          instructions: z.string().trim().min(1).max(30000),
        }),
        r.body,
      );
      if (
        !(
          await db
            .select()
            .from(organizations)
            .where(eq(organizations.id, b.organizationId))
        ).length
      )
        fail("Organization not found");
      const [item] = await db.insert(agents).values(b).returning();
      return item;
    }),
  );
  app.post(
    "/builder/tools/enable",
    wrap(async (r) => {
      // Only adapters shipped with the worker can be enabled; never arbitrary code.
      parse(
        z.object({ slug: z.literal("openai-web-research") }).strict(),
        r.body,
      );
      const [tool] = await db
        .insert(tools)
        .values(webResearchDefinition)
        .onConflictDoNothing({ target: tools.slug })
        .returning();
      return (
        tool ??
        (
          await db
            .select()
            .from(tools)
            .where(eq(tools.slug, webResearchDefinition.slug))
        )[0]
      );
    }),
  );
  app.get(
    "/builder/catalog",
    wrap(async () => ({
      organizations: await db.select().from(organizations),
      agents: await db.select().from(agents),
      skills: await db
        .select({
          id: skillVersions.id,
          skillId: skills.id,
          organizationId: skills.organizationId,
          name: skills.name,
          description: skills.description,
          version: skillVersions.version,
          executionType: skillVersions.executionType,
          instructions: skillVersions.instructions,
          inputSchema: skillVersions.inputSchema,
          outputSchema: skillVersions.outputSchema,
          configuration: skillVersions.configuration,
        })
        .from(skillVersions)
        .innerJoin(skills, eq(skillVersions.skillId, skills.id))
        .orderBy(desc(skillVersions.version)),
      tools: await db.select().from(tools),
      knowledge: await db.select().from(knowledge),
    })),
  );
  app.get(
    "/builder/workflows",
    wrap(async () =>
      db
        .select({ workflow: workflows, draft: workflowDrafts })
        .from(workflows)
        .leftJoin(workflowDrafts, eq(workflows.id, workflowDrafts.workflowId))
        .orderBy(desc(workflows.updatedAt)),
    ),
  );
  app.post(
    "/builder/workflows",
    wrap(async (r) => {
      const b = parse(
        z.object({
          organizationId: z.uuid(),
          name: z.string().trim().min(1).max(160),
          duplicateId: z.uuid().optional(),
        }),
        r.body,
      );
      return db.transaction(async (tx) => {
        if (
          !(
            await tx
              .select()
              .from(organizations)
              .where(eq(organizations.id, b.organizationId))
          ).length
        )
          fail("Organization not found");
        let source: WorkflowDraft | undefined;
        if (b.duplicateId) {
          const w = await lock(tx, b.duplicateId);
          if (w.organizationId !== b.organizationId)
            fail("Duplicate within the same organization");
          source = (await getDraft(tx, w)).definition;
        }
        const [w] = await tx
          .insert(workflows)
          .values({
            organizationId: b.organizationId,
            name: b.name,
            slug: `workflow-${randomUUID()}`,
          })
          .returning();
        const d = await getDraft(tx, w);
        if (source) {
          const [copied] = await tx
            .update(workflowDrafts)
            .set({ definition: { ...source, name: b.name } })
            .where(eq(workflowDrafts.workflowId, w.id))
            .returning();
          return { workflow: w, draft: copied };
        }
        return { workflow: w, draft: d };
      });
    }),
  );
  app.get(
    "/builder/workflows/:id",
    wrap(async (r) =>
      db.transaction(async (tx) => {
        const w = await lock(tx, parse(z.uuid(), r.params.id));
        return {
          workflow: w,
          draft: await getDraft(tx, w),
          versions: await tx
            .select()
            .from(workflowVersions)
            .where(eq(workflowVersions.workflowId, w.id))
            .orderBy(desc(workflowVersions.version)),
        };
      }),
    ),
  );
  app.put(
    "/builder/workflows/:id",
    wrap(async (r) => {
      const b = parse(
        z.object({
          revision: z.number().int().positive(),
          definition: draftSchema,
        }),
        r.body,
      );
      return db.transaction(async (tx) => {
        const w = await lock(tx, parse(z.uuid(), r.params.id));
        const d = await getDraft(tx, w);
        if (d.revision !== b.revision)
          fail("Draft changed in another editor. Reload before saving.", 409);
        if (!w.currentVersionId)
          await tx
            .update(workflows)
            .set({
              name: b.definition.name,
              description: b.definition.description,
              updatedAt: new Date(),
            })
            .where(eq(workflows.id, w.id));
        const [saved] = await tx
          .update(workflowDrafts)
          .set({
            definition: b.definition,
            revision: d.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(workflowDrafts.workflowId, w.id))
          .returning();
        return { workflow: w, draft: saved };
      });
    }),
  );
  for (const action of ["validate", "publish", "test"] as const)
    app.post(
      `/builder/workflows/:id/${action}`,
      wrap(async (r) => {
        const b = parse(
          z.object({
            revision: z.number().int().positive(),
            input: z.any().optional(),
            testedRunId: z.uuid().optional(),
          }),
          r.body,
        );
        const result = await db.transaction(async (tx) => {
          const w = await lock(tx, parse(z.uuid(), r.params.id));
          const d = await getDraft(tx, w);
          if (d.revision !== b.revision)
            fail("Draft changed; reload before continuing.", 409);
          await check(tx, w.organizationId, d.definition);
          if (action === "validate") return { valid: true };
          if (action === "publish" && d.publishedRevision === d.revision)
            return { versionId: w.currentVersionId, alreadyPublished: true };
          if (action === "test") {
            try {
              validate(d.definition.inputSchema as Json, b.input, "Test input");
            } catch (e) {
              fail(String(e));
            }
          }
          let v;
          if (action === "publish" && b.testedRunId) {
            const [tested] = await tx
              .select({ run: runs, version: workflowVersions })
              .from(runs)
              .innerJoin(
                workflowVersions,
                eq(runs.workflowVersionId, workflowVersions.id),
              )
              .where(eq(runs.id, b.testedRunId));
            if (
              !tested ||
              tested.run.status !== "completed" ||
              tested.version.workflowId !== w.id ||
              tested.version.createdBy !==
                `builder:${d.definition.agentId}:draft-${d.revision}`
            )
              fail(
                "Choose a completed test of this exact saved draft revision",
                409,
              );
            v = tested.version;
          } else {
            // Repeated tests of an unchanged draft share one immutable snapshot.
            if (action === "test")
              [v] = await tx
                .select()
                .from(workflowVersions)
                .where(
                  and(
                    eq(workflowVersions.workflowId, w.id),
                    eq(
                      workflowVersions.createdBy,
                      `builder:${d.definition.agentId}:draft-${d.revision}`,
                    ),
                  ),
                )
                .orderBy(desc(workflowVersions.version))
                .limit(1);
            v ??= await version(tx, w, d.definition, d.revision);
          }
          if (action === "publish") {
            await tx
              .update(workflows)
              .set({
                currentVersionId: v.id,
                name: d.definition.name,
                description: d.definition.description,
                updatedAt: new Date(),
              })
              .where(eq(workflows.id, w.id));
            await tx
              .update(workflowDrafts)
              .set({ publishedRevision: d.revision })
              .where(eq(workflowDrafts.workflowId, w.id));
            return { versionId: v.id, version: v.version };
          }
          const [task] = await tx
            .insert(tasks)
            .values({
              organizationId: w.organizationId,
              agentId: d.definition.agentId,
              workflowId: w.id,
              input: b.input,
            })
            .returning();
          const id = randomUUID();
          const [run] = await tx
            .insert(runs)
            .values({
              id,
              taskId: task.id,
              workflowVersionId: v.id,
              temporalWorkflowId: `run:${id}`,
              input: b.input,
            })
            .returning();
          return { run };
        });
        if ("run" in result && result.run) {
          try {
            await start(result.run);
          } catch (e) {
            app.log.error({ err: e }, "Draft test dispatch pending");
          }
        }
        return result;
      }),
    );
  app.post(
    "/builder/skills",
    wrap(async (r) => {
      const b = parse(
        z.object({
          organizationId: z.uuid(),
          skillId: z.uuid().optional(),
          name: z.string().trim().min(1).max(160),
          description: z.string().max(2000),
          instructions: z.string().trim().min(1).max(30000),
          inputSchema: z.record(z.string(), z.any()),
          outputSchema: z.record(z.string(), z.any()),
          configuration: z
            .object({
              allowedToolIds: z.array(z.uuid()).max(50),
              allowedKnowledgeIds: z.array(z.uuid()).max(50),
              toolConfigurations: z.record(z.string(), z.any()).optional(),
            })
            .passthrough(),
        }),
        r.body,
      );
      contract(b.inputSchema);
      contract(b.outputSchema);
      return db.transaction(async (tx) => {
        if (
          !(
            await tx
              .select()
              .from(organizations)
              .where(eq(organizations.id, b.organizationId))
          ).length
        )
          fail("Organization not found");
        await checkPermissions(tx, b.organizationId, b.configuration);
        let skill;
        if (b.skillId) {
          [skill] = await tx
            .select()
            .from(skills)
            .where(eq(skills.id, b.skillId))
            .for("update");
          if (!skill || skill.organizationId !== b.organizationId)
            fail("Skill not editable in this organization");
        } else
          [skill] = await tx
            .insert(skills)
            .values({
              organizationId: b.organizationId,
              name: b.name,
              description: b.description,
              slug: `skill-${randomUUID()}`,
            })
            .returning();
        const [last] = await tx
          .select()
          .from(skillVersions)
          .where(eq(skillVersions.skillId, skill.id))
          .orderBy(desc(skillVersions.version))
          .limit(1);
        const [v] = await tx
          .insert(skillVersions)
          .values({
            skillId: skill.id,
            version: (last?.version ?? 0) + 1,
            executionType: "agent",
            instructions: b.instructions,
            inputSchema: b.inputSchema,
            outputSchema: b.outputSchema,
            configuration: b.configuration as Record<string, Json>,
          })
          .returning();
        return v;
      });
    }),
  );
  app.post(
    "/builder/knowledge",
    wrap(async (r) => {
      const b = parse(
        z.object({
          id: z.uuid().optional(),
          organizationId: z.uuid(),
          name: z.string().trim().min(1).max(160),
          content: z.string().min(1).max(100000),
        }),
        r.body,
      );
      if (
        !(
          await db
            .select()
            .from(organizations)
            .where(eq(organizations.id, b.organizationId))
        ).length
      )
        fail("Organization not found");
      if (b.id) {
        const [k] = await db
          .update(knowledge)
          .set({ name: b.name, content: b.content, updatedAt: new Date() })
          .where(
            and(
              eq(knowledge.id, b.id),
              eq(knowledge.organizationId, b.organizationId),
            ),
          )
          .returning();
        if (!k) fail("Knowledge not found", 404);
        return k;
      }
      const [k] = await db
        .insert(knowledge)
        .values({ ...b, type: "reference" })
        .returning();
      return k;
    }),
  );
}
