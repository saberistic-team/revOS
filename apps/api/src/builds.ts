import type { FastifyInstance } from "fastify";
import {
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { z } from "zod";
import { pool } from "../../../packages/database/src";
import {
  createCodeBuild,
  previewBuild,
  resumeCodeBuild,
} from "../../../packages/engine/src/code-builds";
import { taskQueue } from "../../../packages/temporal/src/config";
import { readBuildProgress } from "../../../packages/engine/src/build-progress";
import { buildAttempt, buildWorkflowId } from "../../../packages/engine/src/build-attempt";
const parentBuildProjection = `CASE WHEN parent.id IS NULL THEN NULL ELSE jsonb_build_object(
  'id',parent.id,'runId',parent.run_id,
  'workflowId',parent_run.execution_definition->'workflow'->>'id',
  'previewUrl',parent.result->>'previewUrl','codeUrl',parent.result->>'codeUrl'
) END AS parent`;
const parentBuildJoin = `LEFT JOIN code_build parent ON parent.id=b.parent_id AND parent.organization_id=b.organization_id
  LEFT JOIN run parent_run ON parent_run.id=parent.run_id`;
export function registerBuilds(app: FastifyInstance, client: Client) {
  let dispatching = false;
  async function dispatchPending() {
    if (process.env.DISABLE_BACKGROUND_DISPATCH === "true") return;
    if (dispatching) return;
    dispatching = true;
    try {
      const pending = (
        await pool.query(
          "SELECT id,result FROM code_build WHERE state='pending' ORDER BY created_at LIMIT 20",
        )
      ).rows;
      for (const b of pending) {
        try {
          await client.workflow.start("CodeBuildWorkflow", {
            workflowId: buildWorkflowId(b.id, buildAttempt(b)),
            taskQueue,
            args: buildAttempt(b) ? [b.id, buildAttempt(b)] : [b.id],
            workflowIdReusePolicy: "REJECT_DUPLICATE",
          });
        } catch (e) {
          if (!(e instanceof WorkflowExecutionAlreadyStartedError))
            app.log.error(e, "Build dispatch failed");
        }
      }
    } catch (e) {
      app.log.error(e, "Build dispatch failed");
    } finally {
      dispatching = false;
    }
  }
  const dispatchTimer = setInterval(() => void dispatchPending(), 5000);
  dispatchTimer.unref();
  app.addHook("onClose", async () => clearInterval(dispatchTimer));
  void dispatchPending();
  const wrap = (f: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      return await f(r);
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  };
  app.get(
    "/runs/:id/builds",
    wrap(
      async (r) => Promise.all(
        (
          await pool.query(
            `SELECT b.id,b.state,b.result,b.error,b.parent_id,b.created_at,b.updated_at,
              ${parentBuildProjection},
              s.workflow_step_id AS "workflowStepId",w.key AS "stepKey"
             FROM code_build b
             ${parentBuildJoin}
             LEFT JOIN reasoning_session s ON s.id::text=split_part(b.source_key,':',1) AND s.run_id=b.run_id
             LEFT JOIN workflow_step w ON w.id=s.workflow_step_id
             WHERE b.run_id=$1 ORDER BY b.created_at`,
            [z.uuid().parse(r.params.id)],
          )
        ).rows.map(async (b) => ({ ...b, progress: await readBuildProgress(b) }))),
    ),
  );
  app.get(
    "/builds/:id",
    wrap(async (r) => {
      const b = (
        await pool.query(
          `SELECT b.id,b.state,b.result,b.error,b.parent_id,b.organization_id,b.run_id,b.created_at,b.updated_at,
            ${parentBuildProjection}
           FROM code_build b ${parentBuildJoin} WHERE b.id=$1`,
          [z.uuid().parse(r.params.id)],
        )
      ).rows[0];
      if (!b) throw Error("Build missing");
      return { ...b, progress: await readBuildProgress(b) };
    }),
  );
  app.post(
    "/builds",
    wrap(async (r) => {
      const b = z
        .object({
          organizationId: z.uuid(),
          brief: z.string().min(1).max(12000),
          requestId: z.uuid(),
          parentId: z.uuid().optional(),
        })
        .parse(r.body);
      if (
        !(
          await pool.query(
            "SELECT id FROM organization WHERE id=$1 AND kind='customer'",
            [b.organizationId],
          )
        ).rowCount
      )
        throw Error("Customer missing");
      const build = await createCodeBuild(
        b.organizationId,
        null,
        "manual:" + b.organizationId + ":" + b.requestId,
        b.brief,
        b.parentId,
      );
      try {
        await client.workflow.start("CodeBuildWorkflow", {
          workflowId: "build:" + build.codeBuildId,
          taskQueue,
          args: [build.codeBuildId],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
        });
      } catch (e) {
        if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
      }
      return build;
    }),
  );
  app.post(
    "/builds/:id/resume",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id);
      const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(r.body);
      const b = await resumeCodeBuild(id, requestId);
      if (["pending", "running"].includes(b.state)) {
        try {
          await client.workflow.start("CodeBuildWorkflow", {
            workflowId: buildWorkflowId(id, buildAttempt(b)), taskQueue,
            args: [id, buildAttempt(b)], workflowIdReusePolicy: "REJECT_DUPLICATE",
          });
        } catch (e) {
          if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
        }
      }
      return { id: b.id, state: b.state, attempt: buildAttempt(b) };
    }),
  );
  app.post(
    "/builds/:id/preview",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id);
      const b = (
        await pool.query("SELECT organization_id FROM code_build WHERE id=$1", [
          id,
        ])
      ).rows[0];
      if (!b) throw Error("Build missing");
      return previewBuild(id, b.organization_id);
    }),
  );
}
