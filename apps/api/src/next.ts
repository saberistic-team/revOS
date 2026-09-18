import type { FastifyInstance } from "fastify";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../../../packages/database/src";
import { createChange } from "../../../packages/engine/src/workspace-service";
import {
  requireProduct,
  productBodySchema,
} from "../../../packages/engine/src/organization-products";

export function registerNext(app: FastifyInstance) {
  const folder = join(__dirname, "next");
  const template = readFileSync(join(folder, "index.html"), "utf8");
  const assets = readdirSync(folder)
    .filter((name) => /^[a-z-]+\.(js|css)$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(join(folder, name), "utf8")] as const);
  const digest = createHash("sha256");
  for (const [name, source] of [["index.html", template], ...assets])
    digest.update(name).update("\0").update(source).update("\0");
  const version = digest.digest("hex");
  const html = template.replace(
    /<\/head>/i,
    `<meta name="revos-ui-version" content="${version}"></head>`,
  );
  for (const [name, source] of assets) {
    app.get("/next/assets/" + name, async (_r, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .type(name.endsWith(".js") ? "text/javascript" : "text/css")
        .send(source),
    );
  }
  app.get("/next", async (_r, reply) =>
    reply.header("Cache-Control", "no-store").type("text/html").send(html),
  );
  app.get("/next/*", async (_r, reply) =>
    reply.header("Cache-Control", "no-store").type("text/html").send(html),
  );
  app.get("/next-api/ui-version", async (_r, reply) =>
    reply.header("Cache-Control", "no-store").send({ version }),
  );
  const wrap = (fn: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      return await fn(r);
    } catch (e: any) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  };
  app.get(
    "/next-api/runs",
    wrap(
      async (r) =>
        (
          await pool.query(
            `SELECT r.id,r.status,r.created_at AS "createdAt",r.workflow_version_id AS "workflowVersionId",t.workflow_id AS "workflowId",w.name AS "workflowName",coalesce(r.customer_organization_id,t.organization_id) AS "organizationId",o.name AS "organizationName",a.engagement_id AS "engagementId"
    FROM run r JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id JOIN organization o ON o.id=coalesce(r.customer_organization_id,t.organization_id) LEFT JOIN engagement_attempt a ON a.run_id=r.id
    WHERE ($1::uuid IS NULL OR o.id=$1) ORDER BY r.created_at DESC LIMIT 200`,
            [
              r.query.organization
                ? z.uuid().parse(r.query.organization)
                : null,
            ],
          )
        ).rows,
    ),
  );
  app.get(
    "/next-api/search-products",
    wrap(
      async () =>
        (
          await pool.query(
            `SELECT id,organization_id AS "organizationId",name FROM platform_product WHERE state<>'archived' ORDER BY updated_at DESC LIMIT 200`,
          )
        ).rows,
    ),
  );
  app.get(
    "/next-api/inbox",
    wrap(async () => {
      const [waiting, stages, changes] = await Promise.all([
        pool.query(
          `SELECT r.id,r.status,t.workflow_id,w.name AS title,coalesce(r.customer_organization_id,t.organization_id) AS organization_id,o.name AS organization_name,a.engagement_id,r.created_at FROM run r JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id JOIN organization o ON o.id=coalesce(r.customer_organization_id,t.organization_id) LEFT JOIN engagement_attempt a ON a.run_id=r.id WHERE r.status='waiting' ORDER BY r.created_at DESC LIMIT 100`,
        ),
        pool.query(
          `SELECT e.id,e.name AS title,a.run_id,a.id AS attempt_id,coalesce(e.customer_organization_id,e.organization_id) AS organization_id,o.name AS organization_name,a.revision,a.stage_index,e.stages FROM engagement e JOIN organization o ON o.id=coalesce(e.customer_organization_id,e.organization_id) JOIN LATERAL (SELECT * FROM engagement_attempt WHERE engagement_id=e.id AND stage_index=e.stage_index ORDER BY revision DESC LIMIT 1) a ON true WHERE a.state='awaiting_approval' AND e.state IN ('awaiting_approval','paused') ORDER BY e.updated_at DESC LIMIT 100`,
        ),
        pool.query(
          `SELECT c.id,c.title,c.kind,c.organization_id,o.name AS organization_name,c.created_at,c.provenance FROM workspace_change c JOIN organization o ON o.id=c.organization_id WHERE c.state='proposed' ORDER BY c.created_at DESC LIMIT 100`,
        ),
      ]);
      return {
        items: [
          ...waiting.rows.map((r) => ({
            id: "run:" + r.id,
            kind: "question_or_review",
            title: r.title,
            organizationId: r.organization_id,
            organizationName: r.organization_name,
            label: "Input needed",
            href:
              "/next/run?run=" +
              r.id +
              (r.engagement_id ? "&engagement=" + r.engagement_id : ""),
          })),
          ...stages.rows.map((e) => ({
            id: "stage:" + e.attempt_id,
            kind: "stage_review",
            title: `Review ${e.stages[e.stage_index]?.name || e.title} · Round ${e.revision}`,
            organizationId: e.organization_id,
            organizationName: e.organization_name,
            label: "Stage review",
            href: "/next/run?engagement=" + e.id + "&run=" + e.run_id,
          })),
          ...changes.rows.map((c) => ({
            id: "change:" + c.id,
            kind: c.kind,
            title: c.title,
            organizationId: c.organization_id,
            organizationName: c.organization_name,
            label: "Proposed change",
            href:
              "/next/organizations?organization=" +
              c.organization_id +
              "&view=changes&change=" +
              c.id,
          })),
        ],
      };
    }),
  );
  app.get(
    "/builder/workflows/:id/versions/:versionId",
    wrap(async (r) => {
      const id = z.uuid().parse(r.params.id),
        v = z.uuid().parse(r.params.versionId);
      const version = (
        await pool.query(
          'SELECT id,workflow_id AS "workflowId",version,goal,sop_markdown AS "sopMarkdown",input_schema AS "inputSchema",output_schema AS "outputSchema",created_by AS "createdBy",created_at AS "createdAt" FROM workflow_version WHERE id=$1 AND workflow_id=$2',
          [v, id],
        )
      ).rows[0];
      if (!version) throw Error("Version not found in this workflow");
      const steps = (
        await pool.query(
          'SELECT id,key,name,position,type,skill_version_id AS "skillVersionId",configuration FROM workflow_step WHERE workflow_version_id=$1 ORDER BY position',
          [v],
        )
      ).rows;
      return { version, steps };
    }),
  );
  app.post(
    "/workspace/:org/products/propose",
    wrap(async (r) => {
      const org = z.uuid().parse(r.params.org),
        body = productBodySchema.parse(r.body);
      return createChange({
        organizationId: org,
        kind: "product",
        targetId: null,
        title: body.name,
        reason: body.productId
          ? "Requested product revision"
          : "Requested new product",
        body,
        provenance: { capture: "human", interface: "next" },
      });
    }),
  );
  app.post(
    "/workspace/:org/products/:id/metadata",
    wrap(async (r) => {
      const org = z.uuid().parse(r.params.org),
        id = z.uuid().parse(r.params.id);
      await requireProduct(org, id);
      const body = z
        .object({
          name: z.string().trim().min(1).max(160),
          description: z.string().trim().max(2000),
          revision: z.number().int().min(0),
        })
        .parse(r.body);
      const result =
        body.revision === 0
          ? await pool.query(
              'INSERT INTO product_metadata(product_id,organization_id,name,description) VALUES($1,$2,$3,$4) ON CONFLICT(product_id) DO NOTHING RETURNING name,description,revision AS "metadataRevision"',
              [id, org, body.name, body.description],
            )
          : await pool.query(
              'UPDATE product_metadata SET name=$3,description=$4,revision=revision+1,updated_at=now() WHERE product_id=$1 AND organization_id=$2 AND revision=$5 RETURNING name,description,revision AS "metadataRevision"',
              [id, org, body.name, body.description, body.revision],
            );
      if (!result.rowCount)
        throw Object.assign(
          Error("Product details changed. Reload before saving."),
          { statusCode: 409 },
        );
      await pool.query("UPDATE platform_product SET name=$3,description=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2", [id,org,body.name,body.description]);
      return result.rows[0];
    }),
  );
}
