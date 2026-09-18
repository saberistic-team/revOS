import {
  h,
  api,
  button,
  link,
  badge,
  icon,
  getContext,
  notify,
  output,
  time,
} from "./core.js";

export function proposalSummary(change) {
  const box = h("div", { class: "nx-proposal-summary" }),
    before = change.before?.definition || change.before || {},
    after = change.body || {};
  const labels = {
    title: "Title",
    name: "Name",
    description: "Description",
    goal: "Goal",
    instructions: "Instructions",
    content: "Content",
    evidence: "Evidence",
    category: "Category",
    brief: "Build brief",
    inputSchema: "Starting form",
    outputSchema: "Expected result",
    configuration: "Capabilities and settings",
    steps: "Workflow steps",
    productId: "Product",
    campaignId: "Campaign",
    stakeholderIds: "Stakeholders",
    acceptanceCriteria: "Acceptance criteria",
    ownerPersonId: "Decision owner",
    workflowId: "Workflow",
    input: "Starting inputs",
    relatedIds: "Related knowledge",
    agentId: "Agent",
  };
  let count = 0;
  for (const key of Object.keys(after))
    if (
      after[key] !== undefined &&
      JSON.stringify(after[key]) !== JSON.stringify(before[key])
    ) {
      const label =
        labels[key] ||
        key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      count++;
      const value = after[key],
        old = before[key];
      const item = h("div", { class: "nx-change-row" }, h("strong", {}, label));
      if (key === "steps" && Array.isArray(value)) {
        item.append(
          h("ol", {}, ...value.map((s) => h("li", {}, s.name || s.key))),
          h(
            "details",
            {},
            h("summary", {}, "Step details"),
            old ? h("section", {}, h("h4", {}, "Before"), output(old)) : null,
            h("section", {}, h("h4", {}, "After"), output(value)),
          ),
        );
      } else if (typeof value === "object" && value !== null) {
        item.append(
          old !== undefined
            ? h("details", {}, h("summary", {}, "Before"), output(old))
            : null,
          h("section", {}, h("h4", {}, "After"), output(value)),
        );
      } else {
        if (old !== undefined)
          item.append(h("p", {}, h("del", {}, String(old))));
        item.append(h("p", {}, h("ins", {}, String(value ?? "None"))));
      }
      box.append(item);
    }
  if (!count)
    box.append(h("p", {}, change.reason || "Review this proposed change."));
  return box;
}

export function mountAssistant() {
  const root = document.querySelector("#nx-assistant"),
    toggle = document.querySelector("#nx-assistant-toggle");
  let context = {},
    key = "",
    thread = "",
    epoch = 0,
    busy = false,
    sending = false,
    signature = "",
    proposalSig = "",
    lastState = null;
  const contextKey = (c) =>
    [
      c.scope,
      c.organizationId,
      c.kind,
      c.id ||
        c.campaignId ||
        c.productId ||
        c.documentId ||
        c.workflowId ||
        c.runId ||
        "",
      c.workflowStepId || "",
      c.version || c.draftRevision || "",
    ].join(":");
  const saved = (k) => {
      try {
        return sessionStorage.getItem(k) || "";
      } catch {
        return "";
      }
    },
    store = (k, v) => {
      try {
        sessionStorage.setItem(k, v);
      } catch {}
    };
  const scopeName = {
    run: "Run",
    library: "Library",
    knowledge: "Organizations",
  };
  const title = h("h2", {}, "Assistant"),
    scope = h("div", { class: "nx-assistant-context" }),
    status = h("div", { "aria-live": "polite", class: "nx-small nx-muted" }),
    messages = h("div", {
      class: "nx-chat-scroll",
      role: "log",
      "aria-label": "Assistant conversation",
    }),
    composer = h("textarea", {
      rows: 3,
      maxLength: 12000,
      placeholder: "Explain, correct, or suggest a change…",
      "aria-label": "Message to assistant",
    }),
    latest = button(
      "Jump to latest",
      () => {
        messages.scrollTop = messages.scrollHeight;
        latest.hidden = true;
      },
      { hidden: true, class: "nx-small" },
    );
  const threadSelect = h("select", { "aria-label": "Conversation history" }),
    history = h("details", {}, h("summary", {}, "Conversations"), threadSelect);
  // Sending state is owned here; the generic button helper changes disabled around its callback.
  const send = h(
      "button",
      { type: "button", class: "nx-button nx-primary", onclick: submit },
      icon("send"),
      "Send",
    ),
    fresh = button(
      "New chat",
      () => {
        epoch++;
        thread = "";
        threadSelect.value = "";
        store("nx-thread:" + key, "");
        signature = "";
        proposalSig = "";
        messages.replaceChildren();
        status.textContent = "Start a new conversation about this item.";
        syncSendState();
        void refresh();
      },
      { class: "nx-small" },
    );
  const hints = h("div", { class: "nx-actions" });
  root.append(
    h(
      "div",
      { class: "nx-row" },
      title,
      button("Close", () => show(false), { icon: "close", class: "nx-quiet" }),
    ),
    scope,
    h("div", { class: "nx-row" }, history, fresh),
    hints,
    messages,
    latest,
    status,
    h(
      "div",
      { class: "nx-assistant-composer" },
      composer,
      h(
        "div",
        { class: "nx-row" },
        button("Dictate", dictate, { icon: "mic", class: "nx-small" }),
        send,
      ),
    ),
  );
  function show(open) {
    root.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    document
      .querySelector("#nx-workarea")
      .classList.toggle("assistant-open", open);
    if (open) {
      contextChanged(getContext());
      void refresh();
    }
  }
  toggle.replaceChildren(
    icon("assistant"),
    document.createTextNode("Assistant"),
  );
  toggle.onclick = () => show(root.hidden);
  function syncSendState() {
    const jobs = (lastState?.jobs || []).filter(
      (job) => thread && job.payload?.threadId === thread,
    );
    const running = jobs.some((job) =>
      ["pending", "running"].includes(job.state),
    );
    send.disabled = !context.organizationId || sending || running;
    fresh.disabled = sending;
    send.setAttribute("aria-busy", String(sending || running));
    if (sending) status.textContent = "Sending…";
    else if (status.textContent === "Sending…")
      status.textContent = running ? "Thinking…" : "";
    return { job: jobs[0], running };
  }
  function contextChanged(c) {
    const next = contextKey(c);
    context = { ...c };
    if (next !== key) {
      if (key) store("nx-draft:" + key, composer.value);
      key = next;
      epoch++;
      thread = saved("nx-thread:" + key);
      composer.value = saved("nx-draft:" + key);
      signature = "";
      proposalSig = "";
      lastState = null;
      messages.replaceChildren();
      threadSelect.replaceChildren();
      threadSelect.dataset.signature = "";
    }
    scope.textContent = c.organizationId
      ? `${scopeName[c.scope] || "Workspace"} · ${c.label || "Selected item"}${c.unsaved ? " · Saved version; editor has unsaved changes" : ""}`
      : "Select an organization or item to start.";
    syncSendState();
    hints.replaceChildren(
      ...(c.scope === "library"
        ? ["Explain this", "Suggest an improvement"]
        : ["Explain this", "What changed?"]
      ).map((label) =>
        button(
          label,
          () => {
            composer.value = label;
            store("nx-draft:" + key, composer.value);
            composer.focus();
          },
          { class: "nx-small" },
        ),
      ),
    );
  }
  window.addEventListener("nx:context", (e) => {
    contextChanged(e.detail);
    if (!root.hidden) void refresh();
  });
  window.addEventListener("nx:assistant", (e) => {
    show(true);
    if (e.detail?.prompt) {
      composer.value = e.detail.prompt;
      store("nx-draft:" + key, composer.value);
    }
    composer.focus();
  });
  composer.addEventListener("input", () =>
    store("nx-draft:" + key, composer.value),
  );
  composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!send.disabled) void submit();
    }
  });
  threadSelect.onchange = () => {
    epoch++;
    thread = threadSelect.value;
    store("nx-thread:" + key, thread);
    signature = "";
    proposalSig = "";
    messages.replaceChildren();
    status.textContent = "Loading conversation…";
    syncSendState();
    void refresh();
  };
  messages.addEventListener("scroll", () => {
    if (messages.scrollHeight - messages.clientHeight - messages.scrollTop < 70)
      latest.hidden = true;
  });
  async function refresh() {
    if (root.hidden || busy || !context.organizationId) return;
    busy = true;
    const generation = epoch,
      org = context.organizationId,
      scopeValue = context.scope || "knowledge",
      selectedKey = key,
      selectedThread = thread;
    try {
      const data = await api(`/workspace/${org}/assistant?scope=${scopeValue}`);
      if (generation !== epoch || thread !== selectedThread) return;
      lastState = data;
      const threadsSignature = JSON.stringify(
        data.threads.map((t) => [t.id, t.title]),
      );
      if (threadSelect.dataset.signature !== threadsSignature) {
        threadSelect.dataset.signature = threadsSignature;
        threadSelect.replaceChildren(
          h("option", { value: "" }, "New conversation"),
          ...data.threads.map((t) =>
            h("option", { value: t.id }, `${t.title} · ${time(t.createdAt)}`),
          ),
        );
        threadSelect.value = thread;
      }
      const { job, running } = syncSendState();
      status.replaceChildren(
        document.createTextNode(
          sending
            ? "Sending…"
            : running
              ? "Thinking…"
              : job?.state === "failed"
                ? "The assistant could not finish this reply."
                : "",
        ),
      );
      if (job?.state === "failed")
        status.append(
          button(
            "Retry",
            async () => {
              await api(`/workspace/${org}/jobs/${job.id}/retry`, {
                method: "POST",
                body: {},
              });
              await refresh();
            },
            { class: "nx-small" },
          ),
        );
      const conversation = thread
        ? await api(`/workspace/${org}/threads/${thread}`)
        : { messages: [] };
      if (
        generation !== epoch ||
        key !== selectedKey ||
        thread !== selectedThread
      )
        return;
      const proposals = data.changes.filter(
        (c) => c.provenance.assistantThreadId === thread,
      );
      const sig = JSON.stringify([conversation.messages, proposals]);
      if (sig === signature) return;
      signature = sig;
      const follow =
          messages.scrollHeight - messages.clientHeight - messages.scrollTop <
          70,
        oldTop = messages.scrollTop;
      const existing = new Map(
        [...messages.children].map((n) => [n.dataset.id, n]),
      );
      const ordered = [];
      for (const m of conversation.messages) {
        let n = existing.get(m.id);
        const ms = JSON.stringify(m);
        if (!n || n.dataset.signature !== ms) {
          n = h(
            "article",
            { class: "nx-chat-message " + m.role },
            h("strong", {}, m.role === "user" ? "You" : "Assistant"),
            m.metadata?.displayContent || m.content,
          );
          n.dataset.id = m.id;
          n.dataset.signature = ms;
          if (m.metadata?.context?.label)
            n.append(
              h(
                "p",
                { class: "nx-muted nx-small" },
                "About: " + m.metadata.context.label,
              ),
            );
          for (const q of m.metadata?.questions || []) n.append(h("p", {}, q));
          for (const err of m.metadata?.proposalErrors || [])
            n.append(h("p", { class: "nx-error" }, err));
        }
        ordered.push(n);
      }
      for (const c of proposals) {
        let n = existing.get("change:" + c.id);
        const cs = JSON.stringify(c);
        if (!n || n.dataset.signature !== cs) {
          n = h(
            "article",
            { class: "nx-proposal" },
            h("div", { class: "nx-row" }, h("h3", {}, c.title), badge(c.state)),
            h("p", {}, c.reason),
          );
          n.dataset.id = "change:" + c.id;
          n.dataset.signature = cs;
          const details = h(
            "details",
            {},
            h("summary", {}, "Review changes"),
            proposalSummary(c),
          );
          n.append(details);
          if (c.state === "proposed") {
            const confirm = h("input", { type: "checkbox" });
            if (c.kind === "knowledge")
              details.append(
                h(
                  "label",
                  { class: "nx-small" },
                  confirm,
                  " I confirm this as a customer statement",
                ),
              );
            const applyLabel =
              {
                workflow: "Apply to draft",
                skill: "Create skill version",
                run: "Approve & start run",
                product: "Approve & build",
                knowledge: "Accept knowledge",
              }[c.kind] || "Apply";
            details.append(
              h(
                "div",
                { class: "nx-actions" },
                button(
                  applyLabel,
                  async () => {
                    await api(`/workspace/${org}/changes/${c.id}/approve`, {
                      method: "POST",
                      body: { confirmKnowledge: confirm.checked },
                    });
                    notify(
                      "Change accepted. Execution progress will appear shortly.",
                    );
                    signature = "";
                    await refresh();
                    window.dispatchEvent(new Event("nx:data-changed"));
                  },
                  { primary: true },
                ),
                button("Reject", async () => {
                  await api(`/workspace/${org}/changes/${c.id}/reject`, {
                    method: "POST",
                    body: {},
                  });
                  signature = "";
                  await refresh();
                }),
              ),
            );
          } else if (c.state === "applied") {
            n.append(
              link(
                "Open result",
                ["workflow", "skill"].includes(c.kind)
                  ? `/next/library?tab=${c.kind === "skill" ? "skills" : "workflows"}&organization=${org}&item=${c.targetId}`
                  : c.kind === "run"
                    ? `/next/run?run=${c.targetId}`
                    : c.kind === "product"
                      ? `/next/organizations?organization=${org}&view=products&product=${c.provenance?.productId || ""}`
                      : `/next/organizations?organization=${org}&view=knowledge&document=${c.targetId}`,
              ),
            );
          }
        }
        ordered.push(n);
      }
      for (const n of ordered) messages.append(n);
      for (const [id, n] of existing) if (!ordered.includes(n)) n.remove();
      if (!ordered.length)
        messages.replaceChildren(
          h(
            "p",
            { class: "nx-muted" },
            "Ask about the selected item. Changes will appear as proposals for review.",
          ),
        );
      messages.scrollTop = follow ? messages.scrollHeight : oldTop;
      latest.hidden = follow;
    } catch (e) {
      if (generation === epoch) status.textContent = e.message;
    } finally {
      busy = false;
    }
  }
  async function submit() {
    syncSendState();
    if (sending || send.disabled) return;
    const draft = composer.value,
      content = draft.trim();
    if (!content || !context.organizationId) return;
    const captured = { ...context },
      org = captured.organizationId,
      sentKey = key,
      generation = epoch;
    sending = true;
    syncSendState();
    try {
      let selectedThread = thread;
      if (!selectedThread) {
        selectedThread = (
          await api(`/workspace/${org}/threads`, {
            method: "POST",
            body: {
              scope: captured.scope || "knowledge",
              title: String(captured.label || "Workspace assistant").slice(
                0,
                160,
              ),
            },
          })
        ).id;
        store("nx-thread:" + sentKey, selectedThread);
        if (generation === epoch) thread = selectedThread;
      }
      const { organizationId, scope: unusedScope, ...selection } = captured;
      await api(`/workspace/${org}/threads/${selectedThread}/messages`, {
        method: "POST",
        body: { content, context: selection },
      });
      if (saved("nx-draft:" + sentKey) === draft)
        store("nx-draft:" + sentKey, "");
      if (generation === epoch) {
        if (composer.value === draft) composer.value = "";
        signature = "";
        await refresh();
      }
    } catch (e) {
      if (generation === epoch) status.textContent = e.message;
      notify(e.message, "error");
    } finally {
      sending = false;
      syncSendState();
      void refresh();
    }
  }
  function dictate() {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) {
      notify(
        "Dictation is unavailable in this browser. Use keyboard dictation or type your message.",
      );
      return;
    }
    const requestKey = key;
    const r = new Speech();
    r.lang = navigator.language;
    r.onresult = (e) => {
      if (requestKey !== key) return;
      composer.value +=
        (composer.value ? " " : "") + e.results[0][0].transcript;
      store("nx-draft:" + key, composer.value);
    };
    r.onerror = () =>
      notify("Dictation stopped. Your typed message is preserved.");
    r.start();
  }
  setInterval(() => void refresh(), 3000);
  return { show };
}
