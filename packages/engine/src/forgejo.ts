const base = () =>
  (process.env.FORGEJO_URL || "http://forgejo:3000").replace(/\/$/, "");
export const repositoryName = (org: string) => `knowledge-${org}`;
export function repositoryUrl(org: string) {
  return `${process.env.FORGEJO_PUBLIC_URL || "http://localhost:3001"}/${process.env.FORGEJO_OWNER || "revos"}/${repositoryName(org)}`;
}
export async function forgejo(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  if (!process.env.FORGEJO_TOKEN)
    throw Error("Forgejo is not configured. Run scripts/setup-forgejo.py.");
  const r = await fetch(base() + "/api/v1" + path, {
    method,
    headers: {
      Authorization: `token ${process.env.FORGEJO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 404 && method === "GET") return null;
  if (!r.ok)
    throw Error(
      `Forgejo ${method} failed (${r.status}): ${(await r.text()).slice(0, 500)}`,
    );
  const response = await r.text();
  return response ? JSON.parse(response) : null;
}
export const repoPath = (org: string) =>
  `/repos/${encodeURIComponent(process.env.FORGEJO_OWNER || "revos")}/${repositoryName(org)}`;
export async function ensureRepository(org: string) {
  if (await forgejo(repoPath(org))) return;
  try {
    await forgejo("/user/repos", "POST", {
      name: repositoryName(org),
      private: true,
      auto_init: true,
      default_branch: "main",
      description: "Versioned organization knowledge maintained by revOS",
    });
  } catch (e) {
    if (!(await forgejo(repoPath(org)))) throw e;
  }
}
export async function readRepositoryDocument(org: string, id: string) {
  return forgejo(repoPath(org) + `/contents/knowledge/${id}.md?ref=main`);
}
export async function commitDocument(
  org: string,
  id: string,
  content: string,
  expectedSha: string | null,
  message: string,
) {
  await ensureRepository(org);
  const current = await readRepositoryDocument(org, id);
  // A remote commit can succeed before an activity loses its database connection.
  if (
    current &&
    Buffer.from(current.content, "base64").toString("utf8") === content
  )
    return {
      fileSha: current.sha,
      commitSha: current.last_commit_sha || current.sha,
    };
  if ((current?.sha ?? null) !== expectedSha)
    throw Error(
      "Repository document changed outside this proposal. Sync from Forgejo, then review a fresh correction.",
    );
  const result = await forgejo(
    repoPath(org) + `/contents/knowledge/${id}.md`,
    current ? "PUT" : "POST",
    {
      content: Buffer.from(content).toString("base64"),
      branch: "main",
      message,
      ...(current ? { sha: current.sha } : {}),
    },
  );
  return { fileSha: result.content.sha, commitSha: result.commit.sha };
}
