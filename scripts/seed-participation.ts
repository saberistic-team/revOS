import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { pool } from "../packages/database/src";
import { participationToolDefinitions } from "../packages/engine/src/participation";
import {
  stakeholderSkill,
  collectStakeholderInputSkill,
} from "../packages/shared/src/participation";

/** Adds capabilities to the shared catalog without changing any workflow or existing immutable skill version. */
export async function seedParticipation() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('seed-participation'))",
    );
    const org = (
      await client.query(
        "SELECT id FROM organization WHERE kind='platform' ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!org)
      throw Error(
        "Create the platform organization before seeding participation",
      );
    const toolIds: string[] = [];
    for (const d of participationToolDefinitions) {
      const row = (
        await client.query(
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
    const result = [];
    for (const d of [stakeholderSkill, collectStakeholderInputSkill]) {
      const skill = (
        await client.query(
          "INSERT INTO skill(organization_id,name,slug,description) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,slug) DO UPDATE SET name=excluded.name,description=excluded.description RETURNING id",
          [org.id, d.name, d.slug, d.description],
        )
      ).rows[0];
      const existing = (
        await client.query(
          "SELECT * FROM skill_version WHERE skill_id=$1 ORDER BY version DESC LIMIT 1",
          [skill.id],
        )
      ).rows[0];
      const configuration = {
        allowedToolIds: toolIds,
        allowedKnowledgeIds: [],
        model: process.env.OPENAI_MODEL || "gpt-4.1",
      };
      if (
        existing &&
        existing.instructions === d.instructions &&
        isDeepStrictEqual(existing.input_schema, d.inputSchema) &&
        isDeepStrictEqual(existing.output_schema, d.outputSchema) &&
        isDeepStrictEqual(existing.configuration.allowedToolIds, toolIds)
      )
        result.push({
          skillId: skill.id,
          versionId: existing.id,
          version: existing.version,
          name: d.name,
        });
      else {
        const id = randomUUID(),
          version = (existing?.version || 0) + 1;
        await client.query(
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
        result.push({
          skillId: skill.id,
          versionId: id,
          version,
          name: d.name,
        });
      }
    }
    await client.query("COMMIT");
    return { tools: toolIds, skills: result };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
if (require.main === module)
  seedParticipation()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .finally(() => pool.end());
