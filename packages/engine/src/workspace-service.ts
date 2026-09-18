import {
  collaborationKinds,
  validateCollaborationProposal,
  applyCollaborationProposal,
} from "./collaboration-proposals";
import {
  organizationProducts,
  requireProduct,
  productBodySchema,
} from "./organization-products";
import { createCodeBuild } from "./code-builds";
import { reconcileKnowledge } from "./knowledge-reconciliation";
import { z } from "zod";
import { createWorkflowRun, assertWorkflowAccess } from "./run-service";
import { randomUUID } from "node:crypto";
import { and, eq, desc, asc, or, isNull, sql, inArray } from "drizzle-orm";
import {
  db,
  pool,
  kbDocuments,
  workspaceChanges,
  workspaceThreads,
  workspaceMessages,
  workspaceJobs,
  organizations,
  knowledge,
  workflows,
  workflowDrafts,
  workflowVersions,
  skills,
  skillVersions,
  agents,
  tools,
  runs,
  tasks,
  runSteps,
  reasoningSessions,
  reasoningTurns,
} from "../../database/src";
import {
  knowledgeBodySchema,
  skillBodySchema,
  knowledgeMarkdown,
  resultMarkdown,
} from "../../shared/src/workspace";
import { draftSchema } from "../../shared/src/builder";
import { check, checkPermissions } from "../../../apps/api/src/builder";
import {
  commitDocument,
  ensureRepository,
  readRepositoryDocument,
  forgejo,
  repoPath,
} from "./forgejo";
export async function requireOrg(id: string) {
  if (
    !(await db.select().from(organizations).where(eq(organizations.id, id)))[0]
  )
    throw Error("Organization not found");
}
export async function workspaceContext(org: string) {
  await requireOrg(org);
  const documents = await db
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.organizationId, org))
    .orderBy(desc(kbDocuments.updatedAt));
  const platformIds = (
    await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.kind, "platform"))
  ).map((o) => o.id);
  const catalog = await db
    .select({
      id: skillVersions.id,
      skillId: skills.id,
      name: skills.name,
      description: skills.description,
      version: skillVersions.version,
      instructions: skillVersions.instructions,
      inputSchema: skillVersions.inputSchema,
      outputSchema: skillVersions.outputSchema,
      configuration: skillVersions.configuration,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
    .where(
      or(
        eq(skills.organizationId, org),
        isNull(skills.organizationId),
        inArray(skills.organizationId, platformIds),
      ),
    )
    .orderBy(desc(skillVersions.version));
  const workflowRows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      organizationId: workflows.organizationId,
      publishedVersionId: workflows.currentVersionId,
      publishedInputSchema: workflowVersions.inputSchema,
      revision: workflowDrafts.revision,
      definition: workflowDrafts.definition,
    })
    .from(workflows)
    .leftJoin(workflowDrafts, eq(workflowDrafts.workflowId, workflows.id))
    .leftJoin(
      workflowVersions,
      eq(workflowVersions.id, workflows.currentVersionId),
    )
    .where(
      or(
        eq(workflows.organizationId, org),
        inArray(workflows.organizationId, platformIds),
      ),
    );
  return {
    documents,
    products: await organizationProducts(org),
    skills: catalog,
    workflows: workflowRows,
    agents: await db
      .select()
      .from(agents)
      .where(eq(agents.organizationId, org)),
    tools: await db.select().from(tools),
    knowledge: await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(eq(knowledge.organizationId, org)),
  };
}
export async function createChange(input: {
  organizationId: string;
  kind: string;
  targetId?: string | null;
  title: string;
  reason: string;
  body: any;
  sourceKey?: string;
  provenance?: any;
  state?: string;
  baseRevision?: number;
}) {
  await requireOrg(input.organizationId);
  const targetId = input.targetId || randomUUID();
  let body: any,
    before: any = null,
    baseRevision = 0;
  if (input.kind === "knowledge") {
    body = knowledgeBodySchema.parse(input.body);
    if (body.productId)
      await requireProduct(input.organizationId, body.productId);
    before =
      (
        await db
          .select()
          .from(kbDocuments)
          .where(
            and(
              eq(kbDocuments.id, targetId),
              eq(kbDocuments.organizationId, input.organizationId),
            ),
          )
      )[0] ?? null;
    for (const id of body.relatedIds) {
      if (
        !(
          await db
            .select()
            .from(kbDocuments)
            .where(
              and(
                eq(kbDocuments.id, id),
                eq(kbDocuments.organizationId, input.organizationId),
              ),
            )
        )[0]
      )
        throw Error("Related knowledge is outside this organization");
    }
    baseRevision = before?.revision ?? 0;
  } else if (input.kind === "workflow") {
    body = draftSchema.parse(input.body);
    const w = (
      await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, targetId),
            eq(workflows.organizationId, input.organizationId),
          ),
        )
    )[0];
    const draft = w
      ? (
          await db
            .select()
            .from(workflowDrafts)
            .where(eq(workflowDrafts.workflowId, targetId))
        )[0]
      : null;
    before = draft?.definition ?? null;
    baseRevision = draft?.revision ?? 0;
    await db.transaction((tx) => check(tx, input.organizationId, body));
  } else if (input.kind === "skill") {
    body = skillBodySchema.parse(input.body);
    const s = (
      await db
        .select()
        .from(skills)
        .where(
          and(
            eq(skills.id, targetId),
            eq(skills.organizationId, input.organizationId),
          ),
        )
    )[0];
    before = s
      ? (
          await db
            .select()
            .from(skillVersions)
            .where(eq(skillVersions.skillId, targetId))
            .orderBy(desc(skillVersions.version))
            .limit(1)
        )[0]
      : null;
    baseRevision = before?.version ?? 0;
    await db.transaction((tx) =>
      checkPermissions(tx, input.organizationId, body.configuration),
    );
    const Ajv = (await import("ajv")).default;
    const ajv = new Ajv({ strict: false });
    ajv.compile(body.inputSchema);
    ajv.compile(body.outputSchema);
  } else if (input.kind === "product") {
    body = productBodySchema.parse(input.body);
    const actor = (
      await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
    )[0];
    if (actor.kind !== "customer")
      throw Error("Choose a customer organization to build a product");
    if (body.productId) {
      const product = await requireProduct(
        input.organizationId,
        body.productId,
      );
      if (product.latestBuild && product.latestBuild.state !== "completed")
        throw Error(
          "The latest product build must complete before revising it",
        );
      body.parentBuildId = product.latestBuild?.id;
    }
  } else if (collaborationKinds.includes(input.kind)) {
    if (input.targetId)
      throw Error(
        "Use the dedicated editor to update an existing collaboration record",
      );
    body = await validateCollaborationProposal(
      input.organizationId,
      input.kind,
      input.body,
    );
  } else if (input.kind === "run") {
    body = z
      .object({
        workflowId: z.uuid(),
        input: z.any(),
        customerOrganizationId: z.uuid().nullable().optional(),
      })
      .parse(input.body);
    await assertWorkflowAccess(body.workflowId, input.organizationId);
    const actor = (
      await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
    )[0];
    if (actor.kind !== "platform")
      body.customerOrganizationId = input.organizationId;
    baseRevision = 0;
  } else throw Error("Unsupported proposal kind");
  if (input.targetId && !before)
    throw Error(
      "Target does not exist in this organization or has no editable draft",
    );
  if (input.baseRevision !== undefined && input.baseRevision !== baseRevision)
    throw Error(
      "Content changed while this proposal was being prepared. Refresh and try again.",
    );
  const key = input.sourceKey || randomUUID();
  const [item] = await db
    .insert(workspaceChanges)
    .values({
      organizationId: input.organizationId,
      kind: input.kind,
      targetId,
      title: input.title.slice(0, 200),
      reason: input.reason.slice(0, 12000),
      body,
      before,
      baseRevision,
      sourceKey: key,
      provenance: input.provenance ?? {},
      state: input.state ?? "proposed",
    })
    .onConflictDoNothing()
    .returning();
  return (
    item ||
    (
      await db
        .select()
        .from(workspaceChanges)
        .where(eq(workspaceChanges.sourceKey, key))
    )[0]
  );
}
export async function applyChange(id: string, org: string) {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [
      `workspace:${org}`,
    ]);
    const [c] = await db
      .select()
      .from(workspaceChanges)
      .where(
        and(
          eq(workspaceChanges.id, id),
          eq(workspaceChanges.organizationId, org),
        ),
      );
    if (!c) throw Error("Proposal not found");
    if (c.state === "applied") return c;
    if (!["approved", "applying", "failed"].includes(c.state))
      throw Error("Approve this proposal before applying it");
    await db
      .update(workspaceChanges)
      .set({ state: "applying", error: null, updatedAt: new Date() })
      .where(eq(workspaceChanges.id, id));
    if (c.kind === "knowledge") {
      const [doc] = await db
        .select()
        .from(kbDocuments)
        .where(eq(kbDocuments.id, c.targetId));
      if ((doc?.revision ?? 0) !== c.baseRevision)
        throw Error("Knowledge revision conflict. Review a fresh correction.");
      const body = knowledgeBodySchema.parse(c.body);
      const provenance = {
        ...(doc?.provenance ?? {}),
        ...(!c.sourceKey.startsWith("run-import:")
          ? { humanEdited: true }
          : {}),
        ...c.provenance,
        ...(body.productId !== undefined ? { productId: body.productId } : {}),
        changeId: c.id,
        previousCommit: doc?.commitSha ?? null,
      };
      const next = {
        id: c.targetId,
        ...body,
        provenance,
        revision: c.baseRevision + 1,
      };
      const committed = await commitDocument(
        org,
        c.targetId,
        knowledgeMarkdown(next),
        doc?.fileSha ?? null,
        `revOS: ${c.title} [${c.id}]`,
      );
      await db.transaction(async (tx) => {
        await tx
          .insert(kbDocuments)
          .values({ ...next, organizationId: org, ...committed })
          .onConflictDoUpdate({
            target: kbDocuments.id,
            set: { ...next, ...committed, updatedAt: new Date() },
          });
        await tx
          .insert(knowledge)
          .values({
            id: c.targetId,
            organizationId: org,
            name: body.title,
            type: "repository",
            content: body.content,
            metadata: {
              evidence: body.evidence,
              revision: next.revision,
              commitSha: committed.commitSha,
              provenance,
            },
          })
          .onConflictDoUpdate({
            target: knowledge.id,
            set: {
              name: body.title,
              content: body.content,
              metadata: {
                evidence: body.evidence,
                revision: next.revision,
                commitSha: committed.commitSha,
                provenance,
              },
              updatedAt: new Date(),
            },
          });
        await tx
          .update(workspaceChanges)
          .set({
            state: "applied",
            commitSha: committed.commitSha,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(workspaceChanges.id, id));
      });
    } else if (c.kind === "product") {
      const body = productBodySchema.parse(c.body);
      const priorBuild = (
        await pool.query(
          "SELECT id FROM code_build WHERE source_key=$1 AND organization_id=$2",
          ["product:" + c.id, org],
        )
      ).rows[0];
      if (body.productId && !priorBuild) {
        const product = await requireProduct(org, body.productId);
        if (product.latestBuild?.id !== c.body.parentBuildId)
          throw Error("Product changed; prepare a fresh revision proposal");
      }
      const created = await createCodeBuild(
        org,
        null,
        "product:" + c.id,
        "Product: " + body.name + "\n" + body.brief,
        c.body.parentBuildId as string | undefined,
        { productId: body.productId ?? undefined },
      );
      await db
        .update(workspaceChanges)
        .set({
          state: "applied",
          error: null,
          provenance: {
            ...c.provenance,
            codeBuildId: created.codeBuildId,
            productId: body.productId || created.codeBuildId,
          },
          updatedAt: new Date(),
        })
        .where(eq(workspaceChanges.id, id));
    } else if (collaborationKinds.includes(c.kind)) {
      const created = await applyCollaborationProposal(
        org,
        c.kind,
        c.body,
        c.targetId,
        c.id,
      );
      await db
        .update(workspaceChanges)
        .set({
          state: "applied",
          error: null,
          provenance: { ...c.provenance, recordId: created.id },
          updatedAt: new Date(),
        })
        .where(eq(workspaceChanges.id, id));
    } else if (c.kind === "run") {
      await assertWorkflowAccess(c.body.workflowId as string, org);
      const created = await createWorkflowRun(
        c.body.workflowId as string,
        c.body.input as any,
        undefined,
        c.body.customerOrganizationId as string | undefined,
        c.targetId,
      );
      if ("error" in created) throw Error(created.error);
      await db
        .update(workspaceChanges)
        .set({ state: "applied", error: null, updatedAt: new Date() })
        .where(eq(workspaceChanges.id, id));
    } else
      await db.transaction(async (tx) => {
        if (c.kind === "workflow") {
          const body = draftSchema.parse(c.body);
          await check(tx, org, body);
          const [w] = await tx
            .select()
            .from(workflows)
            .where(eq(workflows.id, c.targetId))
            .for("update");
          if (w && w.organizationId !== org)
            throw Error("Organization mismatch");
          const [d] = await tx
            .select()
            .from(workflowDrafts)
            .where(eq(workflowDrafts.workflowId, c.targetId));
          if ((d?.revision ?? 0) !== c.baseRevision)
            throw Error("Workflow draft changed. Review a fresh proposal.");
          if (!w)
            await tx.insert(workflows).values({
              id: c.targetId,
              organizationId: org,
              name: body.name,
              description: body.description,
              slug: `workflow-${c.targetId}`,
            });
          await tx
            .insert(workflowDrafts)
            .values({ workflowId: c.targetId, definition: body, revision: 1 })
            .onConflictDoUpdate({
              target: workflowDrafts.workflowId,
              set: {
                definition: body,
                revision: c.baseRevision + 1,
                updatedAt: new Date(),
              },
            });
        } else {
          const body = skillBodySchema.parse(c.body);
          await checkPermissions(tx, org, body.configuration);
          const [s] = await tx
            .select()
            .from(skills)
            .where(eq(skills.id, c.targetId))
            .for("update");
          if (s && s.organizationId !== org)
            throw Error("Organization mismatch");
          const [v] = await tx
            .select()
            .from(skillVersions)
            .where(eq(skillVersions.skillId, c.targetId))
            .orderBy(desc(skillVersions.version))
            .limit(1);
          if ((v?.version ?? 0) !== c.baseRevision)
            throw Error("Skill version changed. Review a fresh proposal.");
          if (!s)
            await tx.insert(skills).values({
              id: c.targetId,
              organizationId: org,
              name: body.name,
              description: body.description,
              slug: `skill-${c.targetId}`,
            });
          await tx.insert(skillVersions).values({
            skillId: c.targetId,
            version: c.baseRevision + 1,
            instructions: body.instructions,
            inputSchema: body.inputSchema,
            outputSchema: body.outputSchema,
            executionType: "agent",
            configuration: body.configuration,
          });
        }
        await tx
          .update(workspaceChanges)
          .set({ state: "applied", error: null, updatedAt: new Date() })
          .where(eq(workspaceChanges.id, id));
      });
    return (
      await db
        .select()
        .from(workspaceChanges)
        .where(eq(workspaceChanges.id, id))
    )[0];
  } catch (e) {
    await db
      .update(workspaceChanges)
      .set({ state: "failed", error: String(e), updatedAt: new Date() })
      .where(
        and(
          eq(workspaceChanges.id, id),
          eq(workspaceChanges.organizationId, org),
        ),
      );
    throw e;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `workspace:${org}`,
    ]);
    lock.release();
  }
}
export async function importRun(org: string, runId: string) {
  const [row] = await db
    .select({ run: runs, task: tasks })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.id, runId),
        sql`coalesce(${runs.customerOrganizationId}, ${tasks.organizationId}) = ${org}`,
      ),
    );
  if (!row) throw Error("Run does not belong to this organization");
  const steps = await db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.status, "completed")));
  const sources: any[] = [];
  for (const s of steps) {
    const def = row.run.executionDefinition?.steps.find(
      (d) => d.id === s.workflowStepId,
    );
    sources.push({
      key: s.workflowStepId,
      title: def?.name ?? "Step result",
      output: s.output,
      provenance: {
        runId,
        workflowId: row.task.workflowId,
        workflowStepId: s.workflowStepId,
        kind: "step",
        collectedAt: row.run.createdAt.toISOString(),
      },
    });
  }
  const sessions = await db
    .select()
    .from(reasoningSessions)
    .where(eq(reasoningSessions.runId, runId));
  for (const session of sessions) {
    const turns = await db
      .select()
      .from(reasoningTurns)
      .where(eq(reasoningTurns.sessionId, session.id));
    for (const turn of turns) {
      if (turn.decision.action === "complete_skill" && turn.outcome) {
        const skill = session.snapshot.catalog.find(
          (s) => s.id === turn.decision.target,
        );
        sources.push({
          key: session.id + ":" + turn.turn,
          title: skill?.name ?? "Skill result",
          output: JSON.parse(turn.decision.payload),
          provenance: {
            runId,
            workflowId: row.task.workflowId,
            workflowStepId: session.workflowStepId,
            sessionId: session.id,
            turn: turn.turn,
            skillVersionId: skill?.id,
            kind: "skill",
            collectedAt: row.run.createdAt.toISOString(),
          },
        });
      }
    }
  }
  const imported = [];
  const proposed = [];
  for (const source of sources) {
    const sourceKey = `run-import:${org}:${runId}:${source.key}`;
    const prior = (
      await db
        .select()
        .from(workspaceChanges)
        .where(eq(workspaceChanges.sourceKey, sourceKey))
    )[0];
    if (prior) {
      if (
        prior.state !== "applied" &&
        prior.state !== "proposed" &&
        prior.state !== "rejected"
      )
        await applyChange(prior.id, org);
      (prior.state === "proposed" ? proposed : imported).push(prior.targetId);
      continue;
    }
    const topicKey = `${row.task.workflowId}:${source.provenance.kind}:${source.title}`;
    const existing = (
      await db
        .select()
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.organizationId, org),
            sql`${kbDocuments.provenance}->>'topicKey' = ${topicKey}`,
          ),
        )
        .limit(1)
    )[0];
    const incoming = resultMarkdown(source.output);
    let content = incoming,
      needsReview = false,
      reason = "Import saved workflow evidence; research remains unconfirmed.";
    if (existing) {
      const merged = await reconcileKnowledge(existing.content, incoming);
      if (!merged.addition.trim()) {
        imported.push(existing.id);
        continue;
      }
      content =
        existing.content +
        "\n\n## New workflow findings\n\nSource run: " +
        runId +
        "\n\n" +
        merged.addition;
      needsReview =
        merged.conflict ||
        existing.evidence === "customer_confirmed" ||
        !!existing.provenance.humanEdited ||
        !!existing.provenance.capture ||
        !!existing.provenance.assistantThreadId;
      reason = merged.reason;
      if (content.length > 180000)
        throw Error(
          "Knowledge topic is too large; split it before importing more findings.",
        );
    }
    const change = await createChange({
      organizationId: org,
      kind: "knowledge",
      targetId: existing?.id,
      baseRevision: existing?.revision ?? 0,
      title: source.title,
      reason,
      body: {
        title: source.title,
        category: /lead/i.test(source.title)
          ? "leads"
          : /opportunit/i.test(source.title)
            ? "opportunities"
            : "research",
        content,
        evidence: "researched",
        relatedIds: existing?.relatedIds ?? [],
      },
      sourceKey,
      provenance: {
        ...source.provenance,
        topicKey,
        sourceRuns: [
          ...new Set([
            ...((existing?.provenance.sourceRuns as string[]) || []),
            runId,
          ]),
        ],
      },
      state: needsReview ? "proposed" : "approved",
    });
    if (needsReview) proposed.push(change.id);
    else {
      await applyChange(change.id, org);
      imported.push(change.targetId);
    }
  }
  return {
    documentIds: imported,
    count: imported.length,
    proposalIds: proposed,
  };
}
export async function syncRepository(org: string) {
  await ensureRepository(org);
  const entries = await forgejo(repoPath(org) + "/contents/knowledge?ref=main");
  let count = 0;
  for (const entry of entries ?? []) {
    if (
      entry.type !== "file" ||
      !/^knowledge\/[0-9a-f-]{36}\.md$/.test(entry.path)
    )
      continue;
    const id = entry.path.split("/")[1].slice(0, -3);
    const remote = await readRepositoryDocument(org, id);
    const text = Buffer.from(remote.content, "base64").toString("utf8");
    const match = text.match(
      /^<!-- revos:(.+) -->\n# [^\n]+\n\nEvidence:[^\n]+\n\n([\s\S]*)$/,
    );
    if (!match) continue;
    const meta = JSON.parse(match[1]);
    if (meta.id !== id) throw Error("Repository document ID mismatch");
    const body = knowledgeBodySchema.parse({
      ...meta,
      content: match[2].trim(),
    });
    const [old] = await db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.id, id));
    if (old && old.organizationId !== org)
      throw Error("Repository document belongs to another organization");
    if (old?.fileSha === remote.sha) continue;
    // External edits are imported as unverified and never silently become customer-confirmed.
    const next = {
      id,
      organizationId: org,
      ...body,
      evidence: "unverified",
      revision: (old?.revision ?? 0) + 1,
      provenance: { ...(old?.provenance ?? {}), externalEdit: true },
      fileSha: remote.sha,
      commitSha: remote.last_commit_sha ?? null,
    };
    await db.transaction(async (tx) => {
      await tx
        .insert(kbDocuments)
        .values(next)
        .onConflictDoUpdate({
          target: kbDocuments.id,
          set: { ...next, updatedAt: new Date() },
        });
      await tx
        .insert(knowledge)
        .values({
          id,
          organizationId: org,
          name: body.title,
          type: "repository",
          content: body.content,
          metadata: {
            evidence: "unverified",
            revision: next.revision,
            externalEdit: true,
          },
        })
        .onConflictDoUpdate({
          target: knowledge.id,
          set: {
            name: body.title,
            content: body.content,
            metadata: {
              evidence: "unverified",
              revision: next.revision,
              externalEdit: true,
            },
            updatedAt: new Date(),
          },
        });
    });
    count++;
  }
  return { count };
}
