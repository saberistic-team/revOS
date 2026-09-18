import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicBuildMessages, sanitizeBuildChat, savedBuildMessages, boundedBuildMessages } from "../packages/engine/src/build-chat";
import { readBuildProgress } from "../packages/engine/src/build-progress";

const action = { kind: "ActionEvent", id: "safe-event", source: "agent", timestamp: "2026-09-17T12:00:00", tool_name: "terminal" };
test("public action summaries exclude tool inputs and every private reasoning field", () => {
  const result = publicBuildMessages({ ...action, summary: "Checking the revised page links", thought: [{ text: "PRIVATE_THOUGHT" }], reasoning_content: "PRIVATE_REASON", thinking_blocks: [{ thinking: "PRIVATE_BLOCK" }], responses_reasoning_item: { encrypted_content: "PRIVATE_ENCRYPTED" }, action: { command: "PRIVATE_COMMAND" }, tool_call: { arguments: "PRIVATE_ARGUMENTS" } });
  assert.deepEqual(result.messages, [{ id: "safe-event:summary", at: "2026-09-17T12:00:00.000Z", role: "assistant", kind: "summary", text: "Checking the revised page links" }]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  for (const summary of ['terminal: {"command":"PRIVATE_COMMAND"}', 'file_editor: {"file_text":"PRIVATE_FILE"}', 'term\u0000inal: {"command":"PRIVATE_COMMAND"}', '\u001b[32mterminal: {"command":"PRIVATE_COMMAND"}', 'tool-name: ["PRIVATE"]', "x".repeat(601)])
    assert.equal(publicBuildMessages({ ...action, summary }).messages.length, 0);
});
test("only explicit agent assistant text and finish messages become chat", () => {
  const message = { kind: "MessageEvent", source: "agent", id: "chat", llm_message: { role: "assistant", content: [{ type: "text", text: "The preview is ready." }, { type: "thinking", text: "PRIVATE" }, { type: "image", image_url: "PRIVATE" }], reasoning_content: "PRIVATE" }, extended_content: [{ type: "text", text: "PRIVATE" }] };
  assert.equal(publicBuildMessages(message).messages[0].text, "The preview is ready.");
  assert.equal(JSON.stringify(publicBuildMessages(message)).includes("PRIVATE"), false);
  for (const source of ["user", "environment", undefined]) assert.equal(publicBuildMessages({ ...message, source }).messages.length, 0);
  for (const role of ["user", "system", "tool"]) assert.equal(publicBuildMessages({ ...message, llm_message: { ...message.llm_message, role } }).messages.length, 0);
  const finish = publicBuildMessages({ ...action, tool_name: "finish", action: { message: "Completed the requested update." }, thought: "PRIVATE" });
  assert.equal(finish.messages[0].id, "safe-event:finish");
  assert.equal(finish.messages[0].text, "Completed the requested update.");
  assert.equal(publicBuildMessages({ ...action, action: { message: "PRIVATE" } }).messages.length, 0);
});
test("credentials are redacted before truncation and scratchpads are omitted", () => {
  const key = "test-only-credential-across-cutoff";
  process.env.BUILD_CHAT_TEST_API_KEY = key;
  try {
    const safe = sanitizeBuildChat("x".repeat(3990) + key + " more");
    assert.equal(safe.text.includes("test-only"), false);
    assert.equal(safe.truncated, true);
    assert.equal(safe.text.length, 4000);
    const secrets = sanitizeBuildChat('Authorization: Bearer abcdef12345\napi_key="test-token"\nhttps://user:password@example.com\nsk-proj-syntheticsecret012345\n\u001b\u202eDone');
    for (const value of ["abcdef12345", "test-token", "user:password", "syntheticsecret012345", "\u001b", "\u202e"]) assert.equal(secrets.text.includes(value), false);
    assert.equal(sanitizeBuildChat('Authorization: Basic dXNlcjpwYXNzd29yZA==').text.includes('dXNlcjpwYXNzd29yZA'), false);
    for (const text of ["<think>PRIVATE</think>Done", "<analysis>PRIVATE", "<think>a<think>b</think>c</think>", "&lt;think&gt;PRIVATE", "<th\u0000ink>PRIVATE", "&#60;analysis&#62;PRIVATE", "< analysis>PRIVATE", "<chain_of_thought>PRIVATE", "&amp;amp;lt;analysis&amp;amp;gt;PRIVATE"])
      assert.equal(sanitizeBuildChat(text).text, "");
  } finally { delete process.env.BUILD_CHAT_TEST_API_KEY; }
});
test("chat buffers deduplicate and limit count and bytes while excluding nonpublic roles", () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `event-${String(i).padStart(3, "0")}:summary`, at: "2026-09-17T12:00:00Z", role: "assistant" as const, kind: "summary" as const, text: "Public update " + i }));
  const bounded = boundedBuildMessages([...entries, entries[59]]);
  assert.equal(bounded.messages.length, 50);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.messages.at(-1)?.text, "Public update 59");
  const bytes = boundedBuildMessages(entries.map(e => ({ ...e, text: "界".repeat(4000) })));
  assert.ok(bytes.messages.reduce((n, e) => n + Buffer.byteLength(e.text), 0) <= 50000);
  const saved = savedBuildMessages([{ ...entries[0], role: "user", text: "PRIVATE" }, entries[1], { ...entries[2], kind: "reasoning", text: "PRIVATE" }]);
  assert.equal(saved.messages.length, 1);
  assert.equal(JSON.stringify(saved).includes("PRIVATE"), false);
});
test("running legacy jobs expose persisted chat, keep status authoritative and refresh cached files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "revos-chat-"));
  try {
    const id = "32ff4b0f-6838-4aa2-9a09-b966a4e3f616";
    const base = path.join(root, "jobs", id);
    const folder = path.join(base, "conversation", id.replaceAll("-", ""), "events");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "event-00001-safe.json");
    await writeFile(file, JSON.stringify({ ...action, summary: "Checking existing files" }));
    let progress = await readBuildProgress({ id, state: "running" }, root);
    assert.equal(progress.messages[0].text, "Checking existing files");
    await writeFile(file, JSON.stringify({ ...action, tool_name: "finish", action: { message: "Ready for review." } }));
    progress = await readBuildProgress({ id, state: "running" }, root);
    assert.equal(progress.messages[0].text, "Ready for review.");
    assert.equal(progress.phase, "building", "A chat message does not confirm publication or completion");
    await writeFile(path.join(base, "progress.json"), JSON.stringify({ messages: progress.messages }));
    assert.equal((await readBuildProgress({ id, state: "running" }, root)).messages.length, 1, "SDK and snapshot messages deduplicate");
    await writeFile(file, "{");
    assert.equal((await readBuildProgress({ id, state: "running" }, root)).messages.length, 1, "Snapshot remains useful while an event file is incomplete");
  } finally { await rm(root, { recursive: true, force: true }); }
});
