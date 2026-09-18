import { test } from "node:test";
import assert from "node:assert/strict";
import { committedBuildSource, gitBlobSha, pinnedBuildLineage, publishBuildSource, repositoryFiles, sourceChanges, validateSourcePath } from "../packages/engine/src/build-lineage";
import { createCodeBuild, registerCodeTools } from "../packages/engine/src/code-builds";
import { ToolRegistry } from "../packages/engine/src";
import { pool } from "../packages/database/src";

const org = "b6f50b59-ff25-4f21-be01-e9986be4d3f3";
const parentId = "32ff4b0f-6838-4aa2-9a09-b966a4e3f616";
const childId = "81c85324-f47f-4e68-96aa-5e8fad07bc0e";
const sid = "ebfceb80-896d-419d-a315-afc4f4c3f7f8";
const parentCommit = "a".repeat(40), childCommit = "b".repeat(40);
const api = `/repos/revos/products-${org}`;
const source = [{ name: "index.html", data: Buffer.from("Existing product") }, { name: "keep.css", data: Buffer.from("body { color: blue; }") }, { name: "obsolete.js", data: Buffer.from("old();") }];
const entries = (files = source) => files.map((f) => ({ path: f.name, sha: gitBlobSha(f.data), type: "blob", mode: "100644", size: f.data.length }));

test("revision source is fetched by pinned commit and verified by immutable blob hashes", async () => {
  const reads: string[] = [];
  const request = async (url: string) => {
    reads.push(url);
    if (url.includes("/git/trees/")) {
      assert.ok(url.includes(`/git/trees/${parentCommit}?`));
      return { tree: entries(), truncated: false };
    }
    const file = source.find((f) => url.endsWith(gitBlobSha(f.data)))!;
    return { sha: gitBlobSha(file.data), encoding: "base64", size: file.data.length, content: file.data.toString("base64") };
  };
  assert.deepEqual(await committedBuildSource(api, parentCommit, request), source);
  assert.equal(reads.some((url) => url.includes("main") || url.includes("/contents/")), false);
  await assert.rejects(committedBuildSource(api, parentCommit, async (url) => url.includes("/git/trees/")
    ? { tree: entries(), truncated: false }
    : { sha: entries()[0].sha, encoding: "base64", size: 7, content: Buffer.from("changed").toString("base64") }), /immutable Git identity/);
});

test("source tree handling paginates and rejects unsafe paths and source types", async () => {
  let pages = 0;
  const found = await repositoryFiles(api, parentCommit, async () => ({ tree: [entries()[pages++]], truncated: pages < 3 }));
  assert.equal(found.length, 3);
  assert.equal(pages, 3);
  for (const name of ["../escape", "/outside", "a/../b", ".env", "nested/.git/config", "a//b", "node_modules/a.js"])
    assert.throws(() => validateSourcePath(name));
  await assert.rejects(repositoryFiles(api, parentCommit, async () => ({ tree: [{ ...entries()[0], mode: "120000" }], truncated: false })), /symlinks/);
  await assert.rejects(repositoryFiles(api, parentCommit, async () => ({ tree: entries(), truncated: true })), /duplicate/);
});

test("revision publication branches from the parent commit and atomically deletes removed files", async () => {
  const revised = [{ name: "index.html", data: Buffer.from("Revised product") }, source[1], { name: "new.js", data: Buffer.from("newFeature();") }];
  let branchCreated = false, published = false;
  const writes: any[] = [];
  const request = async (url: string, method = "GET", body?: any) => {
    if (method === "POST") {
      writes.push({ url, body });
      if (url.endsWith("/branches")) { branchCreated = true; return {}; }
      assert.equal(url, api + "/contents");
      assert.equal(body.files.length, 3);
      assert.deepEqual(body.files.find((f: any) => f.operation === "delete"), { operation: "delete", path: "obsolete.js", sha: gitBlobSha(source[2].data) });
      assert.equal(body.files.some((f: any) => f.path === "keep.css"), false);
      published = true;
      return { commit: { sha: childCommit } };
    }
    if (url.includes("/branches/")) return branchCreated ? { commit: { id: published ? childCommit : parentCommit } } : null;
    if (url.includes(`/git/trees/${parentCommit}?`)) return { tree: entries(), truncated: false };
    if (url.includes(`/git/trees/${childCommit}?`)) return { tree: entries(revised), truncated: false };
    throw Error("Unexpected request");
  };
  assert.equal(await publishBuildSource(api, "build-" + childId, parentCommit, revised, request), childCommit);
  assert.deepEqual(writes[0].body, { new_branch_name: "build-" + childId, old_ref_name: parentCommit });
  assert.equal(writes.filter((w) => w.url.endsWith("/contents")).length, 1);
  assert.equal(await publishBuildSource(api, "build-" + childId, parentCommit, revised, request), childCommit);
  assert.equal(writes.filter((w) => w.url.endsWith("/contents")).length, 1, "Publication retry is idempotent");
  assert.equal(sourceChanges(entries(), source).length, 0, "Parent snapshot remains unchanged");
});

test("completed parent validation pins a real commit and rejects cross-customer parents", () => {
  const parent = { id: parentId, organization_id: org, state: "completed", result: { commit: parentCommit } };
  assert.deepEqual(pinnedBuildLineage(parent, org), { parentBuildId: parentId, parentCommit });
  for (const p of [{ ...parent, organization_id: childId }, { ...parent, state: "running" }, { ...parent, result: { commit: "main" } }, null])
    assert.throws(() => pinnedBuildLineage(p, org));
});

test("build creation pins parent lineage while idempotent legacy receipts remain readable", async (t) => {
  const lineage = { parentBuildId: parentId, parentCommit };
  let existing: any = null;
  let inserts = 0;
  t.mock.method(pool, "query", (async (sql: string, params: any[]) => {
    if (sql.includes("WHERE source_key=")) return { rows: existing ? [existing] : [] };
    if (sql.startsWith("SELECT * FROM code_build WHERE id=")) return { rows: [{ id: parentId, organization_id: org, state: "completed", result: { commit: parentCommit } }] };
    if (sql.startsWith("INSERT")) {
      inserts++;
      assert.equal(params[4], parentId);
      assert.deepEqual(JSON.parse(params[5]), { lineage });
      existing = { id: childId, organization_id: org, state: "pending", parent_id: parentId, result: JSON.parse(params[5]) };
      return { rows: [existing] };
    }
    throw Error("Unexpected query");
  }) as any);
  const first = await createCodeBuild(org, null, sid + ":1", "Revise name", parentId);
  assert.deepEqual(first.lineage, lineage);
  assert.deepEqual(await createCodeBuild(org, null, sid + ":1", "Ignored retry", "invalid-parent"), first);
  assert.equal(inserts, 1);
  existing = { id: parentId, organization_id: org, state: "completed", parent_id: childId, result: { commit: parentCommit } };
  assert.equal((await createCodeBuild(org, null, "legacy", "Ignored", "invalid-parent")).codeBuildId, parentId);
  await assert.rejects(createCodeBuild(childId, null, "legacy", "Ignored"), /another customer/);
});

test("tool handler enforces revise_build and refuses a fresh build during pending feedback", async (t) => {
  let existing: any = null, revisionPending = true;
  t.mock.method(pool, "query", (async (sql: string) => {
    if (sql.includes("JOIN run r")) return { rows: [{ id: childId, org }] };
    if (sql.includes("WHERE source_key=")) return { rows: existing ? [existing] : [] };
    if (sql.includes("JOIN platform_campaign")) return { rows: [] };
    if (sql.includes("FROM reasoning_turn")) return { rows: [{ state: { revisionPending } }] };
    if (sql.includes("source_key LIKE")) return { rows: [{ id: parentId }], rowCount: 1 };
    if (sql.startsWith("SELECT * FROM code_build WHERE id=")) return { rows: [] };
    throw Error("Unexpected query or write");
  }) as any);
  const registry = new ToolRegistry();
  registerCodeTools(registry);
  const context = { idempotencyKey: sid + ":1" };
  const guarded = await registry.resolve("openhands.start_build")({ brief: "Feedback" }, {}, context) as any;
  assert.equal(guarded.state, "not_started");
  assert.equal(guarded.reason, "existing_build_requires_revision");
  assert.equal(guarded.existingBuildId, parentId);
  assert.equal(guarded.codeBuildId, undefined);
  await assert.rejects(registry.resolve("openhands.revise_build")({ brief: "Feedback" }, {}, context));
  await assert.rejects(registry.resolve("openhands.revise_build")({ brief: "Feedback", buildId: parentId }, {}, context), /not completed or belongs/);
  existing = { id: childId, organization_id: org, state: "running", result: null };
  assert.equal((await registry.resolve("openhands.start_build")({}, {}, context) as any).codeBuildId, childId, "Previously accepted calls replay before new input/mode validation");
  revisionPending = false;
});
