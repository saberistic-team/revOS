import type { FastifyInstance } from "fastify";
import {
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { z } from "zod";
import { pool } from "../../../packages/database/src";
import { createEngagement } from "../../../packages/engine/src/engagement";
import {
  chainStagesSchema,
  engagementDecisionSchema,
} from "../../../packages/shared/src/engagement";
import { assertWorkflowAccess } from "../../../packages/engine/src/run-service";
import { taskQueue } from "../../../packages/temporal/src/config";
export function registerEngagements(app: FastifyInstance, client: Client) {
  const wrap = (f: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      return await f(r);
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  };
  async function start(id: string) {
    try {
      await client.workflow.start("EngagementWorkflow", {
        workflowId: "engagement:" + id,
        retry: { initialInterval: "5 seconds", maximumInterval: "1 minute" },
        taskQueue,
        args: [id],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    } catch (e) {
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    }
  }
  const sweep = setInterval(() => {
    if (process.env.DISABLE_BACKGROUND_DISPATCH === "true") return;
    void pool
      .query(
        "SELECT id FROM engagement WHERE state NOT IN ('completed','cancelled')",
      )
      .then(async (r) => {
        for (const e of r.rows) await start(e.id);
      })
      .catch((e) => app.log.error(e));
  }, 5000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));
  app.get(
    "/engagement-templates",
    wrap(
      async () =>
        (
          await pool.query(
            "SELECT * FROM engagement_template ORDER BY created_at",
          )
        ).rows,
    ),
  );
  app.post(
    "/engagement-templates",
    wrap(async (r) => {
      const b = z
        .object({
          id: z.uuid().optional(),
          organizationId: z.uuid(),
          name: z.string().min(1).max(160),
          stages: chainStagesSchema,
          revision: z.number().int().positive().optional(),
        })
        .parse(r.body);
      for (const s of b.stages)
        await assertWorkflowAccess(s.workflowId, b.organizationId);
      if (b.id) {
        const q = await pool.query(
          "UPDATE engagement_template SET name=$3,stages=$4,revision=revision+1 WHERE id=$1 AND organization_id=$2 AND revision=$5 RETURNING *",
          [
            b.id,
            b.organizationId,
            b.name,
            JSON.stringify(b.stages),
            b.revision,
          ],
        );
        if (!q.rowCount) throw Error("Template changed; reload");
        return q.rows[0];
      }
      return (
        await pool.query(
          "INSERT INTO engagement_template(organization_id,name,stages) VALUES($1,$2,$3) RETURNING *",
          [b.organizationId, b.name, JSON.stringify(b.stages)],
        )
      ).rows[0];
    }),
  );
  app.get(
    "/engagements",
    wrap(
      async (r) =>
        (
          await pool.query(
            "SELECT * FROM engagement WHERE ($1::uuid IS NULL OR customer_organization_id=$1 OR organization_id=$1) ORDER BY created_at DESC LIMIT 200",
            [r.query.organization ? z.uuid().parse(r.query.organization) : null],
          )
        ).rows,
    ),
  );
  app.post(
    "/engagements",
    wrap(async (r) => {
      const b = z
        .object({
          templateId: z.uuid(),
          name: z.string().trim().min(1).max(160),
          input: z.record(z.string(), z.any()),
          customerOrganizationId: z.uuid().optional(),
        })
        .parse(r.body);
      const e = await createEngagement(
        b.templateId,
        b.input,
        b.name,
        b.customerOrganizationId,
      );
      try {
        await start(e.id);
      } catch {}
      return e;
    }),
  );
  app.get(
    "/engagements/:id",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id);
      const e = (await pool.query("SELECT * FROM engagement WHERE id=$1", [id]))
        .rows[0];
      if (!e) throw Error("Engagement missing");
      const attempts = (
        await pool.query(
          "SELECT a.*,r.status AS run_status,r.error AS run_error FROM engagement_attempt a JOIN run r ON r.id=a.run_id WHERE a.engagement_id=$1 ORDER BY a.stage_index,a.revision",
          [id],
        )
      ).rows;
      return { ...e, attempts };
    }),
  );
  app.post(
    "/engagements/:id/decision",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id),
        b = engagementDecisionSchema.parse(r.body);
      const c = await pool.connect();
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [id]);
      try {
        await c.query("BEGIN");
        const e = (
          await c.query("SELECT * FROM engagement WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        if (!e || e.state === "completed")
          throw Error("Engagement is complete or missing");
        const a = (
          await c.query(
            "SELECT * FROM engagement_attempt WHERE engagement_id=$1 AND stage_index=$2 ORDER BY revision DESC LIMIT 1",
            [id, e.stage_index],
          )
        ).rows[0];
        if (a?.id !== b.attemptId)
          throw Error("This stage version is no longer current");
        if (b.action === "pause") {
          await c.query("UPDATE engagement SET state='paused' WHERE id=$1", [
            id,
          ]);
        } else if (b.action === "resume") {
          if (e.state !== "paused") throw Error("Engagement is not paused");
          await c.query("UPDATE engagement SET state=$2 WHERE id=$1", [
            id,
            a.state === "awaiting_approval" ? "awaiting_approval" : "running",
          ]);
        } else {
          if (e.state === "paused")
            throw Error("Resume before approving or revising");
          if (a.state === "approved" && b.action === "approve") {
            await c.query("COMMIT");
            return { state: "approved" };
          }
          if (
            !["awaiting_approval", "failed"].includes(a.state) ||
            (b.action === "approve" && a.state === "failed")
          )
            throw Error("This version is not ready for approval");
          await c.query(
            "UPDATE engagement_attempt SET state=$2,feedback=$3,decision_by=$4,approved_at=$5 WHERE id=$1",
            [
              a.id,
              b.action === "approve" ? "approved" : "revision_requested",
              b.feedback,
              b.source,
              b.action === "approve" ? new Date() : null,
            ],
          );
          await c.query(
            "UPDATE engagement SET state='running',error=NULL WHERE id=$1",
            [id],
          );
        }
        await c.query("COMMIT");
        return { accepted: true };
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
        c.release();
      }
    }),
  );
  app.get(
    "/runs/:id/feedback",
    wrap(
      async (r) =>
        (
          await pool.query(
            "SELECT * FROM run_feedback WHERE run_id=$1 ORDER BY created_at",
            [z.uuid().parse(r.params.id)],
          )
        ).rows,
    ),
  );
  app.post(
    "/runs/:id/feedback",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id),
        b = z
          .object({
            content: z.string().trim().min(1).max(6000),
            source: z.enum(["operator", "customer"]).default("operator"),
          })
          .parse(r.body);
      if (!(await pool.query("SELECT id FROM run WHERE id=$1", [id])).rowCount)
        throw Error("Run missing");
      return (
        await pool.query(
          "INSERT INTO run_feedback(run_id,content,source) VALUES($1,$2,$3) RETURNING *",
          [id, b.content, b.source],
        )
      ).rows[0];
    }),
  );
}
