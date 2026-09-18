import {
  h,
  api,
  button,
  link,
  badge,
  tabs,
  empty,
  jsonDetails,
  output,
  notify,
  navigate,
  setContext,
  poll,
  time,
  safeUrl,
  guardUnsaved,
} from "./core.js";

const categories = [
  "business",
  "research",
  "leads",
  "opportunities",
  "decisions",
  "questions",
  "notes",
];
const views = [
  "overview",
  "knowledge",
  "products",
  "people",
  "campaigns",
  "usage",
  "engagements",
  "changes",
  "settings",
];
const human = (value) => String(value || "").replaceAll("_", " ");
const tone = (state) =>
  ["failed", "unverified"].includes(state)
    ? "warning"
    : ["completed", "applied", "customer_confirmed"].includes(state)
      ? "success"
      : "neutral";

/** Every generated address contains one primary object, never a stale secondary selection. */
export function organizationRoute(
  organization,
  view = "overview",
  selection = {},
) {
  const q = new URLSearchParams({
    organization,
    view: views.includes(view) ? view : "overview",
  });
  if (view === "knowledge" && selection.document)
    q.set("document", selection.document);
  else if (view === "knowledge" && selection.map) q.set("map", "1");
  else if (view === "products" && selection.product) {
    q.set("product", selection.product);
    if (
      [
        "overview",
        "campaigns",
        "releases",
        "usage",
        "hosting",
        "preview",
        "feedback",
        "versions",
      ].includes(selection.tab)
    )
      q.set("tab", selection.tab);
  }
  if (view === "campaigns" && selection.campaign)
    q.set("campaign", selection.campaign);
  if (view === "changes" && selection.change) q.set("change", selection.change);
  return "/next/organizations?" + q;
}

export function organizationContext(
  organization,
  { document: doc, product, concept } = {},
) {
  const base = {
    scope: "knowledge",
    organizationId: organization.id,
    kind: "organization",
    id: organization.id,
    label: organization.name,
    documentId: null,
    productId: null,
    conceptId: null,
    buildId: null,
    version: null,
  };
  if (doc)
    return {
      ...base,
      kind: "document",
      id: doc.id,
      documentId: doc.id,
      version: doc.revision,
      label: `${organization.name} → ${doc.title} · v${doc.revision}`,
    };
  if (product)
    return {
      ...base,
      kind: "product",
      id: product.id,
      productId: product.id,
      buildId: product.latestBuild?.id || null,
      label: `${organization.name} → ${product.name}`,
    };
  if (concept)
    return {
      ...base,
      kind: "concept",
      id: concept.id,
      conceptId: concept.id,
      label: `${organization.name} → ${concept.label}`,
    };
  return base;
}

/** Match the existing isolated static-preview origin; arbitrary source URLs are never embedded. */
export function validPreviewUrl(value) {
  return typeof value === "string" &&
    /^http:\/\/localhost:3002\/[a-f0-9-]+\/$/.test(value)
    ? value
    : null;
}

export function productPresentation(product) {
  const versions = product.versions || [];
  const latest = product.latestBuild || versions.at(-1);
  const preview =
    product.previewBuild ||
    [...versions]
      .reverse()
      .find(
        (b) => b.state === "completed" && validPreviewUrl(b.result?.previewUrl),
      );
  return {
    latest,
    preview,
    previewUrl: validPreviewUrl(preview?.result?.previewUrl),
    title: product.name || "Untitled product",
    description: product.description || "",
    revision: latest?.state || "unknown",
    hasPreviousPreview: !!preview && preview.id !== latest?.id,
  };
}

/** Bounded line comparison for a readable review; full documents remain available alongside it. */
export function knowledgeDiff(before, after) {
  const oldLines = String(before || "")
    .split("\n")
    .filter((x) => x.trim());
  const newLines = String(after || "")
    .split("\n")
    .filter((x) => x.trim());
  const oldSet = new Set(oldLines),
    newSet = new Set(newLines);
  const removed = oldLines.filter((x) => !newSet.has(x)),
    added = newLines.filter((x) => !oldSet.has(x));
  return {
    removed: removed
      .slice(0, 40)
      .map((line) => (line.length > 2000 ? line.slice(0, 2000) + "…" : line)),
    added: added
      .slice(0, 40)
      .map((line) => (line.length > 2000 ? line.slice(0, 2000) + "…" : line)),
    changed: String(before || "") !== String(after || ""),
    truncated:
      removed.length > 40 ||
      added.length > 40 ||
      [...removed, ...added].some((line) => line.length > 2000),
  };
}

/** Chat activity must not offer a content refresh or disturb a product preview. */
export function organizationSnapshot(state) {
  return JSON.stringify({
    documents: state.documents,
    products: state.products,
    mindmap: state.mindmap,
    changes: state.changes,
    runs: state.runs,
    repositoryConfigured: state.repositoryConfigured,
    jobs: state.jobs?.filter((job) => job.kind !== "assistant"),
  });
}

function external(label, url) {
  if (!url || !safeUrl(url)) return null;
  return link(label, url, { target: "_blank", rel: "noopener noreferrer" });
}
function inline(parent, value) {
  const text = String(value || "");
  const pattern =
    /(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>"']+)/g;
  for (const part of text.split(pattern)) {
    const match = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (match)
      parent.append(
        external(match[1], match[2]) || document.createTextNode(match[1]),
      );
    else if (part.startsWith("**") && part.endsWith("**"))
      parent.append(h("strong", {}, part.slice(2, -2)));
    else if (part.startsWith("`") && part.endsWith("`"))
      parent.append(h("code", {}, part.slice(1, -1)));
    else if (/^https?:\/\//.test(part))
      parent.append(external(part, part) || document.createTextNode(part));
    else parent.append(document.createTextNode(part));
  }
  return parent;
}
function markdown(value) {
  const root = h("div", { class: "org-prose" });
  const lines = String(value || "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  let list = null,
    fenced = null,
    paragraph = [];
  const flush = () => {
    if (paragraph.length) root.append(inline(h("p"), paragraph.join(" ")));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      list = null;
      if (fenced) {
        root.append(h("pre", {}, h("code", {}, fenced.join("\n"))));
        fenced = null;
      } else fenced = [];
      continue;
    }
    if (fenced) {
      fenced.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      list = null;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*+])|\d+\.)\s+(.+)$/);
    if (heading) {
      flush();
      list = null;
      root.append(
        inline(h("h" + Math.min(4, heading[1].length + 1)), heading[2]),
      );
    } else if (item) {
      flush();
      const tag = item[1] ? "UL" : "OL";
      if (!list || list.tagName !== tag) {
        list = h(tag.toLowerCase());
        root.append(list);
      }
      list.append(inline(h("li"), item[2]));
    } else if (/^>\s?/.test(line)) {
      flush();
      list = null;
      root.append(inline(h("blockquote"), line.replace(/^>\s?/, "")));
    } else if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")
    ) {
      flush();
      list = null;
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((s) => s.trim());
      const table = h("table"),
        head = h("tr");
      cells(line).forEach((s) => head.append(inline(h("th"), s)));
      table.append(h("thead", {}, head));
      const body = h("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const row = h("tr");
        cells(lines[i]).forEach((s) => row.append(inline(h("td"), s)));
        body.append(row);
        i++;
      }
      i--;
      table.append(body);
      root.append(h("div", { class: "org-table-scroll" }, table));
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
  if (fenced) root.append(h("pre", {}, h("code", {}, fenced.join("\n"))));
  return root;
}
function field(label, node, help) {
  return h(
    "label",
    { class: "nx-field" },
    h("span", {}, label),
    node,
    help ? h("small", { class: "nx-muted" }, help) : null,
  );
}
function select(items, value = "") {
  const node = h("select");
  for (const [id, label] of items)
    node.append(h("option", { value: id }, label));
  node.value = value;
  return node;
}
function card(title, ...children) {
  return h(
    "section",
    { class: "nx-card org-section" },
    title ? h("h2", {}, title) : null,
    ...children,
  );
}
function act(label, handler, options = {}) {
  const node = button(
    label,
    async () => {
      node.disabled = true;
      try {
        await handler();
      } catch (e) {
        notify(e.message || String(e), "error");
      } finally {
        if (node.isConnected) node.disabled = false;
      }
    },
    options,
  );
  return node;
}

export async function renderOrganizations(ctx) {
  const url =
    ctx.url instanceof URL ? ctx.url : new URL(ctx.url, location.origin);
  const q = url.searchParams,
    orgId = q.get("organization");
  const catalog = await api("/builder/catalog");
  if (ctx.signal.aborted) return;
  const organizations = catalog.organizations || [];
  ctx.root.classList.add("org-workspace");
  ctx.onCleanup(() => ctx.root.classList.remove("org-workspace"));
  if (!orgId) {
    setContext({
      scope: "knowledge",
      organizationId: null,
      kind: "organization",
      label: "Organizations",
      documentId: null,
      productId: null,
    });
    const search = h("input", {
      type: "search",
      placeholder: "Find an organization",
      "aria-label": "Find an organization",
    });
    const list = h("div", { class: "nx-list org-directory" });
    const draw = () => {
      list.replaceChildren();
      const matches = organizations.filter((o) =>
        (o.name + " " + (o.website || ""))
          .toLowerCase()
          .includes(search.value.toLowerCase()),
      );
      for (const o of matches)
        list.append(
          link(
            h(
              "div",
              { class: "org-directory-row" },
              h(
                "div",
                {},
                h("strong", {}, o.name),
                h(
                  "p",
                  { class: "nx-muted nx-small" },
                  o.website ||
                    (o.kind === "platform"
                      ? "Shared platform workspace"
                      : "Knowledge, engagements, and products"),
                ),
              ),
              badge(o.kind === "platform" ? "Platform" : "Customer", "neutral"),
            ),
            organizationRoute(o.id),
            { class: "org-directory-link" },
          ),
        );
      if (!matches.length)
        list.append(
          empty(
            "No matching organizations",
            "Organizations are identified when work starts for a customer.",
          ),
        );
    };
    search.oninput = draw;
    ctx.root.replaceChildren(
      h(
        "header",
        { class: "nx-page-head" },
        h(
          "div",
          {},
          h("h1", {}, "Organizations"),
          h(
            "p",
            { class: "nx-muted" },
            "Your customers, what you know, and what you are building.",
          ),
        ),
      ),
      field("Search organizations", search),
      list,
    );
    draw();
    return;
  }
  const org = organizations.find((o) => o.id === orgId);
  if (!org) {
    ctx.root.replaceChildren(
      empty(
        "Organization not found",
        "Choose an organization from the directory.",
      ),
      link("All organizations", "/next/organizations"),
    );
    return;
  }
  const endpoint = (suffix) =>
    `/workspace/${encodeURIComponent(orgId)}${suffix}`;
  const [initialState, engagementsResult] = await Promise.allSettled([
    api(endpoint("/state")),
    api("/engagements?organization=" + encodeURIComponent(orgId)),
  ]);
  if (ctx.signal.aborted) return;
  if (initialState.status === "rejected") throw initialState.reason;
  let state = initialState.value,
    pendingState = null,
    pendingEngagements = null,
    modal = null,
    draftDirty = false;
  let engagements =
    engagementsResult.status === "fulfilled"
      ? engagementsResult.value.filter(
          (e) => (e.customer_organization_id || e.organization_id) === orgId,
        )
      : [];
  let engagementsUnavailable = engagementsResult.status === "rejected";
  const view = views.includes(q.get("view")) ? q.get("view") : "overview";
  const docId = view === "knowledge" ? q.get("document") : null;
  const productId = view === "products" ? q.get("product") : null;
  let primary = organizationContext(org),
    audioStop = () => {},
    recognition = null;
  const content = h("div", { class: "org-content" });
  const updateBar = h("div", {
    class: "org-update",
    hidden: true,
    role: "status",
  });
  const currentStatus = h("span", { class: "nx-small nx-muted" });
  const path = (target, selection) =>
    organizationRoute(orgId, target, selection);
  function context(selection) {
    primary = organizationContext(org, selection);
    setContext(primary);
  }
  function explain(prompt) {
    setContext(primary);
    window.dispatchEvent(
      new CustomEvent("nx:assistant", { detail: { prompt } }),
    );
  }
  context();
  guardUnsaved(() => draftDirty, ctx);
  ctx.onCleanup(() => {
    audioStop();
    recognition?.stop();
    modal?.remove();
    ctx.root.classList.remove("org-workspace");
  });
  const header = h(
    "header",
    { class: "nx-page-head" },
    h(
      "div",
      {},
      link("Organizations", "/next/organizations", { class: "nx-small" }),
      h("h1", {}, org.name),
      currentStatus,
    ),
    h(
      "div",
      { class: "nx-actions" },
      link("Changes", path("changes")),
      link("Settings", path("settings")),
    ),
  );
  const nav = tabs(
    [
      { key: "overview", label: "Overview" },
      { key: "knowledge", label: "Knowledge" },
      { key: "products", label: "Products" },
      { key: "people", label: "People" },
      { key: "campaigns", label: "Campaigns" },
      { key: "usage", label: "Usage" },
      { key: "engagements", label: "Engagements" },
    ],
    view,
    (key) => navigate(path(key)),
  );
  ctx.root.replaceChildren(header, nav, updateBar, content);

  async function reload() {
    const [fresh, work] = await Promise.all([
      api(endpoint("/state")),
      ["overview", "engagements"].includes(view)
        ? api("/engagements?organization=" + encodeURIComponent(orgId)).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    if (ctx.signal.aborted) return;
    if (work) {
      engagements = work.filter(
        (e) => (e.customer_organization_id || e.organization_id) === orgId,
      );
      engagementsUnavailable = false;
    }
    state = fresh;
    pendingState = null;
    updateBar.hidden = true;
    render();
  }
  function changeLink(id, label = "Review change") {
    return link(label, path("changes", { change: id }));
  }
  function docLink(doc, label) {
    return link(
      label || human(doc.title),
      path("knowledge", { document: doc.id }),
    );
  }
  function productLink(product, label) {
    return link(
      label || product.name,
      path("products", { product: product.id }),
    );
  }
  function buildLink(build, label = "Build details") {
    return build
      ? link(label, "/next/run?build=" + encodeURIComponent(build.id))
      : null;
  }
  function runLink(run, label) {
    return link(
      label || run.workflow || "View run",
      "/next/run?run=" + encodeURIComponent(run.id),
    );
  }
  function evidence(value) {
    return badge(human(value || "unverified"), tone(value));
  }
  function notesList(docs) {
    const list = h("div", { class: "nx-list" });
    for (const d of docs)
      list.append(
        h(
          "article",
          { class: "org-record-row" },
          h(
            "div",
            {},
            docLink(d),
            h(
              "p",
              { class: "nx-muted nx-small" },
              human(d.category) + " · Updated " + time(d.updatedAt),
            ),
          ),
          evidence(d.evidence),
        ),
      );
    return list;
  }
  function showModal(title, build, selection) {
    if (modal) return;
    const previousContext = primary,
      previousFocus = document.activeElement;
    const dialog = h("dialog", { class: "org-dialog", "aria-label": title });
    modal = dialog;
    if (selection) context(selection);
    function close(force = false) {
      if (
        !force &&
        draftDirty &&
        !window.confirm("Discard these unsaved changes?")
      )
        return;
      draftDirty = false;
      recognition?.stop();
      dialog.close();
      dialog.remove();
      modal = null;
      primary = previousContext;
      setContext(primary);
      previousFocus?.focus();
    }
    dialog.append(
      h(
        "header",
        { class: "org-dialog-head" },
        h("h2", {}, title),
        button("Close", () => close(), { "aria-label": "Close " + title }),
      ),
    );
    dialog.oncancel = (e) => {
      e.preventDefault();
      close();
    };
    const body = h("div", { class: "org-dialog-body" });
    dialog.append(body);
    document.body.append(dialog);
    build(body, close);
    dialog.showModal();
    body.querySelector("input,textarea,select,button")?.focus();
  }
  function dictation(input) {
    const Recognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return null;
    const toggle = act("Dictate", () => {
      if (recognition) {
        recognition.stop();
        return;
      }
      recognition = new Recognition();
      recognition.lang = document.documentElement.lang || "en-US";
      recognition.interimResults = false;
      recognition.onresult = (e) => {
        input.value += (input.value ? "\n" : "") + e.results[0][0].transcript;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      recognition.onerror = (e) => notify("Dictation: " + e.error, "error");
      recognition.onend = () => {
        recognition = null;
        toggle.textContent = "Dictate";
      };
      recognition.start();
      toggle.textContent = "Stop dictation";
    });
    return toggle;
  }
  function capture(doc = null, product = null) {
    showModal(
      doc
        ? "Suggest a correction"
        : product
          ? "Capture product feedback"
          : "Add knowledge",
      (root, close) => {
        const form = h("form", { class: "org-form" });
        const title = h("input", {
          required: true,
          maxLength: 200,
          value: doc?.title || "",
        });
        const category = select(
          categories.map((c) => [c, human(c)]),
          doc?.category || "notes",
        );
        const association = select(
          [
            ["", "Organization only"],
            ...(state.products || []).map((p) => [p.id, p.name]),
          ],
          doc?.provenance?.productId || product?.id || "",
        );
        const body = h("textarea", {
          required: true,
          rows: 14,
          maxLength: 180000,
          value: doc?.content || "",
        });
        const reason = h("textarea", {
          required: true,
          rows: 2,
          maxLength: 12000,
          placeholder: doc
            ? "What changed, and how do you know?"
            : "Where did this information come from?",
        });
        const confirmed = h("input", { type: "checkbox" });
        form.oninput = () => {
          draftDirty = true;
        };
        const file = h("input", { type: "file", accept: ".txt,.md,.json" });
        file.onchange = async () => {
          const value = file.files[0];
          if (!value) return;
          if (value.size > 180000) {
            notify("Choose a text file smaller than 180 KB.", "error");
            return;
          }
          try {
            body.value = await value.text();
            if (!title.value) title.value = value.name;
            draftDirty = true;
          } catch (e) {
            notify(e.message, "error");
          }
        };
        form.append(
          h(
            "p",
            { class: "nx-callout" },
            doc
              ? `This proposes a change to version ${doc.revision}. Review it before it updates the knowledge base.`
              : "Your input becomes a proposed knowledge record. Capturing product feedback does not change its code.",
          ),
          field("Title", title),
          h(
            "div",
            { class: "nx-grid org-two" },
            field("Category", category),
            field("Applies to", association),
          ),
          field(
            doc ? "Updated content" : "What would you like to capture?",
            body,
          ),
          h("div", { class: "nx-actions" }, dictation(body)),
          h(
            "details",
            {},
            h("summary", {}, "Import a text file"),
            field("Text, Markdown, or JSON", file),
          ),
          field("Source and reason", reason),
          h(
            "label",
            { class: "org-checkbox" },
            confirmed,
            "I confirm this information from direct knowledge.",
          ),
        );
        const submit = h(
          "button",
          { type: "submit", class: "nx-button nx-primary" },
          "Review proposed change",
        );
        form.append(
          h(
            "div",
            { class: "nx-actions" },
            submit,
            button("Cancel", () => close()),
          ),
        );
        form.onsubmit = async (e) => {
          e.preventDefault();
          if (!form.reportValidity()) return;
          submit.disabled = true;
          try {
            const change = await api(endpoint("/capture"), {
              method: "POST",
              body: {
                documentId: doc?.id || null,
                baseRevision: doc?.revision || 0,
                reason: reason.value.trim(),
                body: {
                  title: title.value.trim(),
                  category: category.value,
                  content: body.value,
                  productId: association.value || null,
                  evidence: confirmed.checked
                    ? "customer_confirmed"
                    : doc?.evidence === "customer_confirmed"
                      ? "unverified"
                      : doc?.evidence || "unverified",
                  relatedIds: doc?.relatedIds || [],
                },
              },
            });
            close(true);
            notify("Change prepared for review.");
            navigate(path("changes", { change: change.id }));
          } catch (error) {
            notify(error.message, "error");
            submit.disabled = false;
          }
        };
        root.append(form);
      },
      doc ? { document: doc } : product ? { product } : {},
    );
  }
  function productProposal(product = null) {
    showModal(
      product ? "Build a product revision" : "Plan a new product",
      (root, close) => {
        const form = h("form", { class: "org-form" });
        const name = h("input", {
          required: true,
          maxLength: 160,
          value: product?.name || "",
        });
        const brief = h("textarea", {
          required: true,
          rows: 9,
          maxLength: 10000,
          placeholder: product
            ? "Describe the changes, the feedback they address, and what should stay the same."
            : "Who will use it? What should it do? Include the knowledge or findings it should draw on.",
        });
        const submit = h(
          "button",
          { type: "submit", class: "nx-button nx-primary" },
          "Prepare build for review",
        );
        form.oninput = () => {
          draftDirty = true;
        };
        form.append(
          h(
            "p",
            { class: "nx-callout" },
            "This prepares a build proposal. Approving it starts OpenHands and publishes an isolated static web preview. Existing versions remain available.",
          ),
          field("Product name", name),
          field(product ? "Requested changes" : "Product brief", brief),
          dictation(brief),
          h(
            "div",
            { class: "nx-actions" },
            submit,
            button("Cancel", () => close()),
          ),
        );
        form.onsubmit = async (e) => {
          e.preventDefault();
          if (!form.reportValidity()) return;
          submit.disabled = true;
          try {
            const change = await api(endpoint("/products/propose"), {
              method: "POST",
              body: {
                name: name.value.trim(),
                brief: brief.value.trim(),
                productId: product?.id || null,
              },
            });
            close(true);
            navigate(path("changes", { change: change.id }));
          } catch (error) {
            notify(error.message, "error");
            submit.disabled = false;
          }
        };
        root.append(form);
      },
      product ? { product } : {},
    );
  }
  function metadata(product) {
    showModal(
      "Edit product details",
      (root, close) => {
        const name = h("input", {
          required: true,
          maxLength: 160,
          value: product.name,
        });
        const description = h("textarea", {
          rows: 4,
          maxLength: 2000,
          value: product.description || "",
        });
        const form = h(
          "form",
          { class: "org-form" },
          field("Name", name),
          field("Description", description),
          h(
            "p",
            { class: "nx-muted" },
            "This changes the portfolio label. It does not rebuild the product.",
          ),
        );
        const submit = h(
          "button",
          { type: "submit", class: "nx-button nx-primary" },
          "Save details",
        );
        form.append(submit);
        form.oninput = () => {
          draftDirty = true;
        };
        form.onsubmit = async (e) => {
          e.preventDefault();
          submit.disabled = true;
          try {
            await api(endpoint(`/products/${product.id}/metadata`), {
              method: "POST",
              body: {
                name: name.value.trim(),
                description: description.value.trim(),
                revision: product.metadataRevision || 0,
              },
            });
            close(true);
            await reload();
            notify("Product details saved.");
          } catch (error) {
            notify(error.message, "error");
            submit.disabled = false;
          }
        };
        root.append(form);
      },
      { product },
    );
  }
  function audioPlayer(doc) {
    if (!("speechSynthesis" in window))
      return h(
        "p",
        { class: "nx-small nx-muted" },
        "Audio narration is unavailable in this browser.",
      );
    const chunks = (doc.title + ".\n" + doc.content).match(
      /[^.!?\n]+[.!?\n]*/g,
    ) || [doc.content];
    let index = 0,
      active = false,
      paused = false,
      generation = 0;
    const status = h(
      "span",
      { class: "nx-small", role: "status" },
      "Listen to this report",
    );
    const speed = select(
      [
        ["0.8", "0.8×"],
        ["1", "1×"],
        ["1.25", "1.25×"],
        ["1.5", "1.5×"],
      ],
      "1",
    );
    speed.setAttribute("aria-label", "Narration speed");
    const progress = h("progress", {
      max: chunks.length,
      value: 0,
      "aria-label": "Report narration progress",
    });
    const play = button("Play", () => {
      if (paused) {
        speechSynthesis.resume();
        paused = false;
        play.textContent = "Pause";
        status.textContent = `Section ${index + 1} of ${chunks.length}`;
      } else if (active) {
        speechSynthesis.pause();
        paused = true;
        play.textContent = "Resume";
        status.textContent = "Paused";
      } else {
        active = true;
        paused = false;
        play.textContent = "Pause";
        speakNext(++generation);
      }
    });
    function stopAudio() {
      generation++;
      active = false;
      paused = false;
      index = 0;
      speechSynthesis.cancel();
      progress.value = 0;
      play.textContent = "Play";
      status.textContent = "Listen to this report";
    }
    function speakNext(token) {
      if (!active || token !== generation || ctx.signal.aborted) return;
      if (index >= chunks.length) {
        stopAudio();
        status.textContent = "Narration complete";
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.rate = Number(speed.value);
      progress.value = index;
      status.textContent = `Section ${index + 1} of ${chunks.length}`;
      utterance.onend = () => {
        if (token === generation) {
          index++;
          speakNext(token);
        }
      };
      utterance.onerror = (e) => {
        if (token === generation) {
          stopAudio();
          if (e.error !== "canceled")
            status.textContent = "Audio unavailable. Try again.";
        }
      };
      speechSynthesis.speak(utterance);
    }
    audioStop();
    audioStop = stopAudio;
    return h(
      "div",
      { class: "org-audio" },
      play,
      button("Stop", stopAudio),
      speed,
      progress,
      status,
    );
  }
  function documentView(doc, compact = false) {
    const root = h("article", { class: "org-document" });
    root.append(
      h(
        "div",
        { class: "nx-row org-document-meta" },
        badge(human(doc.category)),
        evidence(doc.evidence),
        h(
          "span",
          { class: "nx-small nx-muted" },
          `Version ${doc.revision} · ${time(doc.updatedAt)}`,
        ),
      ),
    );
    if (!compact)
      root.append(
        h("h2", {}, human(doc.title)),
        h(
          "div",
          { class: "nx-actions" },
          button("Suggest a correction", () => capture(doc)),
          button("Explain this", () =>
            explain(
              "Explain this document in plain language. Distinguish evidence, assumptions, and unknowns.",
            ),
          ),
          button("Walk me through it", () =>
            explain(
              "Walk me through this document one section at a time. Explain the evidence and ask one question to check understanding.",
            ),
          ),
        ),
        audioPlayer(doc),
      );
    root.append(markdown(doc.content));
    const source = h(
      "details",
      { class: "org-disclosure" },
      h("summary", {}, "Sources and history"),
    );
    if (doc.provenance?.runId)
      source.append(
        link(
          "Original workflow run",
          "/next/run?run=" + encodeURIComponent(doc.provenance.runId),
        ),
      );
    if (state.repositoryUrl)
      source.append(
        h(
          "p",
          {},
          external(
            "Source in Forgejo",
            state.repositoryUrl +
              "/src/branch/main/knowledge/" +
              doc.id +
              ".md",
          ),
        ),
      );
    if (doc.provenance?.productId) {
      const p = state.products?.find((p) => p.id === doc.provenance.productId);
      if (p) source.append(h("p", {}, "Also linked to ", productLink(p)));
    }
    for (const c of state.changes.filter(
      (c) => c.targetId === doc.id && c.state === "applied",
    ))
      source.append(h("p", {}, time(c.updatedAt) + " — " + c.reason));
    if (doc.commitSha)
      source.append(
        h("p", { class: "nx-small nx-muted" }, "Commit " + doc.commitSha),
      );
    source.append(jsonDetails(doc.provenance || {}, "Source metadata"));
    root.append(source);
    const impacted = (state.skills || []).filter((s) =>
      (s.knowledgeIds || []).includes(doc.id),
    );
    const usage = h(
      "details",
      { class: "org-disclosure" },
      h("summary", {}, "Use in future workflows"),
      h(
        "p",
        {},
        impacted.length
          ? [...new Set(impacted.map((s) => s.name))].join(", ")
          : "Available as reference knowledge for future skill retrieval.",
      ),
      h(
        "p",
        { class: "nx-muted" },
        "Existing runs keep their saved knowledge. Corrections do not rewrite previous reports or artifacts.",
      ),
    );
    root.append(usage);
    return root;
  }
  function overview() {
    const pending = state.changes.filter((c) =>
      ["proposed", "failed"].includes(c.state),
    );
    const active = engagements.filter(
      (e) => !["completed", "cancelled"].includes(e.state),
    );
    content.append(
      h(
        "div",
        { class: "org-overview-actions nx-actions" },
        button("Add knowledge", () => capture(), { primary: true }),
        link(
          "Start an engagement",
          "/next/run?new=engagement&organization=" + orgId,
        ),
      ),
    );
    const stats = h("div", { class: "org-stats" });
    for (const [label, count, target] of [
      ["Knowledge records", state.documents.length, "knowledge"],
      ["Products", state.products?.length || 0, "products"],
      ["Active engagements", active.length, "engagements"],
      ["Changes to review", pending.length, "changes"],
    ])
      stats.append(
        link(
          h("div", {}, h("strong", {}, String(count)), h("span", {}, label)),
          path(target),
          { class: "org-stat" },
        ),
      );
    content.append(stats);
    if (pending.length)
      content.append(
        card(
          "Needs your review",
          ...pending
            .slice(0, 3)
            .map((c) =>
              h(
                "div",
                { class: "org-record-row" },
                h(
                  "div",
                  {},
                  changeLink(c.id, c.title),
                  h("p", { class: "nx-small nx-muted" }, c.reason),
                ),
                badge(human(c.kind)),
              ),
            ),
        ),
      );
    const columns = h("div", { class: "nx-grid org-two" });
    const findings = card(
      "Recent knowledge",
      state.documents.length
        ? notesList(state.documents.slice(0, 5))
        : empty(
            "Your knowledge base starts here",
            "Capture a finding or bring in completed workflow results.",
          ),
      link("All knowledge", path("knowledge")),
    );
    const work = card(
      "Current engagements",
      ...active.slice(0, 4).map(engagementRow),
    );
    if (!active.length)
      work.append(
        h(
          "p",
          { class: "nx-muted" },
          engagementsUnavailable
            ? "Engagements could not be loaded. Open the Run workspace to check."
            : "No active engagements for this organization.",
        ),
      );
    work.append(link("All engagements", path("engagements")));
    columns.append(findings, work);
    content.append(columns);
    const available = (state.products || []).filter(
      (p) => productPresentation(p).previewUrl,
    );
    if (available.length)
      content.append(
        card(
          "Ready to try",
          ...available
            .slice(0, 4)
            .map((p) =>
              h(
                "div",
                { class: "org-record-row" },
                h(
                  "div",
                  {},
                  productLink(p),
                  h(
                    "p",
                    { class: "nx-muted nx-small" },
                    p.description || "Preview available",
                  ),
                ),
                link("View product", path("products", { product: p.id })),
              ),
            ),
        ),
      );
  }
  function importResults() {
    showModal("Bring in workflow results", (root, close) => {
      const runs = state.runs.filter((r) => r.status === "completed");
      if (!runs.length) {
        root.append(
          empty(
            "No completed results",
            "Complete a workflow for this organization before importing its findings.",
          ),
        );
        return;
      }
      const chosen = select(
        runs.map((r) => [r.id, `${r.workflow} · ${time(r.createdAt)}`]),
        runs[0].id,
      );
      root.append(
        h(
          "p",
          {},
          "Saved step and skill findings become sourced organization knowledge. Research is not marked customer-confirmed.",
        ),
        field("Completed workflow", chosen),
        act("Import findings", async () => {
          await api(endpoint("/import"), {
            method: "POST",
            body: { runId: chosen.value },
          });
          close(true);
          notify("Import started. New findings will appear when ready.");
        }),
      );
    });
  }
  function knowledge() {
    const doc = docId && state.documents.find((d) => d.id === docId);
    if (docId && !doc) {
      content.append(
        empty(
          "Knowledge record not found",
          "It may belong to another organization.",
        ),
        link("All knowledge", path("knowledge")),
      );
      return;
    }
    if (doc) {
      context({ document: doc });
      content.append(
        link("All knowledge", path("knowledge")),
        documentView(doc),
      );
      return;
    }
    content.append(
      h(
        "div",
        { class: "nx-row org-section-head" },
        h("h2", {}, "Knowledge"),
        h(
          "div",
          { class: "nx-actions" },
          button("Add knowledge", () => capture(), { primary: true }),
          button("Import results", importResults),
        ),
      ),
    );
    content.append(
      tabs(
        [
          { key: "list", label: "List" },
          { key: "map", label: "Mind map" },
        ],
        q.get("map") === "1" ? "map" : "list",
        (key) =>
          navigate(path("knowledge", key === "map" ? { map: true } : {})),
      ),
    );
    if (q.get("map") === "1") {
      mindmap();
      return;
    }
    const search = h("input", {
      type: "search",
      placeholder: "Search findings, sources, and decisions",
      "aria-label": "Search knowledge",
    });
    const category = select([
      ["", "All categories"],
      ...categories.map((c) => [c, human(c)]),
    ]);
    category.setAttribute("aria-label", "Filter by category");
    const certainty = select([
      ["", "All evidence"],
      ["customer_confirmed", "Customer confirmed"],
      ["researched", "Researched"],
      ["inferred", "Inferred"],
      ["unverified", "Unverified"],
    ]);
    certainty.setAttribute("aria-label", "Filter by evidence");
    const list = h("div");
    function filter() {
      const term = search.value.toLowerCase();
      const docs = state.documents.filter(
        (d) =>
          (!category.value || d.category === category.value) &&
          (!certainty.value || d.evidence === certainty.value) &&
          `${d.title} ${d.content}`.toLowerCase().includes(term),
      );
      list.replaceChildren(
        docs.length
          ? notesList(docs)
          : empty(
              "No matching knowledge",
              state.documents.length
                ? "Try another search or filter."
                : "Capture a note or import completed workflow results.",
            ),
      );
    }
    search.oninput = filter;
    category.onchange = filter;
    certainty.onchange = filter;
    content.append(
      h("div", { class: "org-filters" }, search, category, certainty),
      list,
    );
    filter();
  }
  function mindmap() {
    const info = state.mindmap,
      graph = info?.graph;
    const status = h("div", { class: "nx-callout org-map-status" });
    status.dataset.mapStatus = "true";
    updateMapStatus(status, info);
    content.append(status);
    if (!state.documents.length) {
      content.append(
        empty(
          "Add knowledge to start your map",
          "The agent connects findings across the organization as the knowledge base grows.",
        ),
      );
      return;
    }
    if (!graph) {
      content.append(
        empty(
          "Your map is being prepared",
          "An update will appear here when generation finishes. You can keep working.",
        ),
      );
      return;
    }
    content.append(h("p", { class: "nx-muted" }, graph.summary));
    let theme = "",
      selectedConcept = null;
    const canvas = h("div", {
      class: "org-map-canvas",
      tabindex: "0",
      "aria-label": "Organization knowledge map",
    });
    const inspector = h("aside", { class: "org-map-inspector" });
    const split = h("div", { class: "org-map-layout" }, canvas, inspector);
    const trail = h("div", { class: "nx-actions org-map-trail" });
    const themes = [...new Set(graph.nodes.map((n) => n.theme))];
    const filter = select([["", "All themes"], ...themes.map((t) => [t, t])]);
    filter.setAttribute("aria-label", "Map theme");
    const outline = h(
      "details",
      { class: "org-disclosure" },
      h("summary", {}, "Browse concepts as a list"),
    );
    for (const n of graph.nodes)
      outline.append(button(n.label + " · " + n.theme, () => chooseConcept(n)));
    function sources(box, ids = []) {
      for (const id of ids) {
        const doc = state.documents.find((d) => d.id === id);
        if (!doc) continue;
        const details = h(
          "details",
          { class: "org-map-source" },
          h("summary", {}, human(doc.title)),
          evidence(doc.evidence),
          markdown(doc.content),
          docLink(doc, "Open full record"),
        );
        box.append(details);
      }
    }
    function chooseConcept(n) {
      const changingTheme = theme !== n.theme;
      theme = n.theme;
      selectedConcept = n;
      filter.value = theme;
      if (changingTheme) draw();
      context({ concept: n });
      inspect();
      canvas
        .querySelectorAll("[data-concept]")
        .forEach((node) =>
          node.setAttribute(
            "aria-current",
            String(node.dataset.concept === n.id),
          ),
        );
    }
    function inspect() {
      inspector.replaceChildren();
      if (!selectedConcept) {
        inspector.append(
          empty(
            "Explore the connections",
            "Select a concept to see its evidence, sources, and relationships.",
          ),
        );
        return;
      }
      const n = selectedConcept;
      inspector.append(
        h("h3", {}, n.label),
        evidence(n.evidence),
        h("p", {}, n.summary),
        button("Explain this concept", () =>
          explain(
            "Explain this selected mind map concept, its evidence, and any inferred connections.",
          ),
        ),
        h("h4", {}, "Evidence"),
      );
      sources(inspector, n.sourceIds);
      const edges = graph.edges.filter((e) => e.from === n.id || e.to === n.id);
      inspector.append(h("h4", {}, "Connections"));
      if (!edges.length)
        inspector.append(
          h(
            "p",
            { class: "nx-muted" },
            "No explicit connections in this overview.",
          ),
        );
      for (const edge of edges) {
        const from = graph.nodes.find((x) => x.id === edge.from),
          to = graph.nodes.find((x) => x.id === edge.to),
          other = edge.from === n.id ? to : from;
        const relation = h(
          "div",
          { class: "org-map-relation" },
          h(
            "p",
            {},
            `${from?.label || "Concept"} → ${edge.label} → ${to?.label || "Concept"}`,
          ),
          badge(
            edge.inferred ? "Agent inference" : "Supported connection",
            edge.inferred ? "warning" : "neutral",
          ),
        );
        if (other)
          relation.append(
            button("Explore " + other.label, () => chooseConcept(other)),
          );
        sources(relation, edge.sourceIds);
        inspector.append(relation);
      }
    }
    function draw() {
      canvas.replaceChildren();
      trail.replaceChildren();
      if (theme)
        trail.append(
          button("All themes", () => {
            theme = "";
            selectedConcept = null;
            filter.value = "";
            context();
            draw();
            inspect();
          }),
          h("span", { class: "nx-muted" }, theme),
        );
      const entries = theme
        ? graph.nodes.filter((n) => n.theme === theme)
        : themes.map((t) => ({
            id: t,
            label: `${t} · ${graph.nodes.filter((n) => n.theme === t).length} concepts`,
          }));
      const ns = "http://www.w3.org/2000/svg",
        svg = document.createElementNS(ns, "svg");
      const height = Math.max(320, entries.length * 76 + 40);
      svg.setAttribute("viewBox", `0 0 900 ${height}`);
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", theme || "Organization knowledge themes");
      function node(x, y, w, label, action, id) {
        const g = document.createElementNS(ns, "g");
        if (action) {
          g.setAttribute("tabindex", "0");
          g.setAttribute("role", "button");
          g.setAttribute("aria-label", label);
          g.onclick = action;
          g.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              action();
            }
          };
        }
        if (id && theme) {
          g.dataset.concept = id;
          g.setAttribute("aria-current", String(selectedConcept?.id === id));
        }
        const r = document.createElementNS(ns, "rect");
        for (const [key, value] of Object.entries({
          x,
          y: y - 24,
          width: w,
          height: 48,
          rx: 10,
        }))
          r.setAttribute(key, String(value));
        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", String(x + 14));
        text.setAttribute("y", String(y + 5));
        text.textContent = label.length > 49 ? label.slice(0, 46) + "…" : label;
        const title = document.createElementNS(ns, "title");
        title.textContent = label;
        g.append(r, text, title);
        svg.append(g);
      }
      entries.forEach((n, i) => {
        const y = 40 + i * 76;
        const edge = document.createElementNS(ns, "path");
        edge.setAttribute(
          "d",
          `M260,${height / 2} C320,${height / 2} 320,${y} 370,${y}`,
        );
        svg.append(edge);
        node(
          370,
          y,
          490,
          n.label,
          () => {
            if (theme) chooseConcept(n);
            else {
              theme = n.id;
              selectedConcept = null;
              filter.value = theme;
              draw();
              inspect();
            }
          },
          n.id,
        );
      });
      node(10, height / 2, 250, theme || graph.title || org.name);
      canvas.append(svg);
    }
    filter.onchange = () => {
      theme = filter.value;
      selectedConcept = null;
      context();
      draw();
      inspect();
    };
    content.append(
      h("div", { class: "org-map-toolbar nx-row" }, filter, trail),
      split,
      outline,
      h(
        "p",
        { class: "nx-small nx-muted" },
        "Agent-generated relationships support exploration. Inferred connections are not confirmed facts.",
      ),
    );
    const coverage = h(
      "details",
      { class: "org-disclosure" },
      h(
        "summary",
        {},
        `Knowledge used · ${info.sourceCount || state.documents.length} records`,
      ),
    );
    coverage.append(notesList(state.documents));
    content.append(coverage);
    draw();
    inspect();
  }
  function updateMapStatus(node, info) {
    const newerGraph =
      !!info?.graph &&
      JSON.stringify(info.graph) !== JSON.stringify(state.mindmap?.graph);
    const signature = JSON.stringify(
      info && {
        state: info.state,
        stale: info.stale,
        progress: info.progress,
        error: info.error,
        sourceCount: info.sourceCount,
        updatedAt: info.updatedAt,
        newerGraph,
      },
    );
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.replaceChildren();
    if (info?.state === "failed") {
      node.append(
        h("strong", {}, "Map update failed"),
        h("p", {}, "Your previous map remains available."),
        h("p", { class: "nx-small" }, info.error || "Try updating again."),
      );
      if (info.jobId)
        node.append(
          act("Retry map update", async () => {
            await api(endpoint(`/jobs/${info.jobId}/retry`), {
              method: "POST",
              body: {},
            });
            notify("Map update queued.");
          }),
        );
    } else if (newerGraph)
      node.append(
        h("strong", {}, "Updated map available"),
        h(
          "p",
          { class: "nx-small" },
          "Choose Show updates to open the new map. Your current map and selection are preserved.",
        ),
      );
    else if (!info || info.stale || ["pending", "running"].includes(info.state))
      node.append(
        h("strong", {}, "Updating from organization knowledge"),
        h(
          "span",
          { class: "nx-small" },
          info?.progress
            ? ` ${info.progress.nextBatch} of ${info.progress.totalBatches} batches processed`
            : " Changes are collected before generation starts.",
        ),
      );
    else
      node.append(
        h("strong", {}, "Map is current"),
        h(
          "span",
          { class: "nx-small" },
          ` · ${info.sourceCount} records · ${time(info.updatedAt)}`,
        ),
      );
  }
  function productRow(product) {
    const p = productPresentation(product);
    return h(
      "article",
      { class: "org-product-row" },
      h(
        "div",
        {},
        productLink(product),
        h(
          "p",
          { class: "nx-muted" },
          p.description ||
            "Open to explore its preview, feedback, and versions.",
        ),
      ),
      h(
        "div",
        { class: "nx-row" },
        p.previewUrl
          ? badge("Preview available", "success")
          : badge("No preview yet"),
        badge("Latest build: " + human(p.revision), tone(p.revision)),
      ),
      link("Open product", path("products", { product: product.id })),
    );
  }
  function products() {
    const product =
      productId && state.products?.find((p) => p.id === productId);
    if (productId && !product) {
      content.append(
        empty(
          "Product not found",
          "Choose a product belonging to this organization.",
        ),
        link("All products", path("products")),
      );
      return;
    }
    if (!product) {
      content.append(
        h(
          "div",
          { class: "nx-row org-section-head" },
          h("h2", {}, "Products"),
          org.kind !== "platform"
            ? button("Plan a product", () => productProposal(), {
                primary: true,
              })
            : null,
        ),
      );
      if (org.kind === "platform")
        content.append(
          h(
            "p",
            { class: "nx-muted" },
            "Select a customer organization to plan and build products.",
          ),
        );
      if (!state.products?.length)
        content.append(
          empty(
            "Bring your findings to life",
            "Plan a product, review its brief, and build a preview you can try.",
          ),
        );
      else
        content.append(
          h("div", { class: "nx-list" }, ...state.products.map(productRow)),
        );
      return;
    }
    context({ product });
    const p = productPresentation(product),
      selectedTab = ["preview", "feedback", "versions"].includes(q.get("tab"))
        ? q.get("tab")
        : "preview";
    content.append(
      link("All products", path("products")),
      h(
        "header",
        { class: "org-product-head" },
        h("h2", {}, p.title),
        p.description ? h("p", { class: "nx-muted" }, p.description) : null,
        h(
          "div",
          { class: "nx-actions" },
          button("Edit details", () => metadata(product)),
          button("Discuss this product", () =>
            explain(
              "Help me understand this product and discuss improvements before proposing changes.",
            ),
          ),
          button("Capture feedback", () => capture(null, product)),
          p.latest?.state === "completed"
            ? button("Build a revision", () => productProposal(product), {
                primary: true,
              })
            : buildLink(p.latest, "View current build"),
        ),
      ),
    );
    const buildStatus = h("div", {
      class: "nx-callout org-product-status",
      "data-product-status": product.id,
    });
    updateProductStatus(buildStatus, product);
    content.append(buildStatus);
    content.append(
      tabs(
        [
          { key: "preview", label: "Preview" },
          { key: "feedback", label: "Feedback" },
          { key: "versions", label: "Versions" },
        ],
        selectedTab,
        (key) => navigate(path("products", { product: product.id, tab: key })),
      ),
    );
    if (selectedTab === "preview") {
      if (p.previewUrl) {
        const previewVersion =
          (product.versions || []).findIndex(
            (build) => build.id === p.preview.id,
          ) + 1;
        content.append(
          h(
            "p",
            { class: "nx-small nx-muted" },
            `Showing completed version ${previewVersion || ""} · ${time(p.preview.created_at)}`,
          ),
        );
        content.append(
          h(
            "div",
            { class: "nx-actions org-preview-actions" },
            external("Open preview in a new tab", p.previewUrl),
            p.preview?.result?.codeUrl
              ? external("View source", p.preview.result.codeUrl)
              : null,
            buildLink(p.preview, "Preview build details"),
          ),
        );
        content.append(
          h("iframe", {
            src: p.previewUrl,
            title: p.title + " preview",
            class: "org-product-preview",
            sandbox: "allow-scripts allow-forms",
            loading: "lazy",
            referrerpolicy: "no-referrer",
          }),
        );
      } else
        content.append(
          empty(
            "No preview available yet",
            "Open build details to follow progress or investigate the latest attempt.",
          ),
          buildLink(p.latest),
        );
      content.append(
        h(
          "details",
          { class: "org-disclosure" },
          h("summary", {}, "Original product brief"),
          markdown(product.brief),
        ),
      );
    } else if (selectedTab === "feedback") {
      const docs = state.documents.filter(
        (d) => d.provenance?.productId === product.id,
      );
      content.append(
        h(
          "p",
          { class: "nx-muted" },
          "Feedback is shared with organization knowledge. Capturing it does not change the code; a build revision is reviewed separately.",
        ),
        docs.length
          ? notesList(docs)
          : empty(
              "No captured feedback yet",
              "Try the preview, then capture what should change or what you learned.",
            ),
      );
    } else {
      const list = h("div", { class: "nx-list" });
      for (const [index, build] of [...(product.versions || [])]
        .reverse()
        .entries()) {
        const version = product.versions.length - index;
        const preview = validPreviewUrl(build.result?.previewUrl);
        list.append(
          h(
            "article",
            { class: "org-version" },
            h(
              "div",
              { class: "nx-row" },
              h("h3", {}, `Version ${version}`),
              badge(human(build.state), tone(build.state)),
              build.id === p.preview?.id
                ? badge("Current preview", "success")
                : null,
            ),
            h("p", { class: "nx-muted nx-small" }, time(build.created_at)),
            build.error ? h("p", { class: "nx-error" }, build.error) : null,
            h(
              "div",
              { class: "nx-actions" },
              buildLink(build),
              preview ? external("Open this preview", preview) : null,
              external("Source", build.result?.codeUrl),
            ),
            h(
              "details",
              {},
              h("summary", {}, "Build brief"),
              markdown(build.brief),
            ),
            jsonDetails({
              id: build.id,
              parentId: build.parent_id,
              commit: build.result?.commitSha,
              runId: build.run_id,
            }),
          ),
        );
      }
      content.append(list);
    }
  }
  function updateProductStatus(node, product) {
    const p = productPresentation(product);
    const displayed = productPresentation(
      state.products?.find((item) => item.id === product.id) || product,
    );
    const newerPreview =
      !!p.previewUrl && p.preview?.id !== displayed.preview?.id;
    const signature = JSON.stringify({
      latest: p.latest?.id,
      state: p.revision,
      error: p.latest?.error,
      preview: p.preview?.id,
      newerPreview,
    });
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.replaceChildren(
      h(
        "strong",
        {},
        p.previewUrl ? "Preview available" : "No published preview yet",
      ),
      h("span", {}, " · Latest build: " + human(p.revision)),
    );
    if (p.hasPreviousPreview)
      node.append(
        h(
          "p",
          { class: "nx-small" },
          "You can keep using the previous completed preview while this revision is resolved.",
        ),
      );
    if (newerPreview)
      node.append(
        h(
          "p",
          { class: "nx-small" },
          "A newer preview is ready. Choose Show updates to open it; the preview you are using stays in place.",
        ),
      );
    if (p.latest?.error)
      node.append(
        h(
          "details",
          {},
          h("summary", {}, "Build issue"),
          h("p", { class: "nx-error" }, p.latest.error),
        ),
      );
    if (p.latest)
      node.append(
        buildLink(
          p.latest,
          ["pending", "running"].includes(p.revision)
            ? "Follow build progress"
            : "Latest build details",
        ),
      );
  }
  function engagementRow(e) {
    return h(
      "article",
      { class: "org-record-row" },
      h(
        "div",
        {},
        link(e.name, "/next/run?engagement=" + encodeURIComponent(e.id)),
        h(
          "p",
          { class: "nx-muted nx-small" },
          e.stages?.[e.stage_index]?.name ||
            (e.state === "completed"
              ? "All stages completed"
              : "Preparing engagement"),
        ),
      ),
      badge(human(e.state), tone(e.state)),
    );
  }
  function engagementView() {
    content.append(
      h(
        "div",
        { class: "nx-row org-section-head" },
        h("h2", {}, "Engagements"),
        link(
          "Start engagement",
          "/next/run?new=engagement&organization=" + orgId,
        ),
      ),
    );
    if (engagementsUnavailable)
      content.append(
        h("p", { class: "nx-error" }, "Engagements could not be loaded."),
        link("Open Run workspace", "/next/run"),
      );
    else
      content.append(
        engagements.length
          ? h("div", { class: "nx-list" }, ...engagements.map(engagementRow))
          : empty(
              "No engagements yet",
              "Start an engagement to move from understanding this customer through research, proposal, and product.",
            ),
      );
    if (state.runs.length)
      content.append(
        card(
          "Recent workflow runs",
          ...state.runs.map((r) =>
            h(
              "article",
              { class: "org-record-row" },
              h(
                "div",
                {},
                runLink(r),
                h("p", { class: "nx-muted nx-small" }, time(r.createdAt)),
              ),
              badge(human(r.status), tone(r.status)),
            ),
          ),
        ),
      );
  }
  function review(change) {
    const knowledge = change.kind === "knowledge",
      body = change.body || {},
      before = change.before?.content ?? "",
      affectedProduct = state.products?.find((p) => p.id === body.productId);
    const root = h("article", {
      class: "nx-card org-review",
      id: "change-" + change.id,
    });
    root.append(
      h(
        "div",
        { class: "nx-row" },
        badge(human(change.state), tone(change.state)),
        badge(human(change.kind)),
      ),
      h("h3", {}, change.title),
      h("p", {}, change.reason),
    );
    root.append(
      h(
        "p",
        { class: "nx-small nx-muted" },
        `${org.name}${affectedProduct ? " → " + affectedProduct.name : ""}${change.baseRevision !== undefined ? " · Based on version " + change.baseRevision : ""}`,
      ),
    );
    if (change.error) root.append(h("p", { class: "nx-error" }, change.error));
    if (knowledge) {
      const diff = knowledgeDiff(before, body.content),
        changes = h("div", { class: "org-diff" });
      if (diff.removed.length)
        changes.append(
          h(
            "section",
            { class: "org-diff-before" },
            h("h4", {}, "Replaced or removed"),
            ...diff.removed.map((line) => h("p", {}, line)),
          ),
        );
      if (diff.added.length)
        changes.append(
          h(
            "section",
            { class: "org-diff-after" },
            h("h4", {}, before ? "Added or updated" : "New knowledge"),
            ...diff.added.map((line) => h("p", {}, line)),
          ),
        );
      root.append(changes);
      if (!diff.added.length && !diff.removed.length)
        root.append(
          h(
            "p",
            { class: "nx-muted" },
            diff.changed
              ? "Line order, repeated text, or formatting changed. Review the complete proposed and previous content below."
              : "Content is unchanged. Review the title, classification, evidence, and product link below.",
          ),
        );
      root.append(
        h(
          "div",
          { class: "org-review-fields" },
          h("p", {}, "Title: " + (body.title || change.title)),
          h("p", {}, "Category: " + human(body.category)),
          h("p", {}, "Evidence: " + human(body.evidence)),
          h(
            "p",
            {},
            "Product: " + (affectedProduct?.name || "Organization only"),
          ),
        ),
      );
      if (diff.truncated)
        root.append(
          h(
            "p",
            { class: "nx-muted" },
            "Long changes are shortened here. Review the complete content below.",
          ),
        );
      root.append(
        h(
          "details",
          { class: "org-disclosure" },
          h("summary", {}, "Read complete proposed content"),
          markdown(body.content),
        ),
      );
      if (before)
        root.append(
          h(
            "details",
            { class: "org-disclosure" },
            h("summary", {}, "Read previous content"),
            markdown(before),
          ),
        );
    } else if (change.kind === "product")
      root.append(
        h(
          "h4",
          {},
          body.productId ? "Requested product revision" : "New product plan",
        ),
        markdown(body.brief),
        h(
          "p",
          { class: "nx-callout" },
          "Approval starts a coding build and publishes an isolated static preview.",
        ),
      );
    else root.append(output(body));
    if (["proposed", "failed"].includes(change.state)) {
      const confirm = h("input", { type: "checkbox" });
      if (knowledge)
        root.append(
          h(
            "label",
            { class: "org-checkbox" },
            confirm,
            "Mark this knowledge as customer-confirmed.",
          ),
        );
      const labels = {
        knowledge: "Apply knowledge change",
        product: "Approve and start build",
        workflow: "Apply workflow draft",
        skill: "Create skill version",
        run: "Approve and start run",
      };
      const actions = h("div", { class: "nx-actions" });
      const approve = act(
        labels[change.kind] || "Apply change",
        async () => {
          await api(endpoint(`/changes/${change.id}/approve`), {
            method: "POST",
            body: { confirmKnowledge: confirm.checked },
          });
          actions.replaceChildren(badge("Applying approved change", "neutral"));
          notify("Approval recorded. The change is being applied.");
        },
        { primary: true },
      );
      actions.append(approve);
      if (change.state === "proposed")
        actions.append(
          act("Reject proposal", async () => {
            await api(endpoint(`/changes/${change.id}/reject`), {
              method: "POST",
              body: {},
            });
            actions.replaceChildren(badge("Rejected"));
            notify("Proposal rejected.");
          }),
        );
      root.append(
        actions,
        h(
          "p",
          { class: "nx-small nx-muted" },
          knowledge
            ? "Approval updates organization knowledge and its repository. Previous run results stay unchanged."
            : change.kind === "workflow"
              ? "This creates a draft. Publication is a separate decision."
              : "Review the proposed effect before continuing.",
        ),
      );
    }
    if (change.state === "applied" && knowledge && change.targetId)
      root.append(
        link(
          "Open knowledge record",
          path("knowledge", { document: change.targetId }),
        ),
      );
    if (change.state === "applied" && change.kind === "product") {
      const productId =
        change.provenance?.productId ||
        change.body?.productId ||
        change.targetId;
      if (state.products?.some((p) => p.id === productId))
        root.append(
          link("Open product", path("products", { product: productId })),
        );
    }
    root.append(
      jsonDetails(
        {
          provenance: change.provenance,
          id: change.id,
          baseRevision: change.baseRevision,
        },
        "Change history details",
      ),
    );
    return root;
  }
  function changesView() {
    const selected = q.get("change");
    content.append(
      h("h2", {}, "Changes and history"),
      h(
        "p",
        { class: "nx-muted" },
        "Review what will change and where. Approval is separate from discussing or capturing feedback.",
      ),
    );
    const pending = state.changes.filter((c) =>
      ["proposed", "failed", "approved"].includes(c.state),
    );
    if (!pending.length)
      content.append(
        empty(
          "No changes waiting for review",
          "Capture a finding or ask the assistant to propose a correction.",
        ),
      );
    for (const c of pending) content.append(review(c));
    const history = h(
      "details",
      {
        class: "org-disclosure",
        open: !!selected && !pending.some((c) => c.id === selected),
      },
      h("summary", {}, "Previous changes"),
    );
    for (const c of state.changes.filter((c) => !pending.includes(c))) {
      const row = h(
        "details",
        { open: c.id === selected },
        h(
          "summary",
          {},
          `${c.title} · ${human(c.state)} · ${time(c.updatedAt)}`,
        ),
        review(c),
      );
      history.append(row);
    }
    content.append(history);
    if (selected)
      requestAnimationFrame(() =>
        content
          .querySelector("#change-" + CSS.escape(selected))
          ?.scrollIntoView({ block: "start" }),
      );
  }
  async function settings() {
    content.append(
      h("h2", {}, "Organization settings"),
      card(
        "Knowledge repository",
        h(
          "p",
          { class: "nx-muted" },
          "Knowledge and accepted corrections are versioned in Forgejo.",
        ),
        state.repositoryUrl
          ? external("Open repository", state.repositoryUrl)
          : null,
        badge(
          state.repositoryConfigured ? "Connected" : "Not configured",
          state.repositoryConfigured ? "success" : "warning",
        ),
        act("Sync external repository edits", async () => {
          await api(endpoint("/sync"), { method: "POST", body: {} });
          notify(
            "Repository synchronization started. Imported edits are marked unverified.",
          );
        }),
        h(
          "p",
          { class: "nx-small nx-muted" },
          "Sync imports supported knowledge files changed outside this app. Imported edits are unverified until reviewed.",
        ),
      ),
    );
    const commits = card(
      "Repository history",
      h("p", { class: "nx-muted" }, "Loading recent changes…"),
    );
    content.append(commits);
    try {
      const repo = await api(endpoint("/repository"));
      if (ctx.signal.aborted || !commits.isConnected) return;
      commits.replaceChildren(h("h2", {}, "Repository history"));
      if (!repo.exists)
        commits.append(
          h(
            "p",
            { class: "nx-muted" },
            "The repository will be created when knowledge is committed.",
          ),
        );
      for (const c of repo.commits || [])
        commits.append(
          h(
            "article",
            { class: "org-record-row" },
            h(
              "div",
              {},
              external(
                c.commit?.message || c.sha?.slice(0, 8) || "Commit",
                c.html_url || `${repo.url}/commit/${c.sha}`,
              ),
              h(
                "p",
                { class: "nx-small nx-muted" },
                time(c.commit?.author?.date),
              ),
            ),
            h("span", { class: "nx-small" }, c.commit?.author?.name || ""),
          ),
        );
    } catch (e) {
      if (!ctx.signal.aborted)
        commits.replaceChildren(
          h("h2", {}, "Repository history"),
          h("p", { class: "nx-error" }, e.message),
        );
    }
    const jobs = card("Background activity");
    for (const job of state.jobs
      .filter((j) => j.kind !== "assistant")
      .slice(0, 12))
      jobs.append(
        h(
          "div",
          { class: "org-record-row" },
          h(
            "div",
            {},
            human(job.kind),
            h("p", { class: "nx-small nx-muted" }, time(job.createdAt)),
            job.error ? h("p", { class: "nx-error" }, job.error) : null,
          ),
          badge(human(job.state), tone(job.state)),
          job.state === "failed"
            ? act("Retry", async () => {
                await api(endpoint(`/jobs/${job.id}/retry`), {
                  method: "POST",
                  body: {},
                });
                notify("Retry queued.");
              })
            : null,
        ),
      );
    content.append(jobs);
  }
  let embeddedCleanup = () => {};
  async function platformView() {
    const { renderProductPlatform } = await import("./product-platform.js");
    if (ctx.signal.aborted) return;
    await renderProductPlatform(content, {
      organization: org,
      url,
      ctx,
      onContext: (value) => {
        primary = value;
        setContext(value);
      },
    });
  }
  async function peopleView() {
    const { renderPeople } = await import("./people.js");
    if (ctx.signal.aborted) return;
    embeddedCleanup = await renderPeople(org, content);
  }
  ctx.onCleanup(() => embeddedCleanup?.());
  function render() {
    embeddedCleanup?.();
    embeddedCleanup = () => {};
    audioStop();
    content.replaceChildren();
    context();
    currentStatus.textContent = `${org.kind === "platform" ? "Platform workspace" : "Customer organization"} · ${state.documents.length} knowledge records`;
    ({
      overview,
      knowledge,
      products:
        productId && ["preview", "feedback", "versions"].includes(q.get("tab"))
          ? products
          : () => void platformView().catch((e) => notify(e.message, "error")),
      people: () => void peopleView().catch((e) => notify(e.message, "error")),
      campaigns: () =>
        void platformView().catch((e) => notify(e.message, "error")),
      usage: () => void platformView().catch((e) => notify(e.message, "error")),
      engagements: engagementView,
      changes: changesView,
      settings,
    })[view]();
  }
  render();
  if (
    ["people", "campaigns", "usage"].includes(view) ||
    (view === "products" &&
      !["preview", "feedback", "versions"].includes(q.get("tab")))
  )
    return;
  let pollFailed = false;
  poll(
    async () => {
      try {
        const [fresh, work] = await Promise.all([
          api(endpoint("/state")),
          ["overview", "engagements"].includes(view)
            ? api(
                "/engagements?organization=" + encodeURIComponent(orgId),
              ).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (ctx.signal.aborted) return;
        const filteredWork = work?.filter(
          (e) => (e.customer_organization_id || e.organization_id) === orgId,
        );
        if (filteredWork) {
          pendingEngagements = filteredWork;
          engagementsUnavailable = false;
        }
        const changed =
          organizationSnapshot(fresh) !== organizationSnapshot(state) ||
          (pendingEngagements &&
            JSON.stringify(pendingEngagements) !== JSON.stringify(engagements));
        const recovered = pollFailed;
        if (pollFailed) {
          pollFailed = false;
          updateBar.hidden = !changed;
        }
        if (!changed) {
          pendingState = null;
          updateBar.hidden = true;
          return;
        }
        const repeat =
          pendingState &&
          organizationSnapshot(fresh) === organizationSnapshot(pendingState);
        pendingState = fresh;
        const mapStatus = content.querySelector("[data-map-status]");
        if (mapStatus) updateMapStatus(mapStatus, fresh.mindmap);
        const productStatus = content.querySelector("[data-product-status]");
        if (productStatus) {
          const p = fresh.products?.find(
            (p) => p.id === productStatus.dataset.productStatus,
          );
          if (p) updateProductStatus(productStatus, p);
        }
        if (!repeat || updateBar.hidden || recovered)
          updateBar.replaceChildren(
            h("span", {}, "New information is available."),
            button("Show updates", () => {
              if (draftDirty) {
                notify("Finish or close your current form before refreshing.");
                return;
              }
              state = pendingState || state;
              engagements = pendingEngagements || engagements;
              pendingState = null;
              pendingEngagements = null;
              updateBar.hidden = true;
              render();
            }),
          );
        updateBar.hidden = false;
      } catch (e) {
        if (ctx.signal.aborted || pollFailed) return;
        pollFailed = true;
        updateBar.replaceChildren(
          h(
            "span",
            {},
            "Live updates are unavailable. Your current view is preserved.",
          ),
          act("Try again", reload),
        );
        updateBar.hidden = false;
      }
    },
    6000,
    ctx,
  );
}
