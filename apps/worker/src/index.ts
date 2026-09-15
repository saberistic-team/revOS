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
import { pool } from "../../../packages/database/src";
async function main() {
  const registry = new ToolRegistry();
  registerDemoTools(registry);
  const connection = await connectWithRetry(() =>
    NativeConnection.connect(connectionOptions()),
  );
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath:
      require.resolve("../../../packages/temporal/src/workflows/agent-run"),
    activities: createActivities(registry, modelProvider()),
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
  process.exitCode = 1;
});
