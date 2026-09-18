import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as database from "../packages/database/src";
import {
  resolveAssistantContext,
  selectedContextMessage,
} from "../packages/engine/src/assistant-context";
import {
  assistantContextSchema,
  assertContextScope,
} from "../packages/shared/src/assistant-context";
import { knowledgeFingerprint } from "../packages/shared/src/mindmap";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = {
  org: uuid(1),
  other: uuid(2),
  platform: uuid(3),
  workflow: uuid(4),
  sharedWorkflow: uuid(5),
  otherWorkflow: uuid(6),
  run: uuid(7),
  otherRun: uuid(8),
  step: uuid(9),
  engagement: uuid(10),
  otherEngagement: uuid(11),
  attempt: uuid(12),
  build: uuid(13),
  otherBuild: uuid(14),
  product: uuid(15),
  otherProduct: uuid(16),
  document: uuid(17),
  otherDocument: uuid(18),
  chain: uuid(19),
  otherChain: uuid(20),
  skill: uuid(21),
  skillV1: uuid(22),
  skillV2: uuid(23),
  otherSkill: uuid(24),
  otherSkillVersion: uuid(25),
  sharedSkill: uuid(26),
  sharedSkillVersion: uuid(27),
  tool: uuid(28),
  knowledge: uuid(29),
  otherKnowledge: uuid(30),
  job: uuid(31),
  unbuiltProduct: uuid(32),
  campaign: uuid(33),
  otherCampaign: uuid(34),
};
type Row = Record<string, any>;
const schemaTables = [
  database.organizations,
  database.workflows,
  database.workflowDrafts,
  database.runs,
  database.tasks,
  database.engagements,
  database.engagementAttempts,
  database.codeBuilds,
  database.kbDocuments,
  database.engagementTemplates,
  database.skills,
  database.skillVersions,
  database.tools,
  database.knowledge,
  database.workspaceJobs,
  database.productMetadata,
];
const columns = new Map<string, Set<string>>(
  schemaTables.map((table) => [
    getTableName(table),
    new Set(Object.values(getTableColumns(table)).map((column) => column.name)),
  ]),
);
// Additive platform tables are managed by SQL migration0011.
columns.get("code_build")!.add("product_id");
columns.set(
  "platform_product",
  new Set([
    "id",
    "organization_id",
    "name",
    "description",
    "owner_person_id",
    "repository_url",
    "runtime_kind",
    "state",
    "revision",
    "created_at",
    "updated_at",
  ]),
);
columns.set(
  "platform_campaign",
  new Set([
    "id",
    "organization_id",
    "product_id",
    "name",
    "objective",
    "success_measure",
    "owner_person_id",
    "stakeholder_ids",
    "state",
    "engagement_id",
    "revision",
  ]),
);

columns.set(
  "product_release",
  new Set(["product_id", "environment", "state", "url"]),
);
function fixture(t: TestContext) {
  const date = new Date("2026-09-17T12:00:00Z");
  const doc = {
    id: id.document,
    organization_id: id.org,
    title: "Customer evidence",
    category: "research",
    content: "Verified customer research",
    evidence: "researched",
    related_ids: [],
    provenance: {},
    revision: 4,
    created_at: date,
    updated_at: date,
  };
  const rows: Record<string, Row[]> = {
    organization: [
      { id: id.org, name: "Customer", kind: "customer" },
      { id: id.other, name: "Other customer", kind: "customer" },
      { id: id.platform, name: "Platform", kind: "platform" },
    ],
    workflow: [
      { id: id.workflow, name: "Discovery", organization_id: id.org },
      {
        id: id.sharedWorkflow,
        name: "Shared process",
        organization_id: id.platform,
      },
      {
        id: id.otherWorkflow,
        name: "Other process",
        organization_id: id.other,
      },
    ],
    workflow_draft: [
      {
        workflow_id: id.workflow,
        revision: 3,
        definition: {
          steps: [{ key: "research", name: "Current draft step" }],
        },
      },
      {
        workflow_id: id.sharedWorkflow,
        revision: 2,
        definition: { steps: [] },
      },
    ],
    task: [
      { id: uuid(100), workflow_id: id.workflow, organization_id: id.org },
      {
        id: uuid(101),
        workflow_id: id.otherWorkflow,
        organization_id: id.other,
      },
    ],
    run: [
      {
        id: id.run,
        task_id: uuid(100),
        status: "waiting",
        customer_organization_id: id.org,
        execution_definition: {
          steps: [{ id: id.step, key: "research", name: "Pinned run step" }],
        },
      },
      {
        id: id.otherRun,
        task_id: uuid(101),
        status: "running",
        customer_organization_id: id.other,
        execution_definition: { steps: [] },
      },
    ],
    engagement: [
      {
        id: id.engagement,
        name: "Customer journey",
        organization_id: id.org,
        customer_organization_id: id.org,
        stage_index: 1,
        stages: [{ name: "Understand" }, { name: "Research" }],
        state: "running",
      },
      {
        id: id.otherEngagement,
        name: "Other journey",
        organization_id: id.other,
        customer_organization_id: id.other,
        stage_index: 0,
        stages: [{ name: "Understand" }],
        state: "running",
      },
    ],
    engagement_attempt: [
      {
        id: id.attempt,
        engagement_id: id.engagement,
        run_id: id.run,
        stage_index: 1,
        revision: 2,
        state: "running",
      },
    ],
    code_build: [
      {
        id: id.product,
        organization_id: id.org,
        run_id: id.run,
        parent_id: null,
        brief: "Product: Evidence map",
        state: "completed",
        result: { previewUrl: "http://localhost:3002/first/" },
        error: null,
        created_at: date,
      },
      {
        id: id.build,
        organization_id: id.org,
        run_id: id.run,
        parent_id: id.product,
        brief: "Improve labels",
        state: "completed",
        result: { previewUrl: "http://localhost:3002/second/" },
        error: null,
        created_at: date,
      },
      {
        id: id.otherBuild,
        organization_id: id.other,
        run_id: id.otherRun,
        parent_id: null,
        brief: "Other product",
        state: "completed",
        result: {},
        error: null,
        created_at: date,
      },
      {
        id: id.otherProduct,
        organization_id: id.org,
        run_id: id.run,
        parent_id: null,
        brief: "Different product",
        state: "completed",
        result: {},
        error: null,
        created_at: date,
      },
    ],
    kb_document: [
      doc,
      {
        ...doc,
        id: id.otherDocument,
        organization_id: id.other,
        title: "Other evidence",
      },
    ],
    engagement_template: [
      {
        id: id.chain,
        organization_id: id.org,
        name: "Chain",
        stages: [],
        revision: 5,
      },
      {
        id: id.otherChain,
        organization_id: id.other,
        name: "Other chain",
        stages: [],
        revision: 1,
      },
    ],
    skill: [
      {
        id: id.skill,
        organization_id: id.org,
        name: "Research",
        description: "Find evidence",
      },
      { id: id.otherSkill, organization_id: id.other, name: "Other research" },
      {
        id: id.sharedSkill,
        organization_id: id.platform,
        name: "Shared research",
      },
    ],
    skill_version: [
      {
        id: id.skillV1,
        skill_id: id.skill,
        version: 1,
        instructions: "Old exact instructions",
        configuration: { allowedToolIds: [] },
        input_schema: { type: "object", required: ["old_input"] },
        output_schema: { type: "object" },
      },
      {
        id: id.skillV2,
        skill_id: id.skill,
        version: 2,
        instructions: "Latest instructions",
        configuration: { allowedToolIds: [id.tool] },
        input_schema: { type: "object", required: ["new_input"] },
        output_schema: { type: "object" },
      },
      {
        id: id.otherSkillVersion,
        skill_id: id.otherSkill,
        version: 1,
        instructions: "Other tenant",
        configuration: {},
      },
      {
        id: id.sharedSkillVersion,
        skill_id: id.sharedSkill,
        version: 1,
        instructions: "Shared",
        configuration: {},
      },
    ],
    tool: [
      {
        id: id.tool,
        name: "Web research",
        description: "Research sources",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
    ],
    knowledge: [
      {
        id: id.knowledge,
        organization_id: id.org,
        name: "Methodology",
        type: "reference",
        content: "Cite evidence",
      },
      {
        id: id.otherKnowledge,
        organization_id: id.other,
        name: "Other reference",
        type: "reference",
        content: "Private",
      },
    ],
    product_metadata: [
      {
        product_id: id.product,
        organization_id: id.org,
        name: "Research map",
        description: "Customer preview",
        revision: 1,
      },
    ],
    platform_product: [
      {
        id: id.product,
        organization_id: id.org,
        name: "Research map",
        description: "Customer preview",
        revision: 1,
        created_at: date,
      },
      {
        id: id.otherProduct,
        organization_id: id.org,
        name: "Different product",
        description: "",
        revision: 1,
        created_at: date,
      },
      {
        id: id.otherBuild,
        organization_id: id.other,
        name: "Other product",
        description: "",
        revision: 1,
        created_at: date,
      },
      {
        id: id.unbuiltProduct,
        organization_id: id.org,
        name: "New service",
        description: "Awaiting the first build",
        revision: 1,
        created_at: date,
      },
    ],
    workspace_job: [],
    product_release: [],
    platform_campaign: [
      {
        id: id.campaign,
        organization_id: id.org,
        product_id: id.product,
        name: "Qualification",
        objective: "Improve lead qualification",
        success_measure: "Approved criteria",
        owner_person_id: null,
        stakeholder_ids: [],
        state: "draft",
        engagement_id: null,
        revision: 2,
      },
      {
        id: id.otherCampaign,
        organization_id: id.other,
        product_id: id.otherBuild,
        name: "Private campaign",
        objective: "Other",
        revision: 1,
      },
    ],
  };
  rows.workspace_job.push({
    id: id.job,
    organization_id: id.org,
    kind: "mindmap",
    state: "completed",
    payload: {
      fingerprint: "semantic-map-v1:" + knowledgeFingerprint([doc]),
      documents: [{ id: id.document }],
      model: "fixture",
    },
    result: {
      graph: {
        title: "Customer map",
        summary: "Evidence",
        nodes: [
          {
            id: "market",
            label: "Market",
            summary: "Existing market evidence",
            theme: "research",
            evidence: "researched",
            sourceIds: [id.document],
          },
          {
            id: "deleted",
            label: "Removed evidence",
            summary: "No longer valid",
            theme: "research",
            evidence: "researched",
            sourceIds: [uuid(999)],
          },
        ],
        edges: [],
      },
    },
    error: null,
    created_at: date,
    updated_at: date,
  });
  const queries: { sql: string; values: any[] }[] = [];
  t.mock.method(
    database.pool,
    "query",
    async (query: any, values: any[] = []) => {
      const sql = typeof query === "string" ? query : query.text;
      const params = values || query.values || [];
      queries.push({ sql, values: params });
      assert.match(
        sql.trim(),
        /^select\b/i,
        "Context resolution must only read saved data",
      );
      const tableMatch = sql.match(/\bFROM\s+"?([a-z_]+)"?/i);
      assert.ok(tableMatch, "A real database table must be selected");
      const table = tableMatch[1];
      assert.ok(columns.has(table), "Known schema table: " + table);
      // The mock must not provide tenant filtering that the actual query omits.
      if (table === "run")
        assert.match(
          sql,
          /t\.organization_id\s*=\s*\$2\s+OR\s+r\.customer_organization_id\s*=\s*\$2/i,
        );
      if (table === "workflow")
        assert.match(
          sql,
          /w\.organization_id\s*=\s*\$2\s+OR\s+o\.kind\s*=\s*'platform'/i,
        );
      if (table === "engagement")
        assert.match(
          sql,
          /organization_id\s*=\s*\$2\s+OR\s+customer_organization_id\s*=\s*\$2/i,
        );
      if (table === "skill_version") {
        assert.match(sql, /WHERE\s+v\.id\s*=\s*\$1/i);
        assert.match(
          sql,
          /s\.organization_id\s*=\s*\$2\s+OR\s+s\.organization_id\s+IS\s+NULL\s+OR\s+o\.kind\s*=\s*'platform'/i,
        );
      }
      if (
        [
          "kb_document",
          "engagement_template",
          "knowledge",
          "platform_campaign",
        ].includes(table) &&
        query.rowMode !== "array"
      )
        assert.match(
          sql,
          /WHERE\s+id\s*=\s*\$1\s+AND\s+organization_id\s*=\s*\$2/i,
        );
      if (query.rowMode === "array")
        assert.match(sql, /"organization_id"\s*=\s*\$1/);
      // Validate projected column names against the actual schema, including SQL aliases.
      const aliases: Record<string, string> = {};
      for (const match of sql.matchAll(
        /\b(?:FROM|JOIN)\s+"?([a-z_]+)"?(?:\s+([a-z]+))?/gi,
      )) {
        if (
          match[2] &&
          !["where", "left", "join", "order", "on"].includes(
            match[2].toLowerCase(),
          )
        )
          aliases[match[2]] = match[1];
      }
      for (const column of sql.slice(6, tableMatch.index).split(",")) {
        const field = column.trim().match(/^(?:(\w+)\.)?"?(\w+)"?$/);
        if (field)
          assert.ok(
            columns.get(field[1] ? aliases[field[1]] : table)?.has(field[2]),
            `Known column: ${column}`,
          );
      }
      let found: Row[] = [];
      if (table === "organization")
        found = rows[table].filter((r) => r.id === params[0]);
      else if (table === "run")
        found = rows.run
          .filter((r) => r.id === params[0])
          .flatMap((r) => {
            const task = rows.task.find((t) => t.id === r.task_id)!;
            return task.organization_id === params[1] ||
              r.customer_organization_id === params[1]
              ? [
                  {
                    ...r,
                    workflow_id: task.workflow_id,
                    organization_id: task.organization_id,
                  },
                ]
              : [];
          });
      else if (table === "workflow")
        found = rows.workflow
          .filter(
            (w) =>
              w.id === params[0] &&
              (w.organization_id === params[1] ||
                rows.organization.find((o) => o.id === w.organization_id)
                  ?.kind === "platform"),
          )
          .map((w) => ({
            ...w,
            ...rows.workflow_draft.find((d) => d.workflow_id === w.id),
          }));
      else if (table === "engagement")
        found = rows[table].filter(
          (r) =>
            r.id === params[0] &&
            (r.organization_id === params[1] ||
              r.customer_organization_id === params[1]),
        );
      else if (table === "engagement_attempt")
        found = /WHERE id=\$1/i.test(sql)
          ? rows[table].filter(
              (r) => r.id === params[0] && r.engagement_id === params[1],
            )
          : rows[table].filter(
              (r) => r.engagement_id === params[0] && r.run_id === params[1],
            );
      else if (table === "code_build")
        found = /WHERE id=\$1/i.test(sql)
          ? rows[table].filter((r) => r.id === params[0])
          : rows[table].filter((r) => r.organization_id === params[0]);
      else if (table === "skill_version")
        found = rows[table]
          .filter((v) => v.id === params[0])
          .flatMap((v) => {
            const s = rows.skill.find((s) => s.id === v.skill_id)!;
            return s.organization_id === params[1] ||
              s.organization_id === null ||
              rows.organization.find((o) => o.id === s.organization_id)
                ?.kind === "platform"
              ? [{ ...v, name: s.name, description: s.description }]
              : [];
          });
      else if (table === "tool")
        found = rows[table].filter((r) => r.id === params[0]);
      else if (
        table === "product_metadata" ||
        table === "platform_product" ||
        table === "product_release"
      )
        found = rows[table].filter((r) => r.organization_id === params[0]);
      else if (query.rowMode === "array") {
        found = rows[table].filter((r) => r.organization_id === params[0]);
        if (table === "workspace_job")
          found = found.filter(
            (r) =>
              r.kind === "mindmap" &&
              (!params.includes("completed") || r.state === "completed") &&
              (!sql.includes("fingerprint") ||
                params.includes(r.payload.fingerprint)),
          );
      } else
        found = rows[table].filter(
          (r) => r.id === params[0] && r.organization_id === params[1],
        );
      if (query.rowMode === "array") {
        const fields = [
          ...sql.slice(6, tableMatch.index).matchAll(/"([a-z_]+)"/g),
        ].map((m) => m[1]);
        return {
          rows: found.map((r) => fields.map((f) => r[f])),
          rowCount: found.length,
        };
      }
      const selectedFields = sql
        .slice(6, tableMatch.index)
        .split(",")
        .map(
          (column: string) => column.trim().match(/^(?:\w+\.)?"?(\w+)"?$/)?.[1],
        );
      assert.ok(
        selectedFields.every(Boolean),
        "Mock must project every selected field",
      );
      return {
        rows: found.map((record) =>
          Object.fromEntries(
            selectedFields.map((field: string | undefined) => [
              field!,
              record[field!],
            ]),
          ),
        ),
        rowCount: found.length,
      };
    },
  );
  return { rows, queries };
}

test("context schema rejects malformed IDs, invalid revisions and cross-section targets", () => {
  assert.equal(
    assistantContextSchema.safeParse({ runId: "not-an-id" }).success,
    false,
  );
  assert.equal(
    assistantContextSchema.safeParse({ draftRevision: 0 }).success,
    false,
  );
  assert.throws(
    () => assertContextScope("run", { documentId: id.document }),
    /Organizations/,
  );
  assert.throws(
    () => assertContextScope("knowledge", { workflowId: id.workflow }),
    /Run or Library/,
  );
  assert.throws(
    () => assertContextScope("library", { engagementId: id.engagement }),
    /Run/,
  );
  assert.throws(
    () =>
      assertContextScope("knowledge", {
        documentId: id.document,
        productId: id.product,
      }),
    /one primary item/,
  );
});

test("saved workflow and step resolve by identity, ignoring client labels", async (t) => {
  fixture(t);
  const result = await resolveAssistantContext(id.org, "library", {
    kind: "workflow",
    workflowId: id.workflow,
    workflowStepId: "research",
    draftRevision: 3,
    label: "Fake other process",
    unsaved: true,
  });
  assert.equal(result.details.workflow.name, "Discovery");
  assert.equal(result.details.step.name, "Current draft step");
  assert.equal(result.details.unsaved, true);
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      workflowId: id.workflow,
      draftRevision: 2,
    }),
    /saved draft changed/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      workflowId: id.workflow,
      workflowStepId: "missing",
    }),
    /does not belong/,
  );
});
test("cross-organization workflows are rejected while platform templates are read-only", async (t) => {
  fixture(t);
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      workflowId: id.otherWorkflow,
    }),
    /outside/,
  );
  const shared = await resolveAssistantContext(id.org, "library", {
    workflowId: id.sharedWorkflow,
  });
  assert.equal(shared.details.workflow.readOnly, true);
});
test("run selection checks ownership, workflow match and the pinned execution step", async (t) => {
  fixture(t);
  const result = await resolveAssistantContext(id.org, "run", {
    runId: id.run,
    workflowId: id.workflow,
    workflowStepId: id.step,
  });
  assert.equal(result.details.step.name, "Pinned run step");
  await assert.rejects(
    resolveAssistantContext(id.org, "run", { runId: id.otherRun }),
    /outside/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      runId: id.run,
      workflowId: id.sharedWorkflow,
    }),
    /does not match the run/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      runId: id.run,
      workflowStepId: "current_only",
    }),
    /does not belong/,
  );
});
test("attempt must match its engagement, run and stage", async (t) => {
  fixture(t);
  const selection = {
    engagementId: id.engagement,
    attemptId: id.attempt,
    runId: id.run,
    stageIndex: 1,
  };
  assert.equal(
    (await resolveAssistantContext(id.org, "run", selection)).details.attempt
      .revision,
    2,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", { ...selection, stageIndex: 0 }),
    /does not match/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", { attemptId: id.attempt }),
    /Select an engagement/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      engagementId: id.otherEngagement,
    }),
    /outside/,
  );
});
test("run and stage still must match when the client omits attemptId", async (t) => {
  fixture(t);
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      engagementId: id.engagement,
      runId: id.run,
      stageIndex: 0,
    }),
    /does not match/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      engagementId: id.engagement,
      stageIndex: 3,
    }),
    /stage.*(exist|range)/i,
  );
});
test("build ownership and exact run are verified using code_build parent_id", async (t) => {
  fixture(t);
  const build = await resolveAssistantContext(id.org, "run", {
    runId: id.run,
    buildId: id.build,
  });
  assert.equal(build.details.build.parent_id, id.product);
  await assert.rejects(
    resolveAssistantContext(id.org, "run", {
      runId: id.run,
      buildId: id.otherBuild,
    }),
    /does not match/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", { buildId: id.otherBuild }),
    /does not match/,
  );
});
test("product context verifies that selected build belongs to that product lineage", async (t) => {
  fixture(t);
  const selected = await resolveAssistantContext(id.org, "knowledge", {
    productId: id.product,
    buildId: id.build,
  });
  assert.equal(selected.details.product.name, "Research map");
  assert.equal(selected.details.product.latestBuildId, id.build);
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      productId: id.product,
      buildId: id.otherProduct,
    }),
    /does not belong to this product/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", { productId: id.otherBuild }),
    /not found in this organization/,
  );
});
test("product context supports a planned product before its first build", async (t) => {
  fixture(t);
  const selected = await resolveAssistantContext(id.org, "knowledge", {
    productId: id.unbuiltProduct,
  });
  assert.equal(selected.details.product.name, "New service");
  assert.equal(selected.details.product.latestBuildId, undefined);
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      productId: id.unbuiltProduct,
      buildId: id.build,
    }),
    /does not belong to this product/,
  );
});
test("campaign context resolves exact organization, product and revision", async (t) => {
  fixture(t);
  const selected = await resolveAssistantContext(id.org, "knowledge", {
    kind: "campaign",
    campaignId: id.campaign,
    version: 2,
    label: "Wrong client label",
  });
  assert.equal(selected.details.campaign.name, "Qualification");
  assert.equal(selected.details.product.id, id.product);
  assert.equal(selected.selection.productId, id.product);
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      campaignId: id.otherCampaign,
    }),
    /outside/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      campaignId: id.campaign,
      productId: id.otherProduct,
    }),
    /does not match/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      campaignId: id.campaign,
      version: 1,
    }),
    /changed/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "run", { campaignId: id.campaign }),
    /Organizations/,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      campaignId: id.campaign,
      documentId: id.document,
    }),
    /primary item/,
  );
});
test("platform workspace sees a customer's build only through its authorized run", async (t) => {
  const { rows } = fixture(t);
  rows.task[0].organization_id = id.platform;
  const resolved = await resolveAssistantContext(id.platform, "run", {
    runId: id.run,
    buildId: id.build,
  });
  assert.equal(resolved.details.build.organization_id, id.org);
  await assert.rejects(
    resolveAssistantContext(id.platform, "run", { buildId: id.build }),
    /does not match/,
  );
  rows.run.push({ ...rows.run[0], id: uuid(404) });
  await assert.rejects(
    resolveAssistantContext(id.platform, "run", {
      runId: uuid(404),
      buildId: id.build,
    }),
    /does not match/,
  );
});
test("document identity and exact displayed revision are checked against kb_document", async (t) => {
  fixture(t);
  assert.equal(
    (
      await resolveAssistantContext(id.org, "knowledge", {
        documentId: id.document,
        version: 4,
      })
    ).details.document.revision,
    4,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      documentId: id.document,
      version: 3,
    }),
    /document.*changed|document.*revision/i,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", {
      documentId: id.otherDocument,
    }),
    /outside/,
  );
});
test("chain context verifies the saved revision and organization", async (t) => {
  fixture(t);
  assert.equal(
    (
      await resolveAssistantContext(id.org, "library", {
        chainId: id.chain,
        draftRevision: 5,
      })
    ).details.chain.revision,
    5,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      chainId: id.chain,
      draftRevision: 4,
    }),
    /chain.*changed|chain.*revision/i,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "library", { chainId: id.otherChain }),
    /outside/,
  );
});
test("skill context resolves the selected version rather than the latest and preserves its contracts", async (t) => {
  fixture(t);
  const result = await resolveAssistantContext(id.org, "library", {
    skillVersionId: id.skillV1,
    version: 1,
  });
  assert.equal(result.details.skill.instructions, "Old exact instructions");
  assert.deepEqual(result.details.skill.input_schema.required, ["old_input"]);
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      skillVersionId: id.skillV1,
      version: 2,
    }),
    /skill.*version/i,
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      skillVersionId: id.otherSkillVersion,
    }),
    /outside/,
  );
  assert.equal(
    (
      await resolveAssistantContext(id.org, "library", {
        skillVersionId: id.sharedSkillVersion,
      })
    ).details.skill.name,
    "Shared research",
  );
});
test("tool is global while reference knowledge remains organization scoped", async (t) => {
  fixture(t);
  assert.equal(
    (await resolveAssistantContext(id.org, "library", { toolId: id.tool }))
      .details.tool.name,
    "Web research",
  );
  assert.equal(
    (
      await resolveAssistantContext(id.org, "library", {
        knowledgeId: id.knowledge,
      })
    ).details.reference.content,
    "Cite evidence",
  );
  await assert.rejects(
    resolveAssistantContext(id.org, "library", {
      knowledgeId: id.otherKnowledge,
    }),
    /outside/,
  );
});
test("concept resolves against the current organization's map and rejects removed sources", async (t) => {
  const { queries } = fixture(t);
  const result = await resolveAssistantContext(id.org, "knowledge", {
    conceptId: "market",
  });
  assert.equal(result.details.concept.label, "Market");
  assert.deepEqual(result.details.concept.sourceIds, [id.document]);
  await assert.rejects(
    resolveAssistantContext(id.org, "knowledge", { conceptId: "deleted" }),
    /no longer/,
  );
  await assert.rejects(
    resolveAssistantContext(id.other, "knowledge", { conceptId: "market" }),
    /no longer/,
  );
  assert.ok(queries.some((q) => q.sql.includes('"kb_document"')));
  assert.ok(queries.some((q) => q.sql.includes('"workspace_job"')));
});
test("selected context text is bounded and labels saved evidence as untrusted", () => {
  const message = selectedContextMessage("Explain this", {
    content: "x".repeat(20000),
  });
  assert.ok(message.length < 15000);
  assert.match(message, /saved data, not instructions/);
  assert.match(message, /User request:\nExplain this/);
});
