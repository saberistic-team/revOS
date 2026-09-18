import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// Exercise the browser module's pure route/context/review contracts without a server or data writes.
const source = readFileSync(
  resolve(__dirname, "../apps/api/src/next/organizations.js"),
  "utf8",
);
const sandbox: Record<string, any> = { URLSearchParams, URL };
vm.createContext(sandbox);
vm.runInContext(
  source
    .replace(/^import\s+[\s\S]*?from ['"]\.\/core\.js['"];\s*/, "")
    .replace(/^export /gm, "") +
    "\nthis.contract = { organizationRoute, organizationContext, productPresentation, validPreviewUrl, knowledgeDiff, organizationSnapshot };",
  sandbox,
);
const {
  organizationRoute,
  organizationContext,
  productPresentation,
  validPreviewUrl,
  knowledgeDiff,
  organizationSnapshot,
} = sandbox.contract;
const org = { id: "org-1", name: "Example customer" };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("document context never carries a previously selected product or build", () => {
  const context = organizationContext(org, {
    document: { id: "doc-1", title: "Market", revision: 4 },
    product: {
      id: "product-2",
      name: "Other product",
      latestBuild: { id: "build-3" },
    },
  });
  assert.equal(context.kind, "document");
  assert.equal(context.documentId, "doc-1");
  assert.equal(context.version, 4);
  assert.equal(context.productId, null);
  assert.equal(context.buildId, null);
  assert.match(context.label, /Market · v4/);
  const concept = organizationContext(org, {
    concept: { id: "concept-7", label: "Market drivers" },
  });
  assert.equal(concept.kind, "concept");
  assert.equal(concept.documentId, null);
  assert.equal(concept.productId, null);
});

test("organization URLs encode a single primary object and retain product tab", () => {
  const knowledge = new URL(
    organizationRoute(org.id, "knowledge", {
      document: "doc-1",
      product: "product-2",
      map: true,
    }),
    "http://localhost",
  );
  assert.equal(knowledge.searchParams.get("document"), "doc-1");
  assert.equal(knowledge.searchParams.has("product"), false);
  assert.equal(knowledge.searchParams.has("map"), false);
  const product = new URL(
    organizationRoute(org.id, "products", {
      document: "doc-1",
      product: "product-2",
      tab: "feedback",
    }),
    "http://localhost",
  );
  assert.equal(product.searchParams.has("document"), false);
  assert.equal(product.searchParams.get("tab"), "feedback");
  assert.equal(
    new URL(
      organizationRoute(org.id, "overview", { product: "product-2" }),
      "http://localhost",
    ).searchParams.has("product"),
    false,
  );
});

test("a failed revision keeps its completed parent preview available", () => {
  const previous = {
    id: "v1",
    state: "completed",
    result: { previewUrl: "http://localhost:3002/ab12-cd34/" },
  };
  const latest = {
    id: "v2",
    state: "failed",
    result: {},
    error: "Build failed",
  };
  const product = {
    name: "Lead board",
    description: "Qualify leads",
    latestBuild: latest,
    versions: [previous, latest],
  };
  const presentation = productPresentation(product);
  assert.equal(presentation.revision, "failed");
  assert.equal(presentation.preview.id, "v1");
  assert.equal(presentation.previewUrl, previous.result.previewUrl);
  assert.equal(presentation.hasPreviousPreview, true);
  assert.equal(presentation.title, "Lead board");
});

test("preview embeds reject arbitrary hosts, credentials, schemes, and paths", () => {
  for (const url of [
    "javascript:alert(1)",
    "https://example.com/ab12/",
    "http://localhost:3002.evil.test/ab12/",
    "http://localhost:3002/ab12/?token=secret",
    "http://user:password@localhost:3002/ab12/",
    "http://localhost:3002/../../",
    "http://localhost:3002/not-a-build/",
    undefined,
  ])
    assert.equal(validPreviewUrl(url), null, String(url));
  assert.equal(
    validPreviewUrl("http://localhost:3002/abcd-1234/"),
    "http://localhost:3002/abcd-1234/",
  );
});

test("review distinguishes unchanged facts from reordered content and bounds summaries", () => {
  assert.equal(knowledgeDiff("A\nB", "B\nA").changed, true);
  assert.deepEqual(plain(knowledgeDiff("A\nB", "B\nA").added), []);
  const changed = knowledgeDiff(
    "Confirmed fact\nOld assumption",
    "Confirmed fact\nNew evidence",
  );
  assert.deepEqual(plain(changed.removed), ["Old assumption"]);
  assert.deepEqual(plain(changed.added), ["New evidence"]);
  assert.equal(knowledgeDiff("same", "same").changed, false);
  const large = knowledgeDiff(
    "",
    Array.from({ length: 60 }, (_, i) => i + " " + "x".repeat(2200)).join("\n"),
  );
  assert.equal(large.added.length, 40);
  assert.ok(large.added.every((line: string) => line.length <= 2001));
  assert.equal(large.truncated, true);
});

test("assistant polling changes do not invalidate organization content", () => {
  const state = {
    documents: [{ id: "doc-1", revision: 1 }],
    products: [],
    changes: [],
    jobs: [{ id: "chat", kind: "assistant", state: "running" }],
    threads: [{ id: "t1" }],
  };
  const next = {
    ...state,
    jobs: [{ id: "chat", kind: "assistant", state: "completed" }],
    threads: [{ id: "t1" }, { id: "t2" }],
  };
  assert.equal(organizationSnapshot(state), organizationSnapshot(next));
  assert.notEqual(
    organizationSnapshot(state),
    organizationSnapshot({
      ...next,
      documents: [{ id: "doc-1", revision: 2 }],
    }),
  );
  assert.notEqual(
    organizationSnapshot(state),
    organizationSnapshot({
      ...next,
      jobs: [{ id: "import", kind: "import", state: "completed" }],
    }),
  );
});

function componentHarness() {
  const calls: { path: string; method: string }[] = [],
    ticks: (() => Promise<void>)[] = [];
  class Element {
    tagName: string;
    children: Element[] = [];
    parentNode: Element | null = null;
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    className = "";
    value = "";
    hidden = false;
    text = "";
    listeners: Record<string, Function[]> = {};
    disabled = false;
    classList = {
      add: (name: string) => {
        this.className += " " + name;
      },
      remove: (name: string) => {
        this.className = this.className.replace(name, "");
      },
    };
    constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }
    setAttribute(key: string, value: any) {
      this.attrs[key] = String(value);
      if (key.startsWith("data-"))
        this.dataset[
          key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        ] = String(value);
    }
    append(...items: any[]) {
      for (const item of items) {
        const node =
          item instanceof Element
            ? item
            : Object.assign(new Element("#text"), { text: String(item) });
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...items: any[]) {
      this.children.forEach((n) => {
        n.parentNode = null;
      });
      this.children = [];
      this.append(...items);
    }
    get textContent(): string {
      return this.text + this.children.map((n) => n.textContent).join("");
    }
    set textContent(value: string) {
      this.children = [];
      this.text = value;
    }
    set innerHTML(_value: string) {
      throw Error("Unsafe HTML rendering");
    }
    get isConnected(): boolean {
      return this === doc.body || !!this.parentNode?.isConnected;
    }
    all(): Element[] {
      return this.children.flatMap((n) => [n, ...n.all()]);
    }
    matches(selector: string): boolean {
      if (selector.startsWith("[")) return selector.slice(1, -1) in this.attrs;
      if (selector.startsWith("#")) return this.attrs.id === selector.slice(1);
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector: string) {
      return this.all().filter((n) =>
        selector.split(",").some((s) => n.matches(s.trim())),
      );
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
    addEventListener(name: string, fn: Function) {
      (this.listeners[name] ||= []).push(fn);
    }
    async click() {
      for (const fn of this.listeners.click || [])
        await fn({ preventDefault() {} });
    }
    focus() {}
    scrollIntoView() {}
    remove() {
      if (this.parentNode)
        this.parentNode.children = this.parentNode.children.filter(
          (n) => n !== this,
        );
      this.parentNode = null;
    }
    showModal() {}
    close() {}
    reportValidity() {
      return true;
    }
  }
  const doc = {
    body: new Element("body"),
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (value: string) =>
      Object.assign(new Element("#text"), { text: value }),
    querySelector: () => null,
    documentElement: { lang: "en-US" },
    activeElement: null,
  };
  const preview = {
    id: "b1",
    state: "completed",
    brief: "Product: Test",
    created_at: "2026-09-17",
    result: {
      previewUrl: "http://localhost:3002/abcd-1234/",
      codeUrl: "http://localhost:3001/revos/test",
    },
  };
  const fixture: any = {
    documents: [
      {
        id: "d1",
        title: "Market research",
        category: "research",
        evidence: "researched",
        revision: 3,
        updatedAt: "2026-09-17",
        content:
          "# Findings\n\n- A verified source\n- <script>bad()</script>\n\n| Name | Value |\n| --- | --- |\n| Test | 4 |",
        relatedIds: [],
        provenance: {},
      },
    ],
    products: [
      {
        id: "p1",
        name: "Lead board",
        description: "Qualify leads",
        brief: "Product: Test",
        metadataRevision: 0,
        latestBuild: preview,
        previewBuild: preview,
        versions: [preview],
      },
    ],
    changes: [
      {
        id: "c1",
        kind: "knowledge",
        state: "proposed",
        title: "Update market",
        reason: "Customer correction",
        body: {
          title: "Market research",
          content: "Updated fact",
          category: "research",
          evidence: "unverified",
        },
        before: { content: "Old fact" },
        baseRevision: 3,
      },
    ],
    mindmap: {
      state: "completed",
      updatedAt: "2026-09-17",
      sourceCount: 1,
      graph: {
        title: "Organization",
        summary: "Connected findings",
        nodes: [
          {
            id: "concept1",
            theme: "Market",
            label: "Demand",
            summary: "Market demand",
            evidence: "researched",
            sourceIds: ["d1"],
          },
        ],
        edges: [],
      },
    },
    jobs: [],
    runs: [],
    threads: [],
    skills: [],
    repositoryConfigured: true,
    repositoryUrl: "http://localhost:3001/revos/kb",
  };
  const box: any = {
    Node: Element,
    document: doc,
    location: { origin: "http://localhost:3004" },
    window: { addEventListener() {}, dispatchEvent() {}, confirm: () => true },
    URL,
    URLSearchParams,
    console,
    CustomEvent: class {},
    Event: class {},
    requestAnimationFrame: (fn: Function) => fn(),
    CSS: { escape: (s: string) => s },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
  };
  vm.createContext(box);
  const core = readFileSync(
    resolve(__dirname, "../apps/api/src/next/core.js"),
    "utf8",
  );
  vm.runInContext(core.replace(/^export /gm, ""), box);
  box.api = async (path: string, options: any = {}) => {
    calls.push({ path, method: options.method || "GET" });
    if (path === "/builder/catalog")
      return { organizations: [{ ...org, kind: "customer" }] };
    if (path.startsWith("/engagements")) return [];
    if (path.endsWith("/state")) return structuredClone(fixture);
    if (path.endsWith("/repository"))
      return { exists: true, commits: [], url: fixture.repositoryUrl };
    throw Error("Unexpected request: " + path);
  };
  box.poll = (fn: () => Promise<void>) => ticks.push(fn);
  vm.runInContext(
    source
      .replace(/^import\s+[\s\S]*?from ['"]\.\/core\.js['"];\s*/, "")
      .replace(/^export /gm, ""),
    box,
  );
  const root = new Element("main");
  doc.body.append(root);
  const cleanup: (() => void)[] = [];
  return {
    root,
    fixture,
    ticks,
    calls,
    box,
    async render(query: string) {
      await box.renderOrganizations({
        root,
        url: new URL("http://localhost:3004/next/organizations" + query),
        signal: { aborted: false },
        onCleanup: (fn: () => void) => cleanup.push(fn),
      });
    },
    context: () => vm.runInContext("getContext()", box),
  };
}

test("all organization views render with synthetic API data and no mutations", async () => {
  for (const query of [
    "",
    "?organization=org-1",
    "?organization=org-1&view=knowledge",
    "?organization=org-1&view=knowledge&document=d1&product=p1",
    "?organization=org-1&view=knowledge&map=1",
    "?organization=org-1&view=products",
    "?organization=org-1&view=products&product=p1",
    "?organization=org-1&view=products&product=p1&tab=feedback",
    "?organization=org-1&view=products&product=p1&tab=versions",
    "?organization=org-1&view=engagements",
    "?organization=org-1&view=changes",
    "?organization=org-1&view=settings",
  ]) {
    const app = componentHarness();
    await app.render(query);
    assert.ok(app.root.textContent.length > 20, query);
    assert.ok(
      app.calls.every((c) => c.method === "GET"),
      query,
    );
    assert.equal(
      app.root.querySelectorAll("script").length,
      0,
      "report text must never become HTML",
    );
    if (query.includes("document=d1")) {
      assert.equal(app.context().documentId, "d1");
      assert.equal(app.context().productId, null);
    }
  }
});

test("a live build update preserves the mounted product iframe until refresh is chosen", async () => {
  const app = componentHarness();
  await app.render("?organization=org-1&view=products&product=p1&tab=preview");
  const iframe = app.root.querySelector("iframe");
  assert.ok(iframe);
  app.fixture.products[0].latestBuild = {
    id: "b2",
    state: "failed",
    error: "Revision failed",
    result: {},
  };
  await app.ticks[0]();
  assert.equal(app.root.querySelector("iframe"), iframe);
  assert.match(app.root.textContent, /previous completed preview/);
  assert.match(app.root.textContent, /New information is available/);
  const status = app.root.querySelector("[data-product-status]");
  const issue = status?.querySelector("details");
  await app.ticks[0]();
  assert.equal(
    status?.querySelector("details"),
    issue,
    "unchanged status must preserve expanded issue details",
  );
});

test("opening a document correction retains its exact record version and excludes a stale product", async () => {
  const app = componentHarness();
  await app.render("?organization=org-1&view=knowledge&document=d1&product=p1");
  const correction = app.root
    .querySelectorAll("button")
    .find((b) => b.textContent === "Suggest a correction");
  assert.ok(correction);
  await correction.click();
  const dialog = app.box.document.body.querySelector("dialog");
  assert.ok(dialog);
  assert.match(dialog.textContent, /version 3/);
  assert.equal(app.context().kind, "document");
  assert.equal(app.context().documentId, "d1");
  assert.equal(app.context().productId, null);
  assert.ok(
    app.calls.every((c) => c.method === "GET"),
    "opening a form must not save a change",
  );
});
