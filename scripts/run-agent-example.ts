const base = process.env.API_URL ?? "http://localhost:3000";
async function request(path: string, body?: unknown) {
  const r = await fetch(
    base + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function main() {
  const live = process.argv.includes("--live");
  const workflows = (await request("/workflows")) as {
    id: string;
    slug: string;
  }[];
  const workflow = workflows.find(
    (w) => w.slug === (live ? "agent-research-openai" : "agent-research-mock"),
  );
  if (!workflow) throw new Error("Run pnpm db:seed:agent first");
  const run = await request(`/workflows/${workflow.id}/runs`, {
    input: {
      personName: "Jordan Example",
      location: "Example County",
      synthetic: true,
    },
  });
  console.log(
    `Run: ${run.id}\nTemporal: ${run.temporalWorkflowId}\nProvider: ${live ? "OpenAI" : "offline SDK fixture"}`,
  );
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const current = await request(`/runs/${run.id}`);
    if (
      ["completed", "failed", "cancelled", "waiting"].includes(current.status)
    ) {
      const sessions = await request(`/runs/${run.id}/sessions`);
      for (const s of sessions) {
        const detail = await request(`/sessions/${s.id}`);
        console.log(`Session: ${s.id}`);
        for (const t of detail.turns)
          console.log(
            `Turn ${t.turn}: ${t.decision.action} — ${t.decision.summary}`,
          );
      }
      console.log(
        JSON.stringify(
          {
            status: current.status,
            output: current.output,
            error: current.error,
          },
          null,
          2,
        ),
      );
      if (current.status !== "completed")
        throw new Error(`Run ${current.status}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Run timeout");
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
