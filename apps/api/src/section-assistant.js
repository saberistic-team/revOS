(() => {
  const $ = (id) => document.getElementById(id),
    panel = $("section-assistant"),
    scope = panel.dataset.scope;
  let org = "",
    thread = "",
    busy = false,
    generation = 0,
    signature = "",
    sending = false;
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  async function api(path, body) {
    const r = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed");
    return d;
  }
  const endpoint = (path) => `/workspace/${org}${path}`;
  const key = () => `assistant:${scope}:${org}`;
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  $("sa-purpose").textContent =
    scope === "run"
      ? "Prepare inputs, start workflows, and understand execution. Starting a run requires your approval."
      : "Build workflow drafts and skills, and understand tools. Review changes before applying them.";
  $("sa-input").placeholder =
    scope === "run"
      ? "Explain this run, or help me start a workflow…"
      : "Help me build a workflow or improve this skill…";
  function context() {
    const c = window.assistantPageContext?.() || {};
    if (c.organizationId !== org) {
      org = c.organizationId || "";
      thread = store.get(key()) || "";
      generation++;
      signature = "";
      $("sa-messages").replaceChildren();
      $("sa-proposals").replaceChildren();
      $("sa-input").value = "";
    }
    $("sa-context").textContent =
      `${c.label || scope}${c.runId ? " · Run " + c.runId.slice(0, 8) : ""}${c.unsaved ? " · Save editor changes to include them" : ""}`;
    return c;
  }
  async function newThread() {
    const originalOrg = org;
    const t = await api(endpoint("/threads"), {
      scope,
      title: scope === "run" ? "Run assistant" : "Library assistant",
    });
    if (org !== originalOrg)
      throw Error(
        "Organization changed. Please send your message again in the selected workspace.",
      );
    thread = t.id;
    store.set(key(), thread);
    signature = "";
    return t;
  }
  function action(label, fn) {
    const b = node("button", label);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
        await refresh();
      } catch (e) {
        $("sa-status").textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  async function refresh() {
    if (panel.hidden || busy) return;
    context();
    if (!org) {
      $("sa-status").textContent =
        "Choose a workflow or organization to begin.";
      $("sa-send").disabled = true;
      return;
    }
    busy = true;
    const version = generation,
      requestedOrg = org;
    try {
      const state = await api(endpoint(`/assistant?scope=${scope}`));
      if (version !== generation || org !== requestedOrg) return;
      if (!state.threads.some((t) => t.id === thread))
        thread = state.threads[0]?.id || "";
      store.set(key(), thread);
      $("sa-threads").replaceChildren(
        ...state.threads.map((t) => {
          const n = node(
            "option",
            t.title + " · " + new Date(t.createdAt).toLocaleString(),
          );
          n.value = t.id;
          return n;
        }),
      );
      $("sa-threads").value = thread;
      const job = state.jobs.find((j) => j.payload.threadId === thread);
      const running = job && ["pending", "running"].includes(job.state);
      $("sa-send").disabled = !!running || sending;
      $("sa-new").disabled = sending;
      $("sa-status").textContent = running
        ? "Thinking…"
        : job?.state === "failed"
          ? job.error
          : "";
      if (job?.state === "failed")
        $("sa-status").append(
          action("Retry", () => api(endpoint(`/jobs/${job.id}/retry`), {})),
        );
      const selectedThread = thread;
      const data = thread
        ? await api(endpoint(`/threads/${thread}`))
        : { messages: [] };
      if (version !== generation || thread !== selectedThread) return;
      const next = JSON.stringify(data.messages),
        root = $("sa-messages");
      if (next !== signature) {
        const follow =
          !signature ||
          root.scrollHeight - root.clientHeight - root.scrollTop < 70;
        const top = root.scrollTop;
        signature = next;
        root.replaceChildren();
        if (!data.messages.length)
          root.append(
            node(
              "p",
              scope === "run"
                ? "Ask about this run, or describe the workflow you want to start."
                : "Describe the outcome you want your workflow or skill to achieve.",
            ),
          );
        for (const m of data.messages) {
          const card = node("div", undefined, "sa-message " + m.role);
          card.append(
            node("strong", m.role === "user" ? "You" : "Assistant"),
            document.createTextNode(m.content),
          );
          for (const q of m.metadata.questions || []) card.append(node("p", q));
          for (const e of m.metadata.proposalErrors || [])
            card.append(node("p", "Proposal needs revision: " + e));
          root.append(card);
        }
        root.scrollTop = follow ? root.scrollHeight : top;
        $("sa-latest").hidden = follow;
      }
      const proposals = state.changes.filter(
        (c) => c.provenance.assistantThreadId === thread,
      );
      const box = $("sa-proposals"),
        ps = JSON.stringify(proposals);
      if (box.dataset.signature !== ps) {
        box.dataset.signature = ps;
        box.replaceChildren();
        for (const c of proposals) {
          const d = node("details"),
            summary = node("summary", c.title + " · " + c.state);
          d.append(
            summary,
            node("p", c.reason),
            node("pre", JSON.stringify(c.body, null, 2)),
          );
          if (c.state === "proposed")
            d.append(
              action(
                scope === "run" ? "Approve and start" : "Apply draft",
                () => api(endpoint(`/changes/${c.id}/approve`), {}),
              ),
              action("Reject", () =>
                api(endpoint(`/changes/${c.id}/reject`), {}),
              ),
            );
          if (c.state === "applied") {
            const a = node(
              "a",
              scope === "run" ? "Open run" : "Open in library",
            );
            a.href =
              scope === "run"
                ? `/?workflow=${c.body.workflowId}&run=${c.targetId}`
                : `/builder?tab=${c.kind === "workflow" ? "workflows" : "skills"}${c.kind === "workflow" ? "&workflow=" + c.targetId : ""}`;
            d.append(a);
          }
          if (c.error) d.append(node("p", c.error));
          box.append(d);
        }
      }
    } catch (e) {
      $("sa-status").textContent = e.message;
    } finally {
      busy = false;
    }
  }
  $("section-assistant-toggle").onclick = () => {
    panel.hidden = false;
    $("section-assistant-toggle").setAttribute("aria-expanded", "true");
    refresh();
    $("sa-input").focus();
  };
  function close() {
    panel.hidden = true;
    $("section-assistant-toggle").setAttribute("aria-expanded", "false");
    $("section-assistant-toggle").focus();
  }
  $("sa-close").onclick = close;
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  $("sa-threads").onchange = () => {
    thread = $("sa-threads").value;
    generation++;
    signature = "";
    store.set(key(), thread);
    refresh();
  };
  $("sa-new").onclick = async () => {
    try {
      context();
      if (!org) return;
      await newThread();
      await refresh();
    } catch (e) {
      $("sa-status").textContent = e.message;
    }
  };
  $("sa-form").onsubmit = async (e) => {
    e.preventDefault();
    if (sending) return;
    const c = context(),
      content = $("sa-input").value.trim();
    if (!org || !content) return;
    const messageOrg = org;
    sending = true;
    $("sa-send").disabled = true;
    try {
      if (!thread) await newThread();
      if (org !== messageOrg)
        throw Error("Organization changed. Please send your message again.");
      await api(endpoint(`/threads/${thread}/messages`), {
        content,
        workflowId: c.workflowId || null,
        runId: scope === "run" ? c.runId || null : undefined,
      });
      $("sa-input").value = "";
      signature = "";
      await refresh();
    } catch (e) {
      $("sa-status").textContent = e.message;
    } finally {
      sending = false;
      await refresh();
    }
  };
  $("sa-latest").onclick = () => {
    $("sa-messages").scrollTop = $("sa-messages").scrollHeight;
    $("sa-latest").hidden = true;
  };
  setInterval(() => {
    if (!panel.hidden) {
      context();
      void refresh();
    }
  }, 2000);
})();
