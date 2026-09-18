import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadWorkflow(file: string, runtime: any) {
  const compiled = ts.transpileModule(
    readFileSync(
      resolve(__dirname, "../packages/temporal/src/workflows/" + file),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const result: any = {};
  vm.runInNewContext(compiled, {
    exports: result,
    require: (name: string) => {
      if (name === "@temporalio/workflow") return runtime;
      if (name.endsWith("reasoning-limits"))
        return {
          REASONING_ACTIVITY_TIMEOUT_MS: 1000,
          REASONING_SCHEDULE_TIMEOUT_MS: 10000,
        };
      throw Error("Unexpected workflow dependency " + name);
    },
  });
  return result;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
for (const state of ["accepted", "rejected"])
  test(`agent loop waits for ${state} review before another reasoning turn`, async () => {
    const log: any[] = [],
      assignment = {
        participationQuestionId: "question",
        organizationId: "organization",
        state: "waiting",
        assignedPersonId: "person",
      };
    let resume!: (v: unknown) => void;
    const deferred = new Promise((r) => (resume = r));
    const activities = {
      openReasoningSession: async () => ({
        id: "session",
        config: { maxTurns: 3 },
      }),
      isRunPaused: async () => false,
      reason: async ({ turn }: any) => {
        log.push(["reason", turn]);
        return turn === 0 ? { action: "call_tool" } : { action: "final" };
      },
      executeSessionTool: async () => {
        log.push(["assign"]);
        return { result: assignment };
      },
      setSessionStatus: async (v: any) => log.push(["session", v.status]),
      saveRunStep: async (v: any) => log.push(["step", v.status]),
      markRunWaiting: async () => log.push(["run", "waiting"]),
      markRunRunning: async () => log.push(["run", "running"]),
      applyAgentDecision: async () => ({ result: { done: true } }),
    };
    const runtime = {
      proxyActivities: () => activities,
      patched: () => true,
      sleep: async () => {},
      startChild: async (name: string, args: any) => {
        log.push(["child", name, args]);
        return { result: () => deferred };
      },
      CancellationScope: { nonCancellable: (fn: any) => fn() },
      isCancellation: () => false,
      ApplicationFailure: { nonRetryable: (msg: string) => Error(msg) },
    };
    const { runAgentLoop } = loadWorkflow("agent-loop.ts", runtime);
    const result = runAgentLoop(
      "run",
      { id: "step" },
      { input: true },
      async () => {},
      async () => {},
    );
    await tick();
    assert.deepEqual(
      log.filter((v) => v[0] === "reason"),
      [["reason", 0]],
    );
    assert(log.some((v) => v[0] === "session" && v[1] === "waiting"));
    assert(!log.some((v) => v[0] === "run" && v[1] === "running"));
    const child = log.find((v) => v[0] === "child");
    assert.equal(child[1], "WaitForParticipationQuestionWorkflow");
    assert.equal(child[2].workflowId, "participation-wait:session:0");
    assert.deepEqual(JSON.parse(JSON.stringify(child[2].args)), [
      { questionId: "question", organizationId: "organization" },
    ]);
    resume({ state, answer: { content: "Reviewed" } });
    assert.deepEqual(JSON.parse(JSON.stringify(await result)), { done: true });
    assert.deepEqual(
      log.filter((v) => v[0] === "reason"),
      [
        ["reason", 0],
        ["reason", 1],
      ],
    );
    assert.equal(log.filter((v) => v[0] === "assign").length, 1);
    assert.deepEqual(assignment, {
      participationQuestionId: "question",
      organizationId: "organization",
      state: "waiting",
      assignedPersonId: "person",
    });
    assert(
      log.findIndex((v) => v[0] === "run" && v[1] === "running") <
        log.findIndex((v) => v[0] === "reason" && v[1] === 1),
    );
  });
for (const state of ["accepted", "rejected"])
  test(`durable participant waiter returns only a reviewed ${state} result`, async () => {
    let reviewed: any = null,
      release!: () => void,
      calls = 0;
    const gate = new Promise<void>((r) => (release = r));
    let completed = false;
    const runtime = {
      proxyActivities: () => ({
        participationReviewedResult: async () => {
          calls++;
          return reviewed;
        },
      }),
      defineSignal: (name: string) => name,
      setHandler: () => {},
      condition: async () => gate,
      continueAsNew: () => {
        throw Error("Unexpected continuation");
      },
    };
    const { WaitForParticipationQuestionWorkflow } = loadWorkflow(
      "participation.ts",
      runtime,
    );
    const pending = WaitForParticipationQuestionWorkflow({
      questionId: "q",
      organizationId: "o",
    }).then((r: any) => {
      completed = true;
      return r;
    });
    await tick();
    assert.equal(calls, 1);
    assert.equal(completed, false);
    reviewed = {
      state,
      questionId: "q",
      questionRevision: 2,
      answer: {
        id: "a",
        respondentName: "Finance owner",
        content: "Attributed answer",
      },
      review: {
        action: state === "accepted" ? "accept" : "reject",
        comment: "Reviewer rationale",
      },
    };
    release();
    assert.deepEqual(await pending, reviewed);
    assert.equal(calls, 2);
  });
