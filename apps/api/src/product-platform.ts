import type { FastifyInstance } from "fastify";
import {
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { z } from "zod";
import { pool } from "../../../packages/database/src";
import { taskQueue } from "../../../packages/temporal/src/config";
import {
  campaignDetail,
  decideRequirement,
  listCampaigns,
  listPlatformProducts,
  productDetail,
  requirementHistory,
  saveCampaign,
  saveProduct,
  saveRequirement,
  startCampaign,
} from "../../../packages/engine/src/product-platform";
import {
  configureFees,
  createRate,
  reconcileUsage,
  setBudget,
  usageSummary,
} from "../../../packages/engine/src/usage-ledger";
import {
  collectDueUsage,
  collectOrganizationUsage,
  collectionStatus,
  configureCollection,
  ingestProductUsage,
  rotateUsageCredential,
} from "../../../packages/engine/src/usage-collectors";

export function registerProductPlatform(app: FastifyInstance, client: Client) {
  const base = "/organizations/:org/platform";
  const wrap = (fn: (r: any) => Promise<any>) => async (r: any, reply: any) => {
    try {
      z.uuid().parse(r.params.org);
      if (r.params.id) z.uuid().parse(r.params.id);
      return await fn(r);
    } catch (e: any) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  };
  const queryId = (v: any) => (v ? z.uuid().parse(v) : undefined);
  app.get(
    base + "/products",
    wrap((r) => listPlatformProducts(r.params.org)),
  );
  app.post(
    base + "/products",
    wrap((r) => saveProduct(r.params.org, r.body)),
  );
  app.get(
    base + "/products/:id",
    wrap((r) => productDetail(r.params.org, r.params.id)),
  );
  app.patch(
    base + "/products/:id",
    wrap((r) =>
      saveProduct(
        r.params.org,
        r.body,
        r.params.id,
        z.number().int().positive().parse(r.body.revision),
      ),
    ),
  );
  app.get(
    base + "/campaigns",
    wrap((r) => listCampaigns(r.params.org, queryId(r.query.product))),
  );
  app.post(
    base + "/campaigns",
    wrap((r) => saveCampaign(r.params.org, r.body)),
  );
  app.get(
    base + "/campaigns/:id",
    wrap((r) => campaignDetail(r.params.org, r.params.id)),
  );
  app.patch(
    base + "/campaigns/:id",
    wrap((r) =>
      saveCampaign(
        r.params.org,
        r.body,
        r.params.id,
        z.number().int().positive().parse(r.body.revision),
      ),
    ),
  );
  app.post(
    base + "/campaigns/:id/start",
    wrap(async (r) => {
      const campaign = await startCampaign(r.params.org, r.params.id, r.body);
      try {
        await client.workflow.start("EngagementWorkflow", {
          workflowId: "engagement:" + campaign.engagement_id,
          taskQueue,
          args: [campaign.engagement_id],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          retry: { initialInterval: "5 seconds", maximumInterval: "1 minute" },
        });
      } catch (e) {
        if (!(e instanceof WorkflowExecutionAlreadyStartedError))
          return {
            ...campaign,
            dispatchPending: true,
            dispatchMessage:
              "Saved. The workflow dispatcher will retry starting this engagement.",
          };
      }
      return campaign;
    }),
  );
  app.post(
    base + "/campaigns/:id/requirements",
    wrap((r) => saveRequirement(r.params.org, r.params.id, r.body)),
  );
  app.patch(
    base + "/requirements/:id",
    wrap((r) =>
      saveRequirement(
        r.params.org,
        z.uuid().parse(r.body.campaignId),
        r.body,
        r.params.id,
        z.number().int().positive().parse(r.body.revision),
      ),
    ),
  );
  app.post(
    base + "/requirements/:id/decision",
    wrap((r) => decideRequirement(r.params.org, r.params.id, r.body)),
  );
  app.get(
    base + "/requirements/:id/history",
    wrap((r) => requirementHistory(r.params.org, r.params.id)),
  );
  app.get(
    base + "/usage",
    wrap((r) =>
      usageSummary(r.params.org, {
        productId: queryId(r.query.product),
        campaignId: queryId(r.query.campaign),
        month: r.query.month,
      }),
    ),
  );
  app.get(
    base + "/usage/collection",
    wrap((r) => collectionStatus(r.params.org)),
  );
  app.put(
    base + "/usage/collection",
    wrap((r) => configureCollection(r.params.org, r.body)),
  );
  app.post(
    base + "/usage/collect",
    wrap((r) => collectOrganizationUsage(r.params.org)),
  );
  app.post(base + "/products/:id/usage-credential", async (r: any, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return await rotateUsageCredential(
        z.uuid().parse(r.params.org),
        z.uuid().parse(r.params.id),
      );
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.post("/product-usage/:id/events", async (r: any, reply) => {
    try {
      return await ingestProductUsage(
        z.uuid().parse(r.params.id),
        String(r.headers.authorization || "").replace(/^Bearer /i, ""),
        r.body,
      );
    } catch (e: any) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });
  app.post(
    base + "/usage/rates",
    wrap((r) => createRate(r.params.org, r.body)),
  );
  app.post(
    base + "/usage/budgets",
    wrap((r) => setBudget(r.params.org, r.body)),
  );
  app.post(
    base + "/usage/fees",
    wrap((r) => configureFees(r.params.org, r.body)),
  );
  app.post(
    base + "/usage/:id/reconcile",
    wrap((r) => reconcileUsage(r.params.org, r.params.id, r.body)),
  );
  app.get(
    base + "/participants",
    wrap(
      async (r) =>
        (
          await pool.query(
            "SELECT id,name,email,role FROM organization_person WHERE organization_id=$1 ORDER BY name",
            [r.params.org],
          )
        ).rows,
    ),
  );
  let collecting = false;
  const collect = async () => {
    if (collecting || process.env.PLATFORM_DISPATCH_ENABLED !== "true") return;
    collecting = true;
    try {
      await collectDueUsage();
    } catch (e) {
      app.log.error(e, "Usage collection failed");
    } finally {
      collecting = false;
    }
  };
  const sweep = setInterval(() => void collect(), 60000);
  sweep.unref();
  app.addHook("onReady", async () => {
    void collect();
  });
  app.addHook("onClose", async () => clearInterval(sweep));
}
