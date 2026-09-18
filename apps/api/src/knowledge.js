(() => {
  const $ = (id) => document.getElementById(id),
    params = new URLSearchParams(location.search);
  let mapCategory = "",
    mapConcept = "";
  let organization = "",
    state = {
      documents: [],
      changes: [],
      threads: [],
      jobs: [],
      workflows: [],
      skills: [],
      runs: [],
    },
    selectedProduct = params.get("product") || "",
    previewing = "",
    selected = params.get("document") || "",
    view = params.get("view") || (params.get("document") || params.get("run") ? "report" : "products"),
    thread = "",
    busy = false,
    chatBusy = false,
    lastMessages = "",
    messageLoad = 0,
    followNextMessage = false,
    listening = false,
    recognition;
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const notice = (s, error = false) => {
    $("notice").textContent = s;
    $("notice").className = error ? "error" : "success";
  };
  async function api(path, body) {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "Request failed");
    return data;
  }
  const endpoint = (path) => `/workspace/${organization}${path}`;
  const button = (text, fn, cls) => {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        notice(e.message, true);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  function links(n, text) {
    for (const p of String(text).split(/(https?:\/\/[^\s<>"']+)/g)) {
      if (/^https?:\/\//i.test(p)) {
        const a = el("a", p);
        a.href = p;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        n.append(a);
      } else n.append(document.createTextNode(p));
    }
  }
  function markdown(text) {
    const box = el("div", undefined, "report");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      const n = el(m ? "h" + Math.min(4, m[1].length) : "p");
      links(n, m ? m[2] : line);
      box.append(n);
    }
    return box;
  }
  const selectedDoc = () => state.documents.find((d) => d.id === selected);
  function choose(id) {
    selected = id;
    view = "report";
    renderList();
    renderMain();
    $("assistant-context").textContent =
      "Selected knowledge: " +
      (selectedDoc()?.title || "Organization overview");
  }
  function renderList() {
    const q = $("search").value.toLowerCase();
    $("doc-list").replaceChildren();
    for (const d of state.documents.filter((d) =>
      (d.title + " " + d.content + " " + d.category).toLowerCase().includes(q),
    )) {
      const b = button(
        d.title.replaceAll("_", " "),
        () => choose(d.id),
        "doc" + (d.id === selected ? " active" : ""),
      );
      b.append(
        el(
          "small",
          `${d.category} · ${d.evidence.replaceAll("_", " ")} · v${d.revision}`,
        ),
      );
      $("doc-list").append(b);
    }
    if (!state.documents.length)
      $("doc-list").append(
        el("p", "Import a completed run or capture your first note.", "muted"),
      );
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) {
      notice("Listening is not supported in this browser.", true);
      return;
    }
    speechSynthesis.cancel();
    const chunks = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    let index = 0;
    listening = true;
    notice("Listening. Use Stop audio to pause the narration.");
    function next() {
      if (!listening || index >= chunks.length) {
        listening = false;
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[index++]);
      u.rate = 0.98;
      u.onend = next;
      u.onerror = () => {
        listening = false;
      };
      speechSynthesis.speak(u);
    }
    next();
  }
  function stop() {
    listening = false;
    notice("Audio stopped.");
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }
  function report(root) {
    const d = selectedDoc();
    if (!d) {
      root.append(
        el("h2", "Your organization, understood together."),
        el(
          "p",
          "Import saved workflow findings, capture a note, or ask the assistant to explain your organization’s knowledge.",
        ),
      );
      const cards = el("div");
      for (const [name, num] of [
        ["Knowledge records", state.documents.length],
        [
          "Proposed changes",
          state.changes.filter((c) => c.state === "proposed").length,
        ],
        [
          "Customer-confirmed",
          state.documents.filter((d) => d.evidence === "customer_confirmed")
            .length,
        ],
      ])
        cards.append(el("div", `${num} ${name}`, "card"));
      root.append(cards);
      return;
    }
    root.append(el("h2", d.title.replaceAll("_", " ")));
    const badges = el("div");
    for (const s of [
      d.category,
      d.evidence.replaceAll("_", " "),
      "Version " + d.revision,
    ])
      badges.append(el("span", s, "badge"));
    root.append(badges);
    const actions = el("div", undefined, "actions");
    actions.append(
      button("Listen", () => speak(d.title + ". " + d.content)),
      button("Stop audio", stop),
      button("Correct this", () => {
        view = "capture";
        renderMain();
      }),
      button("Explain this", () =>
        ask(
          "Explain this document in plain language. Distinguish evidence, assumptions and unknowns, and ask one useful follow-up question.",
        ),
      ),
    );
    root.append(actions, markdown(d.content));
    const sources = el("details");
    sources.append(el("summary", "Sources & version history"));
    if (d.provenance.runId) {
      const a = el("a", "Open source workflow run");
      a.href =
        "/?run=" +
        encodeURIComponent(d.provenance.runId) +
        "&workflow=" +
        encodeURIComponent(d.provenance.workflowId || "");
      sources.append(a);
    }
    const repo = el("a", "View in Forgejo");
    repo.href =
      state.repositoryUrl + "/src/branch/main/knowledge/" + d.id + ".md";
    repo.target = "_blank";
    repo.rel = "noopener noreferrer";
    sources.append(
      el("p"),
      repo,
      el("p", "Commit: " + (d.commitSha || "Not yet recorded"), "muted"),
    );
    for (const c of state.changes.filter(
      (c) => c.targetId === d.id && c.state === "applied",
    ))
      sources.append(
        el("p", `${new Date(c.updatedAt).toLocaleString()} — ${c.reason}`),
      );
    root.append(sources);
    const impacted = state.skills.filter((s) => s.knowledgeIds.includes(d.id));
    const impact = el("div", undefined, "impact");
    impact.append(
      el("h3", "Used by library skills"),
      el(
        "p",
        impacted.length
          ? [...new Set(impacted.map((s) => s.name))].join(", ")
          : "Available in Library knowledge. Add it to a skill’s allowed knowledge to use it in future runs.",
      ),
      el(
        "p",
        "Existing runs keep their saved knowledge. Corrections apply to future retrieval; existing reports and artifacts are not silently rewritten.",
        "muted",
      ),
    );
    root.append(impact);
  }
  function map(root) {
    const info = state.mindmap,
      graph = info?.graph;
    root.append(el("h2", "Organization mind map"));
    root.append(
      el(
        "p",
        "The agent connects concepts across your organization’s knowledge. Select a theme, then a concept to inspect its evidence and relationships.",
        "muted",
      ),
    );
    if (!state.documents.length) {
      root.append(
        el("p", "Import knowledge or capture a note to start your map."),
      );
      return;
    }
    const pending =
      !info || ["pending", "running"].includes(info.state) || info.stale;
    if (info?.state === "failed") {
      root.append(
        el(
          "p",
          "The map could not be updated. Your previous map is preserved.",
          "error",
        ),
      );
      root.append(el("p", info.error || "Generation failed", "muted"));
      if (info.jobId)
        root.append(
          button("Retry map generation", async () => {
            await api(endpoint("/jobs/" + info.jobId + "/retry"), {});
            await refresh(true);
          }),
        );
    } else if (pending) {
      const p = info?.progress;
      root.append(
        el(
          "p",
          "Updating from all organization knowledge…" +
            (p
              ? ` ${p.nextBatch} of ${p.totalBatches} batches processed.`
              : " Changes are grouped before generation starts."),
          "map-status",
        ),
      );
    }
    if (!graph) {
      root.append(
        el(
          "p",
          "The first map is being generated. It will appear here automatically; you can keep working.",
        ),
      );
      return;
    }
    root.append(
      el(
        "p",
        `${info.stale ? "Previous version · " : "Up to date · "}${info.sourceCount} records processed · ${new Date(info.updatedAt).toLocaleString()}`,
        "muted",
      ),
    );
    root.append(el("p", graph.summary));
    const themes = [...new Set(graph.nodes.map((n) => n.theme))];
    if (!themes.includes(mapCategory)) mapCategory = "";
    if (mapCategory)
      root.append(
        button("← All themes", () => {
          mapCategory = "";
          mapConcept = "";
          renderMain();
        }),
      );
    const entries = mapCategory
      ? graph.nodes
          .filter((n) => n.theme === mapCategory)
          .map((n) => ({ id: n.id, label: n.label }))
      : themes.map((t) => ({
          id: t,
          label: `${t} · ${graph.nodes.filter((n) => n.theme === t).length}`,
        }));
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg"),
      height = Math.max(300, entries.length * 76 + 40);
    svg.setAttribute("viewBox", `0 0 850 ${height}`);
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Agent-generated knowledge concepts");
    function node(x, y, w, label, action) {
      const g = document.createElementNS(ns, action ? "a" : "g");
      if (action) {
        g.setAttribute("href", "#concept");
        g.onclick = (e) => {
          e.preventDefault();
          action();
        };
      }
      const r = document.createElementNS(ns, "rect");
      for (const [k, v] of Object.entries({
        x,
        y: y - 24,
        width: w,
        height: 48,
        rx: 9,
      }))
        r.setAttribute(k, v);
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", x + 12);
      text.setAttribute("y", y + 4);
      text.textContent = label.length > 48 ? label.slice(0, 45) + "…" : label;
      const title = document.createElementNS(ns, "title");
      title.textContent = label;
      g.append(r, text, title);
      svg.append(g);
    }
    entries.forEach((n, i) => {
      const y = 40 + i * 76,
        p = document.createElementNS(ns, "path");
      p.setAttribute(
        "d",
        `M230,${height / 2} C310,${height / 2} 310,${y} 370,${y}`,
      );
      svg.append(p);
      node(370, y, 450, n.label, () => {
        if (mapCategory) mapConcept = n.id;
        else {
          mapCategory = n.id;
          mapConcept = "";
        }
        renderMain();
      });
    });
    node(10, height / 2, 220, mapCategory || graph.title);
    const wrap = el("div", undefined, "map");
    wrap.append(svg);
    root.append(wrap);
    const n = graph.nodes.find((n) => n.id === mapConcept);
    function sources(box, ids) {
      for (const id of ids) {
        const d = state.documents.find((d) => d.id === id);
        if (d)
          box.append(
            button("Source: " + d.title.replace(/_/g, " "), () => choose(id)),
          );
      }
    }
    if (n) {
      const box = el("section", undefined, "card concept-detail");
      box.append(
        el("h3", n.label),
        el("span", n.evidence, "badge"),
        el("p", n.summary),
      );
      sources(box, n.sourceIds);
      box.append(el("h3", "Connections"));
      const edges = graph.edges.filter((e) => e.from === n.id || e.to === n.id);
      if (!edges.length)
        box.append(el("p", "No explicit connections in this overview."));
      for (const edge of edges) {
        const other = graph.nodes.find(
          (x) => x.id === (edge.from === n.id ? edge.to : edge.from),
        );
        const row = el("div", undefined, "map-relationship");
        row.append(
          el(
            "p",
            `${graph.nodes.find((x) => x.id === edge.from)?.label} → ${edge.label} → ${graph.nodes.find((x) => x.id === edge.to)?.label}`,
          ),
          el(
            "span",
            edge.inferred ? "Agent inference" : "Supported connection",
            "badge",
          ),
        );
        if (other)
          row.append(
            button("Explore " + other.label, () => {
              mapCategory = other.theme;
              mapConcept = other.id;
              renderMain();
            }),
          );
        sources(row, edge.sourceIds);
        box.append(row);
      }
      root.append(box);
    }
    const coverage = el("details");
    coverage.append(
      el("summary", `Knowledge used (${info.sourceCount} records)`),
    );
    sources(
      coverage,
      state.documents.map((d) => d.id),
    );
    root.append(coverage);
    root.append(
      el(
        "p",
        "This is an agent-generated overview. Evidence links support review; inferred relationships are not confirmed facts.",
        "muted",
      ),
    );
  }
  function capture(root) {
    const d = selectedDoc();
    root.append(
      el(
        "h2",
        d ? "Correct or extend this knowledge" : "Capture new knowledge",
      ),
      el("p", "Your input becomes a reviewable change with its own history."),
    );
    const form = el("form");
    const fields = {};
    function field(name, label, value, tag = "input") {
      const l = el("label", label),
        n = el(tag);
      n.value = value || "";
      if (tag === "textarea") n.rows = 18;
      l.append(n);
      form.append(l);
      fields[name] = n;
      return n;
    }
    field("title", "Title", d?.title);
    const productField = field(
      "productId",
      "Link to product (also saved in organization knowledge)",
      null,
      "select",
    );
    selectOptions(
      productField,
      (state.products || []).map((p) => [p.id, p.name]),
      d?.provenance?.productId || selectedProduct,
      "Organization only",
    );
    const category = field("category", "Category", null, "select");
    for (const v of [
      "business",
      "research",
      "leads",
      "opportunities",
      "decisions",
      "questions",
      "notes",
    ]) {
      const o = el("option", v);
      o.value = v;
      category.append(o);
    }
    category.value = d?.category || "notes";
    field("content", "Knowledge content", d?.content, "textarea");
    field(
      "reason",
      "What changed, and why?",
      d ? "Customer correction" : "New customer input",
    );
    const fileLabel = el("label", "Import text or Markdown", "capture-file"),
      file = el("input");
    file.type = "file";
    file.accept = ".txt,.md,.json";
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 180000)
        return notice("Use a text file smaller than 180 KB.", true);
      fields.content.value = await f.text();
      if (!fields.title.value) fields.title.value = f.name;
    };
    fileLabel.append(file);
    form.append(fileLabel);
    const confirmLabel = el("label", undefined, "checkbox"),
      confirm = el("input");
    confirm.type = "checkbox";
    confirmLabel.append(
      confirm,
      document.createTextNode(
        "I confirm this information from direct knowledge.",
      ),
    );
    form.append(confirmLabel);
    const submit = el("button", "Propose change", "primary");
    submit.type = "submit";
    form.append(submit);
    if (d)
      form.append(
        button("Capture a separate note", () => {
          selected = "";
          renderMain();
        }),
      );
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api(endpoint("/capture"), {
          documentId: d?.id ?? null,
          baseRevision: d?.revision ?? 0,
          reason: fields.reason.value,
          body: {
            productId: fields.productId.value || null,
            title: fields.title.value,
            category: fields.category.value,
            content: fields.content.value,
            evidence: confirm.checked
              ? "customer_confirmed"
              : d?.evidence === "customer_confirmed"
                ? "unverified"
                : d?.evidence || "unverified",
            relatedIds: d?.relatedIds || [],
          },
        });
        view = "changes";
        notice("Input captured. Review and apply the proposed change.");
        await refresh(true);
      } catch (e) {
        notice(e.message, true);
      } finally {
        submit.disabled = false;
      }
    };
    root.append(form);
  }
  const pretty = (v) =>
    typeof v === "string" ? v : JSON.stringify(v, null, 2);
  function changes(root) {
    root.append(
      el("h2", "Review changes"),
      el(
        "p",
        "Knowledge updates are committed to Forgejo. Workflow updates stay as drafts, and skill updates create new versions.",
      ),
    );
    if (!state.changes.length)
      root.append(
        el("p", "No proposals yet. Capture a note or ask the assistant."),
      );
    for (const c of state.changes) {
      const card = el("article", undefined, "card");
      card.append(
        el("span", `${c.kind} · ${c.state}`, "badge"),
        el("h3", c.title),
        el("p", c.reason),
      );
      if (c.error) card.append(el("p", c.error, "error"));
      const details = el("details");
      details.open = ["proposed", "failed"].includes(c.state);
      details.append(el("summary", "Review before and after"));
      const diff = el("div", undefined, "change-diff");
      for (const [label, v] of [
        ["Before", c.before?.content ?? c.before ?? "New item"],
        ["After", c.body?.content ?? c.body],
      ]) {
        const p = el("div");
        p.append(el("strong", label), el("pre", pretty(v)));
        diff.append(p);
      }
      details.append(diff);
      card.append(details);
      if (["proposed", "failed"].includes(c.state)) {
        const confirm = el("input");
        confirm.type = "checkbox";
        const label = el("label", undefined, "checkbox");
        label.append(
          confirm,
          document.createTextNode("Mark this knowledge as customer-confirmed"),
        );
        if (c.kind === "knowledge") card.append(label);
        const actions = el("div", undefined, "actions");
        actions.append(
          button(
            c.kind === "knowledge"
              ? "Apply & commit to Forgejo"
              : c.kind === "workflow"
                ? "Apply as workflow draft"
                : c.kind === "run"
                  ? "Start workflow run"
                  : c.kind === "product"
                    ? "Build product & preview"
                    : "Create skill version",
            async () => {
              await api(endpoint("/changes/" + c.id + "/approve"), {
                confirmKnowledge: confirm.checked,
              });
              notice("Applying the reviewed change…");
              await refresh(true);
            },
            "primary",
          ),
        );
        if (c.state === "proposed")
          actions.append(
            button("Reject", async () => {
              await api(endpoint("/changes/" + c.id + "/reject"), {});
              await refresh(true);
            }),
          );
        card.append(actions);
      }
      if (c.state === "applied" && c.kind === "workflow") {
        const a = el("a", "Open draft in Library");
        a.href = "/builder?workflow=" + c.targetId;
        card.append(a);
      }
      if (c.state === "applied" && c.kind === "run") {
        const a = el("a", "Open workflow run");
        a.href = "/?workflow=" + c.body.workflowId + "&run=" + c.targetId;
        card.append(a);
      }
      root.append(card);
    }
  }
  async function repository(root) {
    root.append(
      el("h2", "Organization repository"),
      el(
        "p",
        "The private Forgejo repository stores readable knowledge files and the commit history. The application keeps an index for retrieval and the library.",
      ),
    );
    const a = el("a", "Open Forgejo repository ↗");
    a.href = state.repositoryUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    root.append(
      a,
      el(
        "p",
        state.repositoryConfigured
          ? "Repository connection configured"
          : "Repository not configured",
        "muted",
      ),
      button("Sync external repository edits", async () => {
        await api(endpoint("/sync"), {});
        notice("Sync started. External edits will be marked unverified.");
        await refresh(true);
      }),
    );
    const history = el("div");
    root.append(history);
    try {
      const r = await api(endpoint("/repository"));
      if (!r.exists)
        history.append(
          el(
            "p",
            "The repository will be created with the first approved knowledge import.",
          ),
        );
      for (const c of r.commits || []) {
        const p = el("p");
        const a = el("a", c.sha.slice(0, 8));
        a.href = state.repositoryUrl + "/commit/" + c.sha;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        p.append(a, document.createTextNode(" " + (c.commit?.message || "")));
        history.append(p);
      }
    } catch (e) {
      history.append(el("p", e.message, "error"));
    }
  }
  function products(root) {
    root.append(
      el("h2", ($("organization").selectedOptions[0]?.textContent || "Organization") + " · Products"),
      el("p", `${(state.products || []).length} products · ${(state.products || []).filter(p => p.previewBuild?.result?.previewUrl).length} previews available`, "muted"),
      el(
        "p",
        "Try previews, discuss changes, and keep product feedback connected to organization knowledge.",
      ),
    );
    root.append(
      button(
        "Start a new product",
        () => {
          selectedProduct = "";
          $("product-context").value = "";
          $("chat-input").value =
            "Help me define a new product for this organization. Ask what it should do and who will use it, then prepare a build proposal.";
          $("chat-input").focus();
        },
        "primary",
      ),
    );
    if (!(state.products || []).length)
      root.append(
        el(
          "p",
          "No products yet. Ask the assistant to help define the first one.",
        ),
      );
    for (const p of state.products || []) {
      const card = el("article", undefined, "card");
      card.append(
        el("h3", p.name),
        el("span", (p.latestBuild?.state || "not built"), "badge"),
        el("p", p.brief.slice(0, 700)),
      );
      if (p.latestBuild?.error)
        card.append(el("p", p.latestBuild?.error, "error"));
      const actions = el("div", undefined, "actions");
      function selectProduct() {
        selectedProduct = p.id;
        selected = "";
        $("product-context").value = p.id;
      }
      actions.append(
        button("Discuss / revise", () => {
          selectProduct();
          $("chat-input").value =
            "Let's discuss improvements to " +
            p.name +
            ". Help me capture feedback before proposing a revision.";
          $("chat-input").focus();
        }),
      );
      actions.append(
        button("Capture feedback", () => {
          selectProduct();
          view = "capture";
          renderMain();
        }),
      );
      const preview = p.previewBuild?.result?.previewUrl;
      const safePreview =
        preview && /^http:\/\/localhost:3002\/[a-f0-9-]+\/$/.test(preview);
      if (safePreview) {
        const a = el("a", "Open preview ↗");
        a.href = preview;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        actions.append(a);
        actions.append(
          button(
            previewing === p.id ? "Hide preview" : "Show preview here",
            () => {
              previewing = previewing === p.id ? "" : p.id;
              renderMain();
            },
          ),
        );
      }
      if (p.latestBuild?.result?.codeUrl) {
        const a = el("a", "Source in Forgejo ↗");
        a.href = p.latestBuild?.result.codeUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        actions.append(a);
      }
      card.append(actions);
      if (safePreview && previewing === p.id) {
        const frame = el("iframe");
        frame.src = preview;
        frame.title = p.name + " preview";
        frame.setAttribute("sandbox", "allow-scripts allow-forms");
        frame.style =
          "width:100%;height:420px;border:1px solid #dce3dc;border-radius:10px;margin-top:16px";
        card.append(frame);
      }
      const notes = state.documents.filter(
        (d) => d.provenance?.productId === p.id,
      );
      card.append(el("h4", "Product knowledge & feedback"));
      if (!notes.length)
        card.append(el("p", "No captured feedback yet.", "muted"));
      for (const d of notes) card.append(button(d.title, () => choose(d.id)));
      const history = el("details");
      history.append(el("summary", p.versions.length + " build version(s)"));
      for (const b of p.versions) {
        const line = el(
          "p",
          new Date(b.created_at).toLocaleString() +
            " · " +
            b.state +
            " · " +
            b.id.slice(0, 8),
        );
        if (b.result?.previewUrl) {
          const a = el("a", " Preview ↗");
          a.href = b.result.previewUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          line.append(a);
        }
        history.append(line);
      }
      card.append(history);
      root.append(card);
    }
  }
  function renderMain() {
    document
      .querySelectorAll("[data-view]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.view === view)),
      );
    const root = $("main-view");
    root.replaceChildren();
    (({ report, map, capture, changes, repository, products })[view] || report)(
      root,
    );
  }
  function selectOptions(node, items, value, placeholder) {
    const old = node.value;
    node.replaceChildren();
    if (placeholder) {
      const p = el("option", placeholder);
      p.value = "";
      node.append(p);
    }
    for (const [v, t] of items) {
      const o = el("option", t);
      o.value = v;
      node.append(o);
    }
    node.value = value ?? old;
  }
  async function loadMessages() {
    const request = ++messageLoad,
      requestedThread = thread,
      requestedOrg = organization;
    if (!thread) {
      $("messages").replaceChildren();
      $("latest-messages").hidden = true;
      return;
    }
    const data = await api(endpoint("/threads/" + thread));
    if (
      request !== messageLoad ||
      requestedThread !== thread ||
      requestedOrg !== organization
    )
      return;
    const signature = JSON.stringify(data.messages);
    if (signature === lastMessages) return;
    const root = $("messages");
    const previousTop = root.scrollTop;
    const follow =
      !lastMessages ||
      followNextMessage ||
      root.scrollHeight - root.clientHeight - root.scrollTop < 60;
    followNextMessage = false;
    lastMessages = signature;
    root.replaceChildren();
    for (const m of data.messages) {
      const card = el("div", undefined, "message " + m.role);
      card.append(
        el("strong", m.role === "user" ? "You" : "Assistant"),
        document.createTextNode(m.content),
      );
      if (m.role === "assistant") {
        card.append(
          el("div"),
          button("Listen", () => speak(m.content)),
          button("Stop", stop),
        );
        for (const id of m.metadata.citations || []) {
          const d = state.documents.find((d) => d.id === id);
          if (d) card.append(button("Source: " + d.title, () => choose(id)));
        }
        for (const q of m.metadata.questions || []) card.append(el("p", q));
        for (const id of m.metadata.productIds || []) {
          const p = (state.products || []).find((p) => p.id === id);
          if (p)
            card.append(
              button("View product: " + p.name, () => {
                selectedProduct = p.id;
                $("product-context").value = p.id;
                previewing = p.id;
                view = "products";
                renderMain();
              }),
            );
        }
        if (m.metadata.proposalIds?.length)
          card.append(
            button("Review proposed changes", () => {
              view = "changes";
              renderMain();
            }),
          );
        for (const error of m.metadata.proposalErrors || [])
          card.append(el("p", "Proposal needs revision: " + error, "error"));
      }
      root.append(card);
    }
    root.scrollTop = follow ? root.scrollHeight : previousTop;
    $("latest-messages").hidden = follow;
  }
  async function refresh(force = false) {
    if (busy || !organization) return;
    busy = true;
    const requestedOrg = organization;
    try {
      const previous = JSON.stringify({
        mindmap: state.mindmap,
        docs: state.documents,
        changes: state.changes,
        jobs: state.jobs,
        products: state.products,
      });
      const nextState = await api(endpoint("/state"));
      if (requestedOrg !== organization) return;
      state = nextState;
      if (
        selectedProduct &&
        !(state.products || []).some((p) => p.id === selectedProduct)
      )
        selectedProduct = "";
      selectOptions(
        $("product-context"),
        (state.products || []).map((p) => [p.id, p.name]),
        selectedProduct,
        "Organization overview",
      );
      state.threads = state.threads.filter((t) => t.scope === "knowledge");
      if (!selected && view !== "capture" && params.get("run"))
        selected =
          state.documents.find((d) => d.provenance.runId === params.get("run"))
            ?.id || "";
      if (selected && !selectedDoc()) selected = "";
      renderList();
      selectOptions(
        $("import-run"),
        state.runs.map((r) => [
          r.id,
          `${r.workflow} · ${r.status} · ${r.id.slice(0, 8)}`,
        ]),
        $("import-run").value || params.get("run"),
        "Choose a run",
      );
      selectOptions(
        $("thread"),
        state.threads.map((t) => [
          t.id,
          t.title + " · " + new Date(t.createdAt).toLocaleDateString(),
        ]),
        thread || state.threads[0]?.id,
      );
      thread = $("thread").value;
      chatBusy = state.jobs.some(
        (j) =>
          j.kind === "assistant" &&
          j.payload?.threadId === thread &&
          ["pending", "running"].includes(j.state),
      );
      $("send").disabled = chatBusy;
      $("send").textContent = chatBusy ? "Thinking…" : "Send";
      $("assistant-context").textContent =
        "Selected knowledge: " +
        (selectedDoc()?.title || "Organization overview") +
        (selectedProduct
          ? " · Product: " +
            (state.products || []).find((p) => p.id === selectedProduct)?.name
          : "");
      if (
        force ||
        (view !== "capture" &&
          previous !==
            JSON.stringify({
              mindmap: state.mindmap,
              docs: state.documents,
              changes: state.changes,
              jobs: state.jobs,
              products: state.products,
            }))
      )
        renderMain();
      await loadMessages();
      renderJobs();
    } catch (e) {
      notice(e.message, true);
    } finally {
      busy = false;
      if (requestedOrg !== organization) void refresh(true);
    }
  }
  function renderJobs() {
    let box = document.querySelector(".jobs");
    if (!box) {
      box = el("div", undefined, "jobs");
      $("main-view").parentElement.append(box);
    }
    box.replaceChildren();
    for (const j of state.jobs.slice(0, 6)) {
      const row = el(
        "p",
        `${j.kind} · ${j.state}${j.result?.count !== undefined ? " · " + j.result.count + " records" : ""}`,
        "muted",
      );
      if (j.error) row.append(el("span", " " + j.error, "error"));
      if (j.state === "failed")
        row.append(
          button("Retry", async () => {
            await api(endpoint("/jobs/" + j.id + "/retry"), {});
            await refresh(true);
          }),
        );
      box.append(row);
    }
  }
  async function newThread() {
    const t = await api(endpoint("/threads"), {
      title: "Organization assistant",
      scope: "knowledge",
    });
    thread = t.id;
    lastMessages = "";
    await refresh();
  }
  async function ask(content) {
    if (!content.trim()) return;
    if (!thread) await newThread();
    await api(endpoint("/threads/" + thread + "/messages"), {
      content,
      documentId: selected || null,
      productId: selectedProduct || null,
    });
    followNextMessage = true;
    $("chat-input").value = "";
    await refresh();
  }
  $("latest-messages").onclick = () => {
    const root = $("messages");
    root.scrollTop = root.scrollHeight;
    $("latest-messages").hidden = true;
  };
  $("messages").onscroll = () => {
    const root = $("messages");
    if (root.scrollHeight - root.clientHeight - root.scrollTop < 60)
      $("latest-messages").hidden = true;
  };
  $("chat-form").onsubmit = async (e) => {
    e.preventDefault();
    $("send").disabled = true;
    try {
      await ask($("chat-input").value);
    } catch (e) {
      notice(e.message, true);
      $("send").disabled = false;
    }
  };
  $("new-chat").onclick = () =>
    newThread().catch((e) => notice(e.message, true));
  $("thread").onchange = () => {
    thread = $("thread").value;
    lastMessages = "";
    loadMessages().catch((e) => notice(e.message, true));
  };
  $("new-note").onclick = () => {
    selected = "";
    view = "capture";
    renderList();
    renderMain();
  };
  $("product-context").onchange = () => {
    selectedProduct = $("product-context").value;
    view = "products";
    renderMain();
  };
  $("search").oninput = renderList;
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.view;
        renderMain();
      }),
  );
  document.querySelectorAll("[data-prompt]").forEach(
    (b) =>
      (b.onclick = () => {
        ask(b.dataset.prompt).catch((e) => notice(e.message, true));
      }),
  );
  $("import").onclick = async () => {
    try {
      if (!$("import-run").value) throw Error("Choose a run first");
      await api(endpoint("/import"), { runId: $("import-run").value });
      notice("Importing saved step and skill findings into Forgejo…");
      await refresh();
    } catch (e) {
      notice(e.message, true);
    }
  };
  $("organization").onchange = () => {
    stop();
    organization = $("organization").value;
    selected = "";
    selectedProduct = "";
    previewing = "";
    thread = "";
    lastMessages = "";
    state.documents = [];
    state.products = [];
    view = "products";
    const url = new URL(location.href);
    url.searchParams.set("organization", organization);
    url.searchParams.set("view", "products");
    url.searchParams.delete("product");
    url.searchParams.delete("document");
    history.replaceState(null, "", url);
    $("main-view").replaceChildren(el("p", "Loading organization products…"));
    refresh(true);
  };
  $("dictate").onclick = () => {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R)
      return notice(
        "Dictation is unavailable in this browser. Type your input or use your device’s keyboard dictation.",
        true,
      );
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new R();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      $("chat-input").value +=
        ($("chat-input").value ? " " : "") + e.results[0][0].transcript;
    };
    recognition.onerror = (e) => notice("Dictation: " + e.error, true);
    recognition.onend = () => {
      recognition = null;
      $("dictate").textContent = "Dictate";
    };
    recognition.start();
    $("dictate").textContent = "Stop dictation";
  };
  window.addEventListener("pagehide", stop);
  setInterval(() => void refresh(), 4000);
  (async () => {
    const c = await api("/builder/catalog");
    selectOptions(
      $("organization"),
      c.organizations.map((o) => [o.id, o.name]),
      params.get("organization") || c.organizations[0]?.id,
    );
    organization = $("organization").value;
    await refresh(true);
  })().catch((e) => notice(e.message, true));
})();
