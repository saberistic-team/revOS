import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicBuildActivity, publicBuildPath, readBuildProgress } from "../packages/engine/src/build-progress";

const id = "32ff4b0f-6838-4aa2-9a09-b966a4e3f616";
test("build activity exposes public tool metadata without reasoning, commands or output", () => {
  const raw = { kind: "ActionEvent", id: "event-1", timestamp: "2026-09-17T12:00:00", tool_name: "file_editor",
    action: { command: "create", path: "/workspace/site/index.html", file_text: "SECRET" },
    thought: "SECRET", reasoning_content: "SECRET", summary: "SECRET", tool_call: { arguments: "SECRET" } };
  assert.deepEqual(publicBuildActivity(raw, "fallback"), { id: "event-1", at: "2026-09-17T12:00:00.000Z", kind: "activity", message: "Creating index.html" });
  assert.equal(publicBuildActivity({ ...raw, tool_name: "terminal", action: { command: "echo SECRET" } }, "fallback")?.message, "Running a command in the build workspace");
  assert.equal(publicBuildActivity({ kind: "ObservationEvent", tool_name: "terminal", observation: { exit_code: 1, output: "SECRET" } }, "fallback")?.kind, "warning");
  assert.equal(publicBuildActivity({ kind: "ReasoningEvent", content: "SECRET" }, "fallback"), null);
  assert.equal(publicBuildActivity({ kind: "ConversationErrorEvent", code: "MaxIterationsReached", detail: "SECRET" }, "fallback")?.message, "OpenHands reached its coding-turn limit before finishing");
  for (const unsafe of ["../other/file", "/etc/passwd", ".env", "nested/.env", "a/../../b", "token?secret", "node_modules/index.js"]) assert.equal(publicBuildPath(unsafe), null);
});

test("running legacy builds expose persisted action metadata and safe generated files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "revos-progress-"));
  try {
    const base = path.join(root, "jobs", id);
    const events = path.join(base, "conversation", id.replaceAll("-", ""), "events");
    await mkdir(events, { recursive: true });
    await mkdir(path.join(base, "site"), { recursive: true });
    await writeFile(path.join(base, "progress.json"), JSON.stringify({ events: [{ type: "ActionEvent" }] }));
    await writeFile(path.join(events, "event-00002-abc.json"), JSON.stringify({ kind: "ActionEvent", id: "abc", tool_name: "file_editor", timestamp: "2026-09-17T12:00:00Z", action: { command: "create", path: "/workspace/site/index.html" }, thought: "PRIVATE" }));
    await writeFile(path.join(base, "site", "index.html"), "<html></html>");
    await writeFile(path.join(root, "outside.txt"), "PRIVATE");
    await symlink(path.join(root, "outside.txt"), path.join(base, "site", "outside.txt"));
    const progress = await readBuildProgress({ id, state: "running" }, root);
    assert.equal(progress.phase, "building");
    assert.equal(progress.message, "Creating index.html");
    assert.deepEqual(progress.files, [{ path: "index.html", size: 13 }]);
    assert.equal(progress.lastEventAt, "2026-09-17T12:00:00.000Z");
    assert.equal(JSON.stringify(progress).includes("PRIVATE"), false);
    await writeFile(path.join(base, "result.json"), JSON.stringify({ state: "completed" }));
    assert.equal((await readBuildProgress({ id, state: "running" }, root)).phase, "publishing");
    assert.equal((await readBuildProgress({ id, state: "completed", result: { previewUrl: "http://localhost:3002/" } }, root)).phase, "completed");
    assert.equal((await readBuildProgress({ id, state: "failed" }, root)).phase, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing, partial and symlinked progress remain safe and do not break status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "revos-progress-"));
  try {
    assert.equal((await readBuildProgress({ id, state: "pending" }, root)).phase, "queued");
    const base = path.join(root, "jobs", id);
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "progress.json"), "{");
    assert.equal((await readBuildProgress({ id, state: "running" }, root)).phase, "starting");
    await rm(path.join(base, "progress.json"));
    await writeFile(path.join(root, "outside.json"), JSON.stringify({ phase: "validating", events: [{ kind: "ActionEvent" }] }));
    await symlink(path.join(root, "outside.json"), path.join(base, "progress.json"));
    assert.equal((await readBuildProgress({ id, state: "running" }, root)).events.length, 0);
    await assert.rejects(readBuildProgress({ id: "../../outside", state: "running" }, root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
