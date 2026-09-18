import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool } from "../../database/src";
import {
  campaignSchema,
  productSchema,
  requirementSchema,
  requirementDecisionSchema,
} from "../../shared/src/product-platform";
import { createEngagement } from "./engagement";
import { ledgerTransaction } from "./usage-ledger";

type Queryable = Pick<PoolClient, "query">;
type CreationOptions = { id?: string; client?: Queryable };
async function withClient<T>(
  options: CreationOptions,
  fn: (c: Queryable) => Promise<T>,
) {
  if (options.client) return fn(options.client);
  return ledgerTransaction(fn);
}
async function requireScoped(
  c: Queryable,
  table: string,
  org: string,
  id?: string | null,
) {
  if (!id) return null;
  const row = (
    await c.query(`SELECT * FROM ${table} WHERE id=$1 AND organization_id=$2`, [
      id,
      org,
    ])
  ).rows[0];
  if (!row) throw Error("Record not found in this organization");
  return row;
}
export async function validateParticipants(
  c: Queryable,
  org: string,
  ids: (string | null | undefined)[],
) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (
    unique.length &&
    (
      await c.query(
        "SELECT id FROM organization_person WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [org, unique],
      )
    ).rowCount !== unique.length
  )
    throw Error("A participant does not belong to this organization");
}
/** Stable IDs let an approved assistant proposal be retried without creating another product. */
export async function createProduct(
  org: string,
  raw: unknown,
  options: CreationOptions = {},
) {
  const b = productSchema.parse(raw),
    id = options.id ? z.uuid().parse(options.id) : randomUUID();
  return withClient(options, async (c) => {
    await validateParticipants(c, org, [b.ownerPersonId]);
    const inserted = (
      await c.query(
        "INSERT INTO platform_product(id,organization_id,name,description,owner_person_id,repository_url,runtime_kind) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *",
        [
          id,
          org,
          b.name,
          b.description,
          b.ownerPersonId ?? null,
          b.repositoryUrl,
          b.runtimeKind,
        ],
      )
    ).rows[0];
    return inserted || requireScoped(c, "platform_product", org, id);
  });
}
export async function createCampaign(
  org: string,
  raw: unknown,
  options: CreationOptions = {},
) {
  const b = campaignSchema.parse(raw),
    id = options.id ? z.uuid().parse(options.id) : randomUUID();
  return withClient(options, async (c) => {
    await requireScoped(c, "platform_product", org, b.productId);
    await validateParticipants(c, org, [b.ownerPersonId, ...b.stakeholderIds]);
    const row = (
      await c.query(
        "INSERT INTO platform_campaign(id,organization_id,product_id,name,objective,success_measure,owner_person_id,stakeholder_ids,budget_micros,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING *",
        [
          id,
          org,
          b.productId ?? null,
          b.name,
          b.objective,
          b.successMeasure,
          b.ownerPersonId ?? null,
          [...new Set(b.stakeholderIds)],
          b.budgetMicros ?? null,
          b.currency,
        ],
      )
    ).rows[0];
    return row || requireScoped(c, "platform_campaign", org, id);
  });
}
export async function createRequirement(
  org: string,
  campaignId: string,
  raw: unknown,
  options: CreationOptions = {},
) {
  const b = requirementSchema.parse(raw),
    id = options.id ? z.uuid().parse(options.id) : randomUUID();
  return withClient(options, async (c) => {
    await requireScoped(c, "platform_campaign", org, campaignId);
    const inserted = await c.query(
      "INSERT INTO platform_requirement(id,organization_id,campaign_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING *",
      [id, org, campaignId],
    );
    if (!inserted.rowCount) {
      const row = await requireScoped(c, "platform_requirement", org, id);
      if (row.campaign_id !== campaignId)
        throw Error("Requirement belongs to another campaign");
      return row;
    }
    await c.query(
      "INSERT INTO requirement_revision(requirement_id,revision,title,description,acceptance_criteria,evidence,author) VALUES($1,1,$2,$3,$4,$5,$6)",
      [
        id,
        b.title,
        b.description,
        JSON.stringify(b.acceptanceCriteria),
        JSON.stringify(b.evidence),
        b.author,
      ],
    );
    return inserted.rows[0];
  });
}
export async function listPlatformProducts(org: string) {
  return (
    await pool.query(
      `SELECT p.*,o.name AS owner_name,
    (SELECT count(*)::int FROM platform_campaign WHERE product_id=p.id AND organization_id=p.organization_id) AS campaign_count,
    (SELECT count(*)::int FROM code_build WHERE product_id=p.id AND organization_id=p.organization_id) AS build_count,
    (SELECT jsonb_build_object('id',id,'state',state,'result',result,'createdAt',created_at) FROM code_build WHERE product_id=p.id AND organization_id=p.organization_id ORDER BY created_at DESC LIMIT 1) AS latest_build,
    coalesce((SELECT url FROM product_release WHERE product_id=p.id AND organization_id=p.organization_id AND state='healthy' AND environment='preview' ORDER BY updated_at DESC LIMIT 1),(SELECT result->>'previewUrl' FROM code_build WHERE product_id=p.id AND organization_id=p.organization_id AND state='completed' AND result->>'previewUrl' IS NOT NULL ORDER BY created_at DESC LIMIT 1)) AS preview_url,
    (SELECT url FROM product_release WHERE product_id=p.id AND organization_id=p.organization_id AND state='healthy' AND environment='live' ORDER BY updated_at DESC LIMIT 1) AS live_url
    FROM platform_product p LEFT JOIN organization_person o ON o.id=p.owner_person_id AND o.organization_id=p.organization_id WHERE p.organization_id=$1 ORDER BY p.updated_at DESC`,
      [org],
    )
  ).rows;
}
export async function saveProduct(
  org: string,
  raw: unknown,
  id?: string,
  revision?: number,
) {
  const b = productSchema.parse(raw);
  return ledgerTransaction(async (c) => {
    await validateParticipants(c, org, [b.ownerPersonId]);
    if (id) {
      const row = (
        await c.query(
          "UPDATE platform_product SET name=$3,description=$4,owner_person_id=$5,repository_url=$6,runtime_kind=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2 AND revision=$8 RETURNING *",
          [
            id,
            org,
            b.name,
            b.description,
            b.ownerPersonId ?? null,
            b.repositoryUrl,
            b.runtimeKind,
            revision,
          ],
        )
      ).rows[0];
      if (!row)
        throw Error("Product changed or is missing; reload before saving");
      // Preserve older surfaces that read build-root metadata, when a historical root exists.
      await c.query(
        "UPDATE product_metadata SET name=$3,description=$4,revision=revision+1,updated_at=now() WHERE product_id=$1 AND organization_id=$2",
        [id, org, b.name, b.description],
      );
      return row;
    }
    return (
      await c.query(
        "INSERT INTO platform_product(organization_id,name,description,owner_person_id,repository_url,runtime_kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          org,
          b.name,
          b.description,
          b.ownerPersonId ?? null,
          b.repositoryUrl,
          b.runtimeKind,
        ],
      )
    ).rows[0];
  });
}
export async function listCampaigns(org: string, productId?: string) {
  if (productId) await requireScoped(pool, "platform_product", org, productId);
  return (
    await pool.query(
      "SELECT c.*,p.name AS product_name,o.name AS owner_name,e.state AS engagement_state,(SELECT count(*)::int FROM platform_requirement r WHERE r.campaign_id=c.id AND r.state='proposed') AS pending_requirements FROM platform_campaign c LEFT JOIN platform_product p ON p.id=c.product_id LEFT JOIN organization_person o ON o.id=c.owner_person_id LEFT JOIN engagement e ON e.id=c.engagement_id WHERE c.organization_id=$1 AND ($2::uuid IS NULL OR c.product_id=$2) ORDER BY c.updated_at DESC",
      [org, productId ?? null],
    )
  ).rows;
}
export async function saveCampaign(
  org: string,
  raw: unknown,
  id?: string,
  revision?: number,
) {
  const b = campaignSchema.parse(raw);
  return ledgerTransaction(async (c) => {
    await requireScoped(c, "platform_product", org, b.productId);
    await validateParticipants(c, org, [b.ownerPersonId, ...b.stakeholderIds]);
    const values = [
      org,
      b.productId ?? null,
      b.name,
      b.objective,
      b.successMeasure,
      b.ownerPersonId ?? null,
      [...new Set(b.stakeholderIds)],
      b.budgetMicros ?? null,
      b.currency,
    ];
    if (!id)
      return (
        await c.query(
          "INSERT INTO platform_campaign(organization_id,product_id,name,objective,success_measure,owner_person_id,stakeholder_ids,budget_micros,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          values,
        )
      ).rows[0];
    const current = (
      await c.query(
        "SELECT product_id,engagement_id FROM platform_campaign WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      )
    ).rows[0];
    if (!current) throw Error("Campaign not found in this organization");
    if (current.engagement_id && current.product_id !== (b.productId ?? null))
      throw Error("The product cannot change after this campaign has started");
    const row = (
      await c.query(
        "UPDATE platform_campaign SET product_id=$2,name=$3,objective=$4,success_measure=$5,owner_person_id=$6,stakeholder_ids=$7,budget_micros=$8,currency=$9,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$10 AND revision=$11 AND state NOT IN ('completed','cancelled') RETURNING *",
        [...values, id, revision],
      )
    ).rows[0];
    if (!row) throw Error("Campaign changed, completed or is missing; reload");
    return row;
  });
}
export async function campaignDetail(org: string, id: string) {
  const campaign = await requireScoped(pool, "platform_campaign", org, id);
  const requirements = (
    await pool.query(
      "SELECT r.*,v.title,v.description,v.acceptance_criteria,v.evidence,v.author,d.action AS decision,d.actor AS decision_by,d.feedback AS decision_feedback FROM platform_requirement r JOIN requirement_revision v ON v.requirement_id=r.id AND v.revision=r.current_revision LEFT JOIN requirement_decision d ON d.requirement_id=r.id AND d.revision=r.current_revision WHERE r.organization_id=$1 AND r.campaign_id=$2 ORDER BY r.created_at",
      [org, id],
    )
  ).rows;
  return { ...campaign, requirements };
}
export async function startCampaign(org: string, id: string, raw: unknown) {
  const b = z
    .object({ templateId: z.uuid(), input: z.record(z.string(), z.unknown()) })
    .parse(raw);
  return ledgerTransaction(async (c) => {
    const campaign = (
      await c.query(
        "SELECT * FROM platform_campaign WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      )
    ).rows[0];
    if (!campaign) throw Error("Campaign not found");
    if (campaign.engagement_id) return { ...campaign, alreadyStarted: true };
    if (campaign.state !== "draft")
      throw Error("Campaign cannot be started in this state");
    const engagement = await createEngagement(
      b.templateId,
      b.input,
      campaign.name,
      org,
      { queryClient: c, id: randomUUID() },
    );
    return (
      await c.query(
        "UPDATE platform_campaign SET engagement_id=$3,state='running',revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",
        [id, org, engagement.id],
      )
    ).rows[0];
  });
}
export function assertRequirementRevision(
  row: { current_revision: number; state: string },
  revision: number,
  decision = false,
) {
  if (row.current_revision !== revision)
    throw Error(
      "This requirement has a newer revision; reload before reviewing",
    );
  if (decision && row.state !== "proposed")
    throw Error(
      "This revision already has a decision; propose a revision to change it",
    );
}
export async function saveRequirement(
  org: string,
  campaignId: string,
  raw: unknown,
  id?: string,
  expectedRevision?: number,
) {
  const b = requirementSchema.parse(raw);
  return ledgerTransaction(async (c) => {
    await requireScoped(c, "platform_campaign", org, campaignId);
    let revision = 1,
      requirementId = id;
    if (id) {
      const row = (
        await c.query(
          "SELECT * FROM platform_requirement WHERE id=$1 AND campaign_id=$2 AND organization_id=$3 FOR UPDATE",
          [id, campaignId, org],
        )
      ).rows[0];
      if (!row) throw Error("Requirement not found");
      assertRequirementRevision(row, expectedRevision ?? 0);
      revision = row.current_revision + 1;
      await c.query(
        "UPDATE platform_requirement SET current_revision=$2,state='proposed',updated_at=now() WHERE id=$1",
        [id, revision],
      );
    } else
      requirementId = (
        await c.query(
          "INSERT INTO platform_requirement(organization_id,campaign_id) VALUES($1,$2) RETURNING id",
          [org, campaignId],
        )
      ).rows[0].id;
    return (
      await c.query(
        "INSERT INTO requirement_revision(requirement_id,revision,title,description,acceptance_criteria,evidence,author) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          requirementId,
          revision,
          b.title,
          b.description,
          JSON.stringify(b.acceptanceCriteria),
          JSON.stringify(b.evidence),
          b.author,
        ],
      )
    ).rows[0];
  });
}
export async function decideRequirement(org: string, id: string, raw: unknown) {
  const b = requirementDecisionSchema.parse(raw);
  return ledgerTransaction(async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM platform_requirement WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, org],
      )
    ).rows[0];
    if (!row) throw Error("Requirement not found");
    assertRequirementRevision(row, b.revision, true);
    const state = {
      approve: "approved",
      request_changes: "changes_requested",
      reject: "rejected",
    }[b.action];
    await c.query(
      "INSERT INTO requirement_decision(requirement_id,revision,action,actor,feedback) VALUES($1,$2,$3,$4,$5)",
      [id, b.revision, b.action, b.actor, b.feedback],
    );
    return (
      await c.query(
        "UPDATE platform_requirement SET state=$2,updated_at=now() WHERE id=$1 RETURNING *",
        [id, state],
      )
    ).rows[0];
  });
}
export async function requirementHistory(org: string, id: string) {
  await requireScoped(pool, "platform_requirement", org, id);
  return (
    await pool.query(
      "SELECT v.*,d.action,d.actor AS decision_by,d.feedback,d.created_at AS decided_at FROM requirement_revision v LEFT JOIN requirement_decision d ON d.requirement_id=v.requirement_id AND d.revision=v.revision WHERE v.requirement_id=$1 ORDER BY v.revision DESC",
      [id],
    )
  ).rows;
}
export async function productDetail(org: string, id: string) {
  const product = await requireScoped(pool, "platform_product", org, id);
  const [campaigns, releases, deployments] = await Promise.all([
    listCampaigns(org, id),
    pool.query(
      "SELECT id,parent_id,run_id,state,result,error,brief,created_at,updated_at FROM code_build WHERE organization_id=$1 AND product_id=$2 ORDER BY created_at DESC",
      [org, id],
    ),
    pool.query(
      "SELECT id,environment,state,url,build_id,source_commit,updated_at FROM product_release WHERE organization_id=$1 AND product_id=$2 ORDER BY updated_at DESC",
      [org, id],
    ),
  ]);
  return {
    ...product,
    campaigns,
    releases: releases.rows,
    deployments: deployments.rows,
    preview_url:
      deployments.rows.find(
        (r) => r.state === "healthy" && r.environment === "preview",
      )?.url ??
      releases.rows.find((r) => r.state === "completed" && r.result?.previewUrl)
        ?.result.previewUrl ??
      null,
    live_url:
      deployments.rows.find(
        (r) => r.state === "healthy" && r.environment === "live",
      )?.url ?? null,
  };
}
