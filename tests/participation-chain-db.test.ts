import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test(
  "collaborative delivery seed preserves all source definitions and repeats without duplicates",
  { skip: !process.env.TEST_PARTICIPATION_DATABASE_URL },
  async () => {
    const url = process.env.TEST_PARTICIPATION_DATABASE_URL!,
      admin = new Pool({ connectionString: url }),
      schema = "participation_chain_test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const configured = new URL(url);
    configured.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = configured.toString();
    const { pool } = await import("../packages/database/src");
    try {
      for (const table of [
        "organization",
        "agent",
        "tool",
        "skill",
        "skill_version",
        "knowledge",
        "workflow",
        "workflow_version",
        "workflow_step",
        "workflow_draft",
        "engagement_template",
      ])
        await pool.query(
          `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      const org = randomUUID(),
        agent = randomUUID();
      await pool.query(
        "INSERT INTO organization(id,name,kind) VALUES($1,'Seed test platform','platform')",
        [org],
      );
      await pool.query(
        "INSERT INTO agent(id,organization_id,name,instructions) VALUES($1,$2,'Test agent','Use approved evidence')",
        [agent, org],
      );
      const { seedParticipation } =
        await import("../scripts/seed-participation");
      const capabilities = await seedParticipation();
      const stages = [];
      for (const name of ["Discovery", "Research", "Proposal", "Product"]) {
        const id = randomUUID(),
          version = randomUUID();
        await pool.query(
          "INSERT INTO workflow(id,organization_id,name,slug) VALUES($1,$2,$3,$4)",
          [id, org, name, name.toLowerCase()],
        );
        await pool.query(
          "INSERT INTO workflow_version(id,workflow_id,version,goal,sop_markdown,input_schema,output_schema,created_by) VALUES($1,$2,1,$3,$4,$5,$6,'test')",
          [
            version,
            id,
            "Complete " + name,
            "Preserve " + name + " evidence",
            JSON.stringify({ type: "object" }),
            JSON.stringify({ type: "object" }),
          ],
        );
        const config = {
          provider: "openai",
          model: "gpt-4.1",
          inputFrom: "context",
          skillVersionIds: [capabilities.skills[0].versionId],
          allowHumanReview: true,
          maxTurns: 16,
          maxToolCalls: 4,
          maxSkillSelections: 4,
          requireCompletedBuild: name === "Product",
          outputs: {
            presentation: "report",
            artifacts: { mode: "manual", formats: ["pdf"] },
          },
        };
        await pool.query(
          "INSERT INTO workflow_step(workflow_version_id,key,name,position,type,configuration) VALUES($1,'work',$2,0,'agent_loop',$3),($1,'review','Review',1,'human_review',$4)",
          [
            version,
            name,
            JSON.stringify(config),
            JSON.stringify({ inputFrom: "previous", outputMode: "input" }),
          ],
        );
        await pool.query(
          "UPDATE workflow SET current_version_id=$2 WHERE id=$1",
          [id, version],
        );
        stages.push({ name, workflowId: id });
      }
      const template = randomUUID();
      await pool.query(
        "INSERT INTO engagement_template(id,organization_id,name,stages) VALUES($1,$2,'Customer Discovery → Product',$3)",
        [template, org, JSON.stringify(stages)],
      );
      const ids: string[] = stages.map((s) => s.workflowId);
      const snapshot = async () => ({
        workflows: (
          await pool.query(
            "SELECT * FROM workflow WHERE id=ANY($1::uuid[]) ORDER BY id",
            [ids],
          )
        ).rows,
        versions: (
          await pool.query(
            "SELECT * FROM workflow_version WHERE workflow_id=ANY($1::uuid[]) ORDER BY id",
            [ids],
          )
        ).rows,
        steps: (
          await pool.query(
            "SELECT s.* FROM workflow_step s JOIN workflow_version v ON v.id=s.workflow_version_id WHERE v.workflow_id=ANY($1::uuid[]) ORDER BY s.id",
            [ids],
          )
        ).rows,
        chain: (
          await pool.query("SELECT * FROM engagement_template WHERE id=$1", [
            template,
          ])
        ).rows,
      });
      const before = await snapshot();
      const { seedCollaborativeDelivery } =
        await import("../scripts/seed-collaborative-delivery");
      const first = await seedCollaborativeDelivery(template);
      assert.equal(first.created, true);
      assert.equal(first.stages.length, 4);
      for (const stage of first.stages) {
        assert(!ids.includes(stage.workflowId));
        const rows = (
          await pool.query(
            "SELECT s.* FROM workflow_step s JOIN workflow w ON w.current_version_id=s.workflow_version_id WHERE w.id=$1 ORDER BY s.position",
            [stage.workflowId],
          )
        ).rows;
        assert.equal(rows.length, 2);
        assert.equal(rows[1].type, "human_review");
        assert.equal(rows[0].configuration.skillVersionIds.length, 3);
        assert.equal(rows[0].configuration.allowHumanReview, true);
        assert.equal(rows[0].configuration.allowHumanQuestions, true);
        assert.equal(
          rows[0].configuration.requireCompletedBuild,
          stage.name === "Product",
        );
        assert.deepEqual(rows[0].configuration.outputs, {
          presentation: "report",
          artifacts: { mode: "manual", formats: ["pdf"] },
        });
      }
      const second = await seedCollaborativeDelivery(template);
      assert.equal(second.created, false);
      assert.equal(second.templateId, first.templateId);
      assert.deepEqual(second.stages, first.stages);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM workflow")).rows[0].n,
        8,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM engagement_template WHERE name='Collaborative Customer Delivery'",
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
