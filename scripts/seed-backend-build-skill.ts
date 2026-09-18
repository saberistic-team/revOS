import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pool } from "../packages/database/src";
import { codeToolDefinitions } from "../packages/engine/src/code-builds";
import { serviceToolDefinitions } from "../packages/engine/src/service-delivery";

export const backendBuildSkill = {
  name: "Build and release customer product",
  slug: "build-and-release-customer-product",
  description:
    "Build or revise the campaign’s configured product, prepare a reviewed deployment, and verify the delivered service.",
  instructions: `Use the existing product bound to this campaign. Read input.campaignContext and approved prior-stage findings; never invent product IDs, repositories, credentials, requirements, or hosting settings. When productId is available, use openhands.inspect_delivery to inspect its saved runtime and hosting configuration. If no product is bound or required configuration is missing, ask the operator to choose/create the product and configure Hosting; wait for their response before building. Do not guess a port, database, secret, production environment, or deployment approval.\nUse openhands.start_build for a genuinely new product implementation. For feedback on an existing product, inspect its latest completed build and use openhands.revise_build with that buildId, the same productId, and the specific approved feedback; preserve the existing repository and source history. The engine waits durably for the coding job. Inspect the completed build, source commit, test results, and reported limitations. A coding completion is not a deployment.\nFor a backend service, call openhands.prepare_release with the completed buildId and environment preview unless the operator explicitly requested live. This prepares the release and the engine waits durably for explicit human deployment approval and verified health. You must never approve a deployment yourself or claim it is already approved. Then use openhands.inspect_delivery to verify the actual release state and available URL. If approval is rejected or deployment is unhealthy, report that status and ask for the necessary change; do not declare success. For a static product only, use openhands.create_preview on its completed build.\nReturn verified source and preview links, commit/build identifiers, executed tests and their outcomes, known limitations, and the current release state. A live or preview URL is usable only after the release reports healthy. During research/proposal stages create a product prototype only when the stage goal or user calls for it; otherwise explain findings and use report artifacts. Respect stage reviews and customer corrections.`,
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string" },
      productId: { type: ["string", "null"] },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      productId: { type: ["string", "null"] },
      buildId: { type: ["string", "null"] },
      sourceUrl: { type: ["string", "null"] },
      previewUrl: { type: ["string", "null"] },
      tests: { type: "array", items: { type: "string" } },
      deploymentState: { type: "string" },
      limitations: { type: "array", items: { type: "string" } },
    },
    required: [
      "summary",
      "productId",
      "buildId",
      "sourceUrl",
      "previewUrl",
      "tests",
      "deploymentState",
      "limitations",
    ],
    additionalProperties: false,
  },
};
export async function seedBackendBuildSkill() {
  const required = [
    "openhands.start_build",
    "openhands.revise_build",
    "openhands.inspect_build",
    "openhands.create_preview",
    "openhands.prepare_release",
    "openhands.inspect_delivery",
  ];
  const definitions = [
    ...codeToolDefinitions,
    ...serviceToolDefinitions,
  ].filter((d) => required.includes(d.handler));
  if (
    required.some((handler) => !definitions.some((d) => d.handler === handler))
  )
    throw Error(
      "The backend delivery tool definitions must be installed before seeding this skill",
    );
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('seed-backend-build-skill'))",
    );
    const org = (
      await c.query(
        "SELECT id FROM organization WHERE kind='platform' ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!org) throw Error("Platform organization not found");
    const toolIds: string[] = [];
    for (const d of definitions) {
      const row = (
        await c.query(
          "INSERT INTO tool(name,slug,handler,description,input_schema,output_schema) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,handler=excluded.handler,description=excluded.description,input_schema=excluded.input_schema,output_schema=excluded.output_schema RETURNING id",
          [
            d.name,
            d.slug,
            d.handler,
            d.description,
            JSON.stringify(d.inputSchema),
            JSON.stringify(d.outputSchema),
          ],
        )
      ).rows[0];
      toolIds.push(row.id);
    }
    const d = backendBuildSkill,
      skill = (
        await c.query(
          "INSERT INTO skill(organization_id,name,slug,description) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,slug) DO UPDATE SET name=excluded.name,description=excluded.description RETURNING id",
          [org.id, d.name, d.slug, d.description],
        )
      ).rows[0];
    const latest = (
      await c.query(
        "SELECT * FROM skill_version WHERE skill_id=$1 ORDER BY version DESC LIMIT 1",
        [skill.id],
      )
    ).rows[0];
    const configuration = { allowedToolIds: toolIds, allowedKnowledgeIds: [] };
    let result;
    if (
      latest &&
      latest.instructions === d.instructions &&
      isDeepStrictEqual(latest.input_schema, d.inputSchema) &&
      isDeepStrictEqual(latest.output_schema, d.outputSchema) &&
      isDeepStrictEqual(latest.configuration, configuration)
    )
      result = {
        skillId: skill.id,
        versionId: latest.id,
        version: latest.version,
        name: d.name,
      };
    else {
      const id = randomUUID(),
        version = (latest?.version || 0) + 1;
      await c.query(
        "INSERT INTO skill_version(id,skill_id,version,instructions,execution_type,input_schema,output_schema,configuration) VALUES($1,$2,$3,$4,'agent',$5,$6,$7)",
        [
          id,
          skill.id,
          version,
          d.instructions,
          JSON.stringify(d.inputSchema),
          JSON.stringify(d.outputSchema),
          JSON.stringify(configuration),
        ],
      );
      result = { skillId: skill.id, versionId: id, version, name: d.name };
    }
    await c.query("COMMIT");
    return { ...result, toolIds };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
if (require.main === module)
  seedBackendBuildSkill()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .finally(() => pool.end());
