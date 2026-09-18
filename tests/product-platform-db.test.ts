import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

// Never falls back to the app's live connection. All tables and fixtures live in a disposable schema.
test(
  "full additive migration and product, campaign, usage invariants",
  { skip: !process.env.TEST_PLATFORM_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_PLATFORM_DATABASE_URL!,
      schema = "platform_test_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const configured = new URL(url);
    configured.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = configured.toString();
    const { pool } = await import("../packages/database/src");
    const p = await import("../packages/engine/src/product-platform"),
      u = await import("../packages/engine/src/usage-ledger"),
      c = await import("../packages/engine/src/usage-collectors"),
      o = await import("../packages/engine/src/organization-products");
    const org = randomUUID(),
      other = randomUUID(),
      root = randomUUID(),
      child = randomUUID();
    try {
      const folder = resolve(__dirname, "../packages/database/migrations");
      const files = readdirSync(folder)
        .filter((n) => /^00(?:0[0-9]|1[0-2])_.*\.sql$/.test(n))
        .sort();
      for (const file of files) {
        if (file.startsWith("0011")) {
          await pool.query(
            "INSERT INTO organization(id,name) VALUES($1,'Test customer'),($2,'Other customer')",
            [org, other],
          );
          await pool.query(
            "INSERT INTO code_build(id,organization_id,source_key,brief,state,result) VALUES($1,$2,'historical-root','Product: Old product','completed',$3)",
            [
              root,
              org,
              JSON.stringify({ previewUrl: "http://localhost:3002/old/" }),
            ],
          );
          await pool.query(
            "INSERT INTO code_build(id,organization_id,source_key,parent_id,brief) VALUES($1,$2,'historical-child',$3,'Revision')",
            [child, org, root],
          );
          await pool.query(
            "INSERT INTO product_metadata(product_id,organization_id,name,description) VALUES($1,$2,'Named product','Preserved description')",
            [root, org],
          );
        }
        const sql = readFileSync(resolve(folder, file), "utf8").replaceAll(
          '"public".',
          `"${schema}".`,
        );
        for (const statement of sql.split("--> statement-breakpoint"))
          if (statement.trim()) await pool.query(statement);
      }
      assert(
        files.some((f) => f.startsWith("0012")),
        "Migration smoke includes service delivery",
      );
      await t.test(
        "migration preserves old product ID, preview and build lineage",
        async () => {
          const products = await o.organizationProducts(org);
          assert.equal(products.length, 1);
          assert.equal(products[0].id, root);
          assert.equal(products[0].name, "Named product");
          assert.equal(products[0].versions.length, 2);
          assert.equal(products[0].previewBuild.id, root);
          const next = (
            await pool.query(
              "INSERT INTO code_build(organization_id,source_key,parent_id,brief) VALUES($1,'next-child',$2,'Continue') RETURNING product_id",
              [org, child],
            )
          ).rows[0];
          assert.equal(next.product_id, root);
        },
      );
      const owner = (
        await pool.query(
          "INSERT INTO organization_person(organization_id,name,email) VALUES($1,'Owner','owner@example.test') RETURNING id",
          [org],
        )
      ).rows[0].id;
      const outsider = (
        await pool.query(
          "INSERT INTO organization_person(organization_id,name,email) VALUES($1,'Other','other@example.test') RETURNING id",
          [other],
        )
      ).rows[0].id;
      const productId = randomUUID();
      await t.test(
        "stable product creation is idempotent and ownership is organization scoped",
        async () => {
          const results = await Promise.all([
            p.createProduct(
              org,
              { name: "New backend", ownerPersonId: owner },
              { id: productId },
            ),
            p.createProduct(
              org,
              { name: "New backend", ownerPersonId: owner },
              { id: productId },
            ),
          ]);
          assert.equal(results[0].id, results[1].id);
          const product = (await o.organizationProducts(org)).find(
            (x) => x.id === productId,
          );
          assert.equal(product.latestBuild, null);
          await assert.rejects(
            p.saveProduct(org, {
              name: "Cross-owner",
              ownerPersonId: outsider,
            }),
            /participant/,
          );
          await assert.rejects(
            p.createProduct(other, { name: "Wrong" }, { id: productId }),
            /organization/,
          );
        },
      );
      await t.test(
        "product catalog links only healthy backend deployments",
        async () => {
          const build = (
            await pool.query(
              "INSERT INTO code_build(organization_id,product_id,source_key,brief,state) VALUES($1,$2,'backend-fixture','Backend','completed') RETURNING id",
              [org, productId],
            )
          ).rows[0].id;
          await pool.query(
            "INSERT INTO product_release(product_id,organization_id,build_id,request_id,environment,state,source_commit,repository_url,configuration,config_revision,ci_branch,url) VALUES($1,$2,$3,$4,'preview','healthy',$5,'http://forgejo.local/repo','{}',1,'main','http://preview.example.test')",
            [productId, org, build, randomUUID(), "a".repeat(40)],
          );
          await pool.query(
            "INSERT INTO product_release(product_id,organization_id,build_id,request_id,environment,state,source_commit,repository_url,configuration,config_revision,ci_branch,url) VALUES($1,$2,$3,$4,'live','syncing',$5,'http://forgejo.local/repo','{}',1,'main','http://not-ready.example.test')",
            [productId, org, build, randomUUID(), "a".repeat(40)],
          );
          const product = (await p.listPlatformProducts(org)).find(
            (x) => x.id === productId,
          );
          assert.equal(product.preview_url, "http://preview.example.test");
          assert.equal(product.live_url, null);
          const detail = await p.productDetail(org, productId);
          assert.equal(detail.preview_url, "http://preview.example.test");
          assert.equal(detail.live_url, null);
          const legacy = (await o.organizationProducts(org)).find(
            (x) => x.id === productId,
          );
          assert.equal(legacy.previewUrl, "http://preview.example.test");
          assert.equal(legacy.liveUrl, undefined);
        },
      );
      const campaign = await p.createCampaign(org, {
        name: "Launch",
        objective: "Deliver the backend",
        productId,
        ownerPersonId: owner,
        stakeholderIds: [owner],
      });
      await t.test(
        "product organization is immutable through all edit inputs",
        async () => {
          const updated = await p.saveProduct(
            org,
            {
              name: "New backend",
              description: "Same owner",
              ownerPersonId: owner,
              organizationId: other,
            },
            productId,
            1,
          );
          assert.equal(updated.organization_id, org);
          await assert.rejects(
            p.saveProduct(
              other,
              { name: "Stolen product" },
              productId,
              updated.revision,
            ),
            /missing/,
          );
          assert.equal(
            (await p.productDetail(org, productId)).organization_id,
            org,
          );
        },
      );
      await t.test(
        "requirements preserve revisions and serialize conflicting review decisions",
        async () => {
          const requirement = await p.createRequirement(org, campaign.id, {
            title: "Capture leads",
            description: "Store a lead",
            acceptanceCriteria: ["Lead persists after restart"],
            evidence: [{ kind: "note", reference: "Customer request" }],
          });
          const decisions = await Promise.allSettled([
            p.decideRequirement(org, requirement.id, {
              revision: 1,
              action: "approve",
              actor: "A",
            }),
            p.decideRequirement(org, requirement.id, {
              revision: 1,
              action: "reject",
              actor: "B",
            }),
          ]);
          assert.equal(
            decisions.filter((x) => x.status === "fulfilled").length,
            1,
          );
          await p.saveRequirement(
            org,
            campaign.id,
            {
              title: "Capture leads",
              description: "Store and validate a lead",
              acceptanceCriteria: ["Missing email rejected"],
            },
            requirement.id,
            1,
          );
          const detail = await p.campaignDetail(org, campaign.id);
          assert.equal(detail.requirements[0].state, "proposed");
          assert.equal(detail.requirements[0].current_revision, 2);
          await assert.rejects(
            p.decideRequirement(org, requirement.id, {
              revision: 1,
              action: "approve",
              actor: "A",
            }),
            /newer/,
          );
          const history = await p.requirementHistory(org, requirement.id);
          assert.equal(history.length, 2);
          assert.equal(history[1].description, "Store a lead");
          await assert.rejects(
            pool.query(
              "UPDATE requirement_revision SET description='tamper' WHERE requirement_id=$1",
              [requirement.id],
            ),
            /append-only/,
          );
          await assert.rejects(
            p.campaignDetail(other, campaign.id),
            /organization/,
          );
          const separate = await p.createCampaign(org, {
            name: "Different initiative",
            objective: "Keep evidence separate",
            productId,
          });
          await assert.rejects(
            p.saveRequirement(
              org,
              separate.id,
              {
                title: "Moved",
                description: "Move between campaigns",
                acceptanceCriteria: ["Invalid"],
              },
              requirement.id,
              2,
            ),
            /not found/,
          );
          await assert.rejects(
            p.createRequirement(other, campaign.id, {
              title: "Cross tenant",
              description: "Invalid",
              acceptanceCriteria: ["Invalid"],
            }),
            /organization/,
          );
          await assert.rejects(
            p.createRequirement(
              org,
              separate.id,
              {
                title: "Replay elsewhere",
                description: "Invalid",
                acceptanceCriteria: ["Invalid"],
              },
              { id: requirement.id },
            ),
            /another campaign/,
          );
        },
      );
      await t.test(
        "campaign starts exactly one engagement under concurrent requests",
        async () => {
          const workflow = randomUUID(),
            version = randomUUID(),
            template = randomUUID();
          await pool.query(
            "INSERT INTO workflow(id,organization_id,name,slug) VALUES($1,$2,'Test chain workflow','test')",
            [workflow, org],
          );
          await pool.query(
            "INSERT INTO workflow_version(id,workflow_id,version,goal,sop_markdown,created_by,input_schema) VALUES($1,$2,1,'Test','Review','test',$3)",
            [
              version,
              workflow,
              JSON.stringify({
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              }),
            ],
          );
          await pool.query(
            "INSERT INTO workflow_step(workflow_version_id,key,name,position,type) VALUES($1,'review','Review',0,'human_review')",
            [version],
          );
          await pool.query(
            "UPDATE workflow SET current_version_id=$2 WHERE id=$1",
            [workflow, version],
          );
          await pool.query(
            "INSERT INTO engagement_template(id,organization_id,name,stages) VALUES($1,$2,'Chain',$3)",
            [
              template,
              org,
              JSON.stringify([
                { key: "understand", name: "Understand", workflowId: workflow },
              ]),
            ],
          );
          const result = await Promise.all([
            p.startCampaign(org, campaign.id, {
              templateId: template,
              input: { message: "Hello" },
            }),
            p.startCampaign(org, campaign.id, {
              templateId: template,
              input: { message: "Hello" },
            }),
          ]);
          assert.equal(result[0].engagement_id, result[1].engagement_id);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS count FROM engagement"))
              .rows[0].count,
            1,
          );
          const current = await p.campaignDetail(org, campaign.id);
          await assert.rejects(
            p.saveCampaign(
              org,
              {
                name: current.name,
                objective: current.objective,
                productId: root,
              },
              campaign.id,
              current.revision,
            ),
            /product cannot change/,
          );
          const updated = await p.saveCampaign(
            org,
            { name: current.name, objective: "Refined objective", productId },
            campaign.id,
            current.revision,
          );
          assert.equal(updated.product_id, productId);
          assert.equal(updated.objective, "Refined objective");
        },
      );
      const event = {
        organizationId: org,
        productId,
        campaignId: campaign.id,
        provider: "openai:test",
        category: "llm_input" as const,
        eventKey: "provider-request-1:input",
        unit: "tokens",
        units: 500,
        measuredAt: "2026-09-17T12:00:00.000Z",
      };
      let eventId: string;
      await t.test(
        "concurrent usage delivery deduplicates; paid retries remain distinct",
        async () => {
          const recorded = await Promise.all([
            u.recordUsage(event),
            u.recordUsage(event),
          ]);
          eventId = recorded[0].id;
          assert.equal(recorded[0].id, recorded[1].id);
          assert.equal(recorded.filter((r) => !r.duplicate).length, 1);
          assert.equal(recorded[0].cost_micros, null);
          assert.equal(recorded[0].cost_status, "unpriced");
          await u.recordUsage({ ...event, attemptId: "retry-2" });
          assert.equal(
            (await pool.query("SELECT count(*)::int AS count FROM usage_event"))
              .rows[0].count,
            2,
          );
          await assert.rejects(
            u.recordUsage({ ...event, units: 501 }),
            /different data/,
          );
          await assert.rejects(
            u.recordUsage({
              ...event,
              organizationId: other,
              eventKey: "foreign",
            }),
            /organization/,
          );
          await assert.rejects(
            pool.query("DELETE FROM usage_event WHERE id=$1", [eventId]),
            /append-only/,
          );
        },
      );
      await t.test(
        "versioned costs, reconciliation and budgets retain evidence",
        async () => {
          await u.createRate(org, {
            provider: "openai:test",
            category: "llm_input",
            unit: "tokens",
            amountMicros: 2000000,
            perUnits: 1000000,
            effectiveAt: "2026-09-01T00:00:00.000Z",
            source: "Fixture contract",
          });
          const priced = await u.recordUsage({
            ...event,
            eventKey: "provider-request-2:input",
          });
          assert.equal(Number(priced.cost_micros), 1000);
          assert.equal(priced.cost_status, "estimated");
          await u.reconcileUsage(org, eventId, {
            reconciliationKey: "invoice-line-reference",
            actualCostMicros: 800,
            source: "Provider usage export",
          });
          await u.setBudget(org, {
            productId,
            month: "2026-09",
            amountMicros: 10000000,
          });
          await u.setBudget(org, {
            productId,
            month: "2026-09",
            amountMicros: 12000000,
          });
          const summary = await u.usageSummary(org, {
            productId,
            month: "2026-09",
          });
          assert.equal(summary.groups[0].cost_micros, "1800");
          assert.equal(summary.groups[0].unpriced_events, 1);
          assert.equal(summary.groups[0].units, "1500.000000");
          assert.equal(summary.budgets.length, 1);
          assert.equal(summary.budgets[0].amount_micros, "12000000");
          assert.equal(
            (
              await pool.query(
                "SELECT cost_status FROM usage_event WHERE id=$1",
                [eventId],
              )
            ).rows[0].cost_status,
            "unpriced",
          );
        },
      );
      await t.test(
        "product API credentials cannot attribute usage to another product",
        async () => {
          const credential = await c.rotateUsageCredential(org, productId);
          const recorded = await c.ingestProductUsage(
            productId,
            credential.token,
            { eventKey: "api-1", units: 1 },
          );
          assert.equal(recorded.organization_id, org);
          assert.equal(recorded.product_id, productId);
          await assert.rejects(
            c.ingestProductUsage(root, credential.token, {
              eventKey: "api-2",
              units: 1,
            }),
            /credential/,
          );
          await assert.rejects(
            c.ingestProductUsage(productId, credential.token, {
              eventKey: "api-3",
              units: 1,
              organizationId: other,
            }),
            /Unrecognized/,
          );
          await c.rotateUsageCredential(org, productId);
          await assert.rejects(
            c.ingestProductUsage(productId, credential.token, {
              eventKey: "api-4",
              units: 1,
            }),
            /credential/,
          );
        },
      );
      await t.test(
        "storage samples accrue once, keep snapshots and skip gaps",
        async () => {
          const sample = {
            organizationId: org,
            productId,
            resourceKey: "product-test",
            sizeBytes: 1024 ** 3,
            intervalMinutes: 15,
          };
          await c.recordStorageSample({
            ...sample,
            sampledAt: new Date("2026-09-17T10:00:00Z"),
          });
          await Promise.all([
            c.recordStorageSample({
              ...sample,
              sampledAt: new Date("2026-09-17T10:15:00Z"),
            }),
            c.recordStorageSample({
              ...sample,
              sampledAt: new Date("2026-09-17T10:15:00Z"),
            }),
          ]);
          const after = await c.recordStorageSample({
            ...sample,
            sampledAt: new Date("2026-09-17T12:15:00Z"),
          });
          assert.equal(after.gap, true);
          const rows = (
            await pool.query(
              "SELECT units FROM usage_event WHERE provider='forgejo'",
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(Number(rows[0].units), 0.25);
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
