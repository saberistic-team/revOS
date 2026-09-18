import { pool } from "../../database/src";
import { z } from "zod";
export const productBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  brief: z.string().trim().min(1).max(10000),
  productId: z.uuid().nullable().optional(),
});
/** Stable product identities retain the original build-root IDs and immutable build history. */
export async function organizationProducts(org: string) {
  const rows = (
    await pool.query(
      "SELECT id,parent_id,product_id,run_id,brief,state,result,error,created_at FROM code_build WHERE organization_id=$1 ORDER BY created_at",
      [org],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const metadata = new Map(
    (
      await pool.query(
        "SELECT product_id,name,description,revision FROM product_metadata WHERE organization_id=$1",
        [org],
      )
    ).rows.map((r) => [r.product_id, r]),
  );
  const records = (
    await pool.query(
      "SELECT id,name,description,revision,owner_person_id,repository_url,runtime_kind,state FROM platform_product WHERE organization_id=$1 ORDER BY created_at",
      [org],
    )
  ).rows;
  const groups = new Map<string, any>(
    records.map((p) => [
      p.id,
      {
        id: p.id,
        name: p.name,
        brief: p.description,
        description: p.description,
        metadataRevision: p.revision,
        ownerPersonId: p.owner_person_id,
        repositoryUrl: p.repository_url,
        runtimeKind: p.runtime_kind,
        state: p.state,
        versions: [],
        latestBuild: null,
        previewBuild: null,
      },
    ]),
  );
  for (const row of rows) {
    let root = row;
    const seen = new Set<string>();
    while (root.parent_id && byId.has(root.parent_id) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parent_id);
    }
    const productId = row.product_id || root.id;
    const p = groups.get(productId) || {
      id: root.id,
      name:
        metadata.get(root.id)?.name ||
        root.brief
          .split("\n")[0]
          .replace(/^Product: /, "")
          .replace(/^#+\s*/, "")
          .slice(0, 160),
      brief: root.brief,
      description: metadata.get(root.id)?.description || "",
      metadataRevision: metadata.get(root.id)?.revision || 0,
      versions: [],
      latestBuild: row,
      previewBuild: null,
    };
    p.versions.push(row);
    p.latestBuild = row;
    if (row.state === "completed" && row.result?.previewUrl)
      p.previewBuild = row;
    groups.set(productId, p);
  }
  const deployments = (
    await pool.query(
      "SELECT product_id,environment,state,url FROM product_release WHERE organization_id=$1 ORDER BY updated_at",
      [org],
    )
  ).rows;
  for (const product of groups.values())
    product.previewUrl = product.previewBuild?.result?.previewUrl ?? null;
  for (const release of deployments) {
    const product = groups.get(release.product_id);
    if (product && release.state === "healthy")
      product[release.environment === "live" ? "liveUrl" : "previewUrl"] =
        release.url;
  }
  return [...groups.values()].reverse();
}
export async function requireProduct(org: string, id: string) {
  z.uuid().parse(id);
  const product = (await organizationProducts(org)).find((p) => p.id === id);
  if (!product) throw Error("Product not found in this organization");
  return product;
}
