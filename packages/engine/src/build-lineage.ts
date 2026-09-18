import { createHash } from "node:crypto";
import { z } from "zod";

export type BuildSourceFile = { name: string; data: Buffer };
export type BuildLineage = { parentBuildId: string; parentCommit: string };
export type RepositoryRequest = (path: string, method?: string, body?: unknown) => Promise<any>;
export type RepositoryFile = { path: string; sha: string; size?: number };
export const commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
export const lineageSchema = z.object({ parentBuildId: z.uuid(), parentCommit: commitId }).strict();

export function pinnedBuildLineage(parent: any, org: string): BuildLineage {
  if (!parent || parent.organization_id !== org || parent.state !== "completed")
    throw Error("Parent build is not completed or belongs to another customer");
  return { parentBuildId: z.uuid().parse(parent.id), parentCommit: commitId.parse(parent.result?.commit) };
}

export function validateSourcePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 240 || !/^[a-zA-Z0-9_./ -]+$/.test(value) ||
      value.startsWith("/") || value.split("/").some((part) => !part || part.startsWith(".") || ["node_modules", "__pycache__"].includes(part)))
    throw Error("Unsupported repository artifact path");
  return value;
}

export function gitBlobSha(data: Buffer, shaLength = 40) {
  return createHash(shaLength === 64 ? "sha256" : "sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

export async function repositoryFiles(api: string, commit: string, request: RepositoryRequest, service = false): Promise<RepositoryFile[]> {
  commitId.parse(commit);
  const files: RepositoryFile[] = [], seen = new Set<string>();
  let totalSize = 0;
  for (let page = 1; page <= 20; page++) {
    const response = await request(`${api}/git/trees/${commit}?recursive=true&per_page=100&page=${page}`);
    if (!response || !Array.isArray(response.tree)) throw Error("Committed build source is unavailable in Forgejo");
    if (response.total_count > 2000) throw Error("Build source tree is too large");
    for (const entry of response.tree) {
      const name = validateSourcePath(entry.path);
      if (seen.has(name)) throw Error("Repository returned duplicate source paths");
      seen.add(name);
      if (entry.type === "tree" && ["040000", "40000"].includes(entry.mode)) continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw Error("Build source cannot contain symlinks or submodules");
      const sha = commitId.parse(entry.sha);
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0))
        throw Error("Invalid source file size");
      totalSize += entry.size ?? 0;
      files.push({ path: name, sha, size: entry.size });
      if (files.length > (service?500:100) || totalSize > (service?20_000_000:5_000_000)) throw Error("Build source exceeds file or size limit");
    }
    if (!response.truncated) return files;
    if (!response.tree.length) throw Error("Repository returned an incomplete source tree");
  }
  throw Error("Build source tree is too large");
}

export async function committedBuildSource(api: string, commit: string, request: RepositoryRequest, service = false): Promise<BuildSourceFile[]> {
  const tree = await repositoryFiles(api, commit, request, service);
  const files: BuildSourceFile[] = [];
  let totalSize = 0;
  for (const entry of tree) {
    const blob = await request(`${api}/git/blobs/${entry.sha}`);
    if (!blob || blob.sha !== entry.sha || blob.encoding !== "base64" || typeof blob.content !== "string")
      throw Error("Invalid committed source blob");
    const encoded = blob.content.replace(/\s/g, "");
    if (encoded.length > 6_666_668 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw Error("Invalid or oversized committed source blob");
    const data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded) throw Error("Invalid committed source encoding");
    if (data.length !== blob.size || (entry.size !== undefined && data.length !== entry.size) || gitBlobSha(data, entry.sha.length) !== entry.sha)
      throw Error("Committed source blob does not match its immutable Git identity");
    totalSize += data.length;
    if (totalSize > (service?20_000_000:5_000_000)) throw Error("Build source exceeds size limit");
    files.push({ name: entry.path, data });
  }
  if (!files.some((file) => file.name === (service?"Dockerfile":"index.html"))) throw Error("Parent build source needs " + (service?"Dockerfile":"index.html"));
  return files;
}

export function sourceChanges(existing: RepositoryFile[], files: BuildSourceFile[]) {
  const old = new Map(existing.map((file) => [file.path, file]));
  const next = new Set(files.map((file) => validateSourcePath(file.name)));
  if (next.size !== files.length) throw Error("Duplicate build artifact paths");
  const changes: { operation: "create" | "update" | "delete"; path: string; sha?: string; content?: string }[] = [];
  for (const file of files) {
    const before = old.get(file.name);
    if (before && before.sha === gitBlobSha(file.data, before.sha.length)) continue;
    changes.push({ operation: before ? "update" : "create", path: file.name, content: file.data.toString("base64"), ...(before ? { sha: before.sha } : {}) });
  }
  for (const file of existing)
    if (!next.has(file.path)) changes.push({ operation: "delete", path: file.path, sha: file.sha });
  // Delete obsolete paths first, allowing an old file to become a directory.
  return changes.sort((a, b) => Number(b.operation === "delete") - Number(a.operation === "delete"));
}

export async function publishBuildSource(api: string, branch: string, baseRef: string, files: BuildSourceFile[], request: RepositoryRequest, service = false) {
  if (baseRef !== "main") commitId.parse(baseRef);
  let head = await request(`${api}/branches/${encodeURIComponent(branch)}`);
  if (!head) {
    await request(`${api}/branches`, "POST", { new_branch_name: branch, old_ref_name: baseRef });
    head = await request(`${api}/branches/${encodeURIComponent(branch)}`);
  }
  let commit = commitId.parse(head?.commit?.id);
  const changes = sourceChanges(await repositoryFiles(api, commit, request, service), files);
  if (changes.length) {
    const saved = await request(`${api}/contents`, "POST", { branch, message: `OpenHands ${branch}`, files: changes });
    commit = commitId.parse(saved?.commit?.sha);
  }
  // Check the immutable commit, not a mutable branch head. Publication is only
  // accepted when its entire source tree matches the generated site exactly.
  if (sourceChanges(await repositoryFiles(api, commit, request, service), files).length)
    throw Error("Published source does not match the generated build snapshot");
  return commit;
}
