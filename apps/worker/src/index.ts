import { registerServiceTools, serviceToolDefinitions, tickServiceRelease } from "../../../packages/engine/src/service-delivery";
import { meteredActivities } from "../../../packages/temporal/src/activities/usage";
import {
  registerParticipationTools,
  participationToolDefinitions,
} from "../../../packages/engine/src/participation";
import { createParticipationActivities } from "../../../packages/temporal/src/activities/participation";
import {
  registerCodeTools,
  codeToolDefinitions,
  tickCodeBuild,
  requireCompletedBuild,
} from "../../../packages/engine/src/code-builds";
import {
  tickEngagement,
  isRunPaused,
  shouldImportRun,
} from "../../../packages/engine/src/engagement";
import {
  registerKnowledgeTools,
  knowledgeToolDefinitions,
} from "../../../packages/engine/src/knowledge-tools";
import { createWorkspaceActivities } from "../../../packages/temporal/src/activities/workspace";
import { Worker, NativeConnection } from "@temporalio/worker";
import { createActivities } from "../../../packages/temporal/src/activities";
import {
  connectionOptions,
  namespace,
  taskQueue,
  connectWithRetry,
} from "../../../packages/temporal/src/config";
import { ToolRegistry } from "../../../packages/engine/src";
import { modelProvider } from "../../../packages/engine/src/providers";
import { registerDemoTools } from "./demo-tools";
import { registerWebResearch } from "../../../packages/engine/src/web-research";
import { pool, db, tools } from "../../../packages/database/src";
import { createSessionActivities } from "../../../packages/temporal/src/activities/sessions";
import { createArtifactActivities } from "../../../packages/temporal/src/activities/artifacts";
async function main() {
  const registry = new ToolRegistry();
  registerDemoTools(registry);
  registerWebResearch(registry);
  registerKnowledgeTools(registry);
  registerCodeTools(registry);
  registerServiceTools(registry);
  registerParticipationTools(registry);
  await db
    .insert(tools)
    .values(participationToolDefinitions)
    .onConflictDoNothing({ target: tools.slug });
  for (const definition of [...codeToolDefinitions, ...serviceToolDefinitions]) {
    await db.insert(tools).values(definition).onConflictDoUpdate({
      target: tools.slug,
      set: { name:definition.name, description:definition.description, inputSchema:definition.inputSchema,
        outputSchema:definition.outputSchema, handler:definition.handler },
    });
  }
  await db
    .insert(tools)
    .values(knowledgeToolDefinitions)
    .onConflictDoNothing({ target: tools.slug });
  const connection = await connectWithRetry(() =>
    NativeConnection.connect(connectionOptions()),
  );
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath:
      require.resolve("../../../packages/temporal/src/workflows/agent-run"),
    activities: meteredActivities({
      tickEngagement,
      isRunPaused,
      shouldImportRun,
      tickCodeBuild,
      tickServiceRelease,
      requireCompletedBuild,
      ...createActivities(registry, modelProvider()),
      ...createSessionActivities(registry),
      ...createArtifactActivities(),
      ...createWorkspaceActivities(),
      ...createParticipationActivities(),
    }),
  });
  console.log(
    `Worker ready: ${connectionOptions().address}, namespace=${namespace}, queue=${taskQueue}`,
  );
  try {
    await worker.run();
  } finally {
    await connection.close();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  // A failed Worker.create can leave native connection handles alive. Exit so
  // Kubernetes restarts the process instead of reporting an idle worker ready.
  process.exit(1);
});
