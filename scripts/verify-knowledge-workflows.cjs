// Isolated Temporal verification. No database writes or model calls.
const assert = require("node:assert/strict");
const { Client, Connection } = require("@temporalio/client");
const { Worker, NativeConnection } = require("@temporalio/worker");
(async () => {
  const address = process.env.TEMPORAL_ADDRESS || "localhost:7233",
    connection = await Connection.connect({ address }),
    native = await NativeConnection.connect({ address });
  const client = new Client({ connection });
  const workflowsPath =
    require.resolve("../packages/temporal/src/workflows/agent-run.ts");
  if (process.env.REPLAY_WORKFLOW_ID) {
    const old = await client.workflow
      .getHandle(process.env.REPLAY_WORKFLOW_ID)
      .fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, old);
    console.log("PASS existing history replays");
  }
  const taskQueue = "artifact-verification-" + Date.now(),
    id = taskQueue,
    sessionId = id + "-session";
  const settings = {
    presentation: "report",
    artifacts: { mode: "always", formats: ["pdf"], instructions: "" },
  };
  const sources = [],
    attempts = new Map();
  let complete = false,
    knowledgeCount = 0;
  const worker = await Worker.create({
    connection: native,
    taskQueue,
    workflowsPath,
    activities: {
      resolveRunOrganization:async()=>({state:"resolved"}),
      isRunPaused:async()=>false,
      shouldImportRun:async()=>true,
      prepareRunKnowledgeJob: async () => id,
      executeWorkspaceJob: async () => {
        knowledgeCount++;
      },
      failWorkspaceJob: async () => {
        throw Error("Knowledge import failed");
      },
      loadExecutionDefinition: async () => ({
        workflow: { outputSchema: {} },
        steps: [
          {
            id: "step",
            key: "step",
            name: "Test",
            type: "agent_loop",
            configuration: { outputs: settings, captureKnowledge: true },
            catalog: [{ id: "skill", configuration: { outputs: settings } }],
          },
        ],
      }),
      markRunRunning: async () => {},
      saveRunStep: async () => {},
      completeRun: async () => {
        complete = true;
      },
      failRun: async (e) => {
        throw Error(JSON.stringify(e));
      },
      openReasoningSession: async () => ({
        id: sessionId,
        config: { maxTurns: 3 },
      }),
      reason: async ({ turn }) =>
        turn === 0
          ? { action: "complete_skill", target: "skill" }
          : { action: "final" },
      applyAgentDecision: async () => ({
        result: { summary: "Synthetic fixture" },
      }),
      setSessionStatus: async () => {},
      prepareArtifact: async ({ source }) => {
        sources.push(source);
        return source.sessionId ? "skill-job" : "step-job";
      },
      generateArtifact: async (job) => {
        let n = (attempts.get(job) || 0) + 1;
        attempts.set(job, n);
        if (n === 1) throw Error("synthetic transient download failure");
      },
      failArtifact: async () => {
        throw Error("unexpected permanent artifact failure");
      },
    },
  });
  await worker.runUntil(async () => {
    await client.workflow.execute("AgentRunWorkflow", {
      workflowId: id,
      taskQueue,
      args: [{ runId: id, input: {} }],
    });
    assert.equal(complete, true);
    await Promise.all([
      client.workflow.getHandle(`artifact:${sessionId}:0`).result(),
      client.workflow.getHandle(`artifact:${id}:step:step`).result(),
    ]);
    await client.workflow.getHandle(`knowledge:${id}`).result();
    assert.equal(knowledgeCount, 1);
    console.log("PASS automatic knowledge capture survives parent completion");
    assert.equal(sources.length, 2);
    assert.equal(attempts.get("skill-job"), 2);
    assert.equal(attempts.get("step-job"), 2);
    const history = await client.workflow.getHandle(id).fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history);
    console.log(
      "PASS automatic step and skill artifact children, survive parent completion, retry generation, deterministic replay",
    );
  });
  await native.close();
  await connection.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
