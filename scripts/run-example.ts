import { syntheticInput } from "./seed";
import { pool } from "../packages/database/src";
const base = process.env.API_URL ?? "http://localhost:3000";
async function request(path: string, init?: RequestInit) {
  const response = await fetch(base + path, init);
  if (!response.ok)
    throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function main() {
  const workflows = (await request("/workflows")) as {
    id: string;
    slug: string;
  }[];
  const workflow = workflows.find(
    (w) => w.slug === "obituary-property-lead-research",
  );
  if (!workflow) throw new Error("Seed workflow not found; run pnpm db:seed");
  const run = await request(`/workflows/${workflow.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: syntheticInput }),
  });
  console.log(
    `Task created: ${run.taskId}\nRun created: ${run.id}\nTemporal Workflow ID: ${run.temporalWorkflowId}`,
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await request(`/runs/${run.id}`);
    if (
      ["completed", "failed", "cancelled", "waiting"].includes(current.status)
    ) {
      for (const step of current.steps)
        console.log(`Step: ${step.key.padEnd(22)} ${step.status}`);
      console.log(
        `Run ${current.status}\n${JSON.stringify(current.output, null, 2)}`,
      );
      if (current.status !== "completed")
        throw new Error(
          current.error ?? `Unexpected status: ${current.status}`,
        );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for Run");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
