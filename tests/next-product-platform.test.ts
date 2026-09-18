import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

class Element {
  children: any[] = [];
  tag: string;
  attrs: any;
  value: any = "";
  disabled = false;
  checked = false;
  isConnected = true;
  listeners: Record<string, Function> = {};
  constructor(tag: string, attrs: any = {}, ...children: any[]) {
    this.tag = tag;
    this.attrs = attrs;
    this.value = attrs?.value ?? "";
    this.checked = !!attrs?.checked;
    this.append(...children);
    if (tag === "select")
      this.value =
        this.children.find((n) => n.attrs?.selected)?.attrs.value ??
        this.children[0]?.attrs.value ??
        "";
  }
  append(...children: any[]) {
    this.children.push(
      ...children.flat(Infinity).filter((v) => v != null && v !== false),
    );
  }
  prepend(...children: any[]) {
    this.children.unshift(...children);
  }
  replaceChildren(...children: any[]) {
    this.children = [];
    this.append(...children);
  }
  addEventListener(name: string, fn: Function) {
    this.listeners[name] = fn;
  }
  querySelector(selector: string) {
    return all(this).find((n) => selector.split(",").includes(n.tag)) || null;
  }
  querySelectorAll(selector: string) {
    return all(this).filter((n) =>
      selector === "input:checked"
        ? n.tag === "input" && n.checked
        : selector === n.tag,
    );
  }
  reportValidity() {
    return true;
  }
  focus() {}
  remove() {
    this.isConnected = false;
  }
}
function fixture(extra: Record<string, any> = {}) {
  const org = { id: "org", name: "Customer" },
    product = {
      id: "product",
      name: "Lead portal",
      description: "Qualify leads",
      revision: 1,
      runtime_kind: "service",
      campaigns: [],
      releases: [
        {
          id: "build",
          state: "completed",
          brief: "First build",
          created_at: "2026-09-17T00:00:00Z",
          result: { previewUrl: "http://localhost:3002/preview/" },
        },
      ],
    };
  const routes: any = {
    "/organizations/org/platform/products": [product],
    "/organizations/org/platform/campaigns": [],
    "/organizations/org/platform/products/product": product,
    "/organizations/org/platform/participants": [],
    ...extra,
  };
  const contexts: any[] = [],
    tabCalls: any[] = [],
    requests: any[] = [];
  const sandbox: any = {
    URL,
    URLSearchParams,
    Intl,
    Date,
    location: {
      href: "http://localhost/next/organizations",
      origin: "http://localhost",
    },
    h: (...args: any[]) => new Element(args[0], args[1], ...args.slice(2)),
    api: async (path: string, options: any = {}) => {
      assert(path in routes, "Known request: " + path);
      requests.push({ path, ...options });
      return typeof routes[path] === "function"
        ? routes[path](options)
        : routes[path];
    },
    button: (label: string, onClick: any, attrs: any) =>
      new Element("button", { label, onClick, ...attrs }, label),
    link: (label: string, href: string) => new Element("a", { href }, label),
    badge: (label: string) => new Element("badge", {}, label),
    empty: (...texts: string[]) => new Element("empty", {}, ...texts),
    tabs: (items: any[], selected: string, onSelect: Function) => {
      tabCalls.push({ items, selected, onSelect });
      return new Element("tabs");
    },
    notify: (_text: string, type: string) => {
      if (type === "error") throw Error(_text);
    },
    navigate: () => {},
    setContext: (c: any) => contexts.push(c),
    time: (v: any) => String(v),
    schemaForm: () => {},
    guardUnsaved: () => {},
    jsonDetails: () => new Element("details"),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(
      resolve(__dirname, "../apps/api/src/next/product-platform.js"),
      "utf8",
    )
      .replace(/^import\s+[\s\S]*?from ["']\.\/core\.js["'];\s*/, "")
      .replace(/^export /gm, "") +
      "\nthis.contract={renderProductPlatform,platformRoute,formatCost,usageTotals};",
    sandbox,
  );
  const host = new Element("main");
  return {
    org,
    product,
    host,
    sandbox,
    contexts,
    tabCalls,
    requests,
    routes,
    contract: sandbox.contract,
  };
}
function control(host: Element, label: string) {
  const row = all(host).find(
    (n) => n.tag === "label" && text(n.children[0]) === label,
  );
  assert(row, "Field exists: " + label);
  return row.children[1] as Element;
}
async function click(host: Element, label: string) {
  const found = all(host).find(
    (n) => n.tag === "button" && n.attrs.label === label,
  );
  assert(found, "Button exists: " + label);
  await found.attrs.onClick();
}
async function submit(host: Element) {
  const form = all(host).find((n) => n.tag === "form" && n.isConnected);
  assert(form);
  await form.listeners.submit({ preventDefault() {} });
}
function all(node: any): any[] {
  return node instanceof Element ? [node, ...node.children.flatMap(all)] : [];
}
function text(node: any): string {
  return node instanceof Element
    ? node.children.map(text).join(" ")
    : String(node);
}

test("product overview keeps scoped assistant and legacy preview/feedback/history navigation", async () => {
  const f = fixture();
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?product=product&tab=overview",
    ),
  });
  assert.equal(f.contexts[0].productId, "product");
  assert.equal(f.contexts[0].buildId, "build");
  assert.equal(f.contexts[0].kind, "product");
  const hrefs = all(f.host)
    .filter((n) => n.tag === "a")
    .map((n) => n.attrs.href);
  for (const tab of ["preview", "feedback", "versions"])
    assert(hrefs.some((url) => url.includes("tab=" + tab)));
  assert(
    f.tabCalls[0].items.every((item: any) => item.key),
    "Tabs use the shared UI key contract",
  );
});
test("campaign context binds actual campaign product and revision", async () => {
  const campaign = {
    id: "campaign",
    product_id: "product",
    name: "Qualification",
    objective: "Qualify",
    state: "draft",
    revision: 3,
    stakeholder_ids: [],
    requirements: [],
  };
  const f = fixture({
    "/organizations/org/platform/campaigns/campaign": campaign,
  });
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?view=campaigns&campaign=campaign&product=wrong",
    ),
  });
  assert.equal(f.contexts[0].kind, "campaign");
  assert.equal(f.contexts[0].campaignId, "campaign");
  assert.equal(f.contexts[0].productId, "product");
  assert.equal(f.contexts[0].version, 3);
});
test("unpriced usage does not present an all-unknown total as free", async () => {
  const usage = {
    groups: [
      {
        provider: "openai:test",
        category: "llm_input",
        unit: "tokens",
        currency: "USD",
        cost_micros: "0",
        units: "1000",
        events: 1,
        unpriced_events: 1,
        estimated_events: 0,
      },
    ],
    budgets: [],
    events: [],
    rates: [],
  };
  const f = fixture({
    "/organizations/org/platform/usage?month=2026-09": usage,
    "/organizations/org/platform/usage/collection": {
      configuration: {},
      capabilities: {},
      storageSamples: [],
    },
  });
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?view=usage&month=2026-09",
    ),
  });
  assert.match(text(f.host), /Unpriced/);
  assert.doesNotMatch(text(f.host), /\$0/);
  assert.match(text(f.host), /No billing or charges/);
});
test("usage totals keep currencies separate", () => {
  const f = fixture();
  const totals = f.contract.usageTotals([
    {
      currency: "USD",
      cost_micros: "1000",
      events: 1,
      unpriced_events: 0,
      estimated_events: 1,
    },
    {
      currency: "EUR",
      cost_micros: "2000",
      events: 1,
      unpriced_events: 0,
      estimated_events: 0,
    },
  ]);
  assert.equal(totals.USD.costMicros, 1000);
  assert.equal(totals.EUR.costMicros, 2000);
  assert.equal(f.contract.formatCost(null), "Unpriced");
});
test("new product form submits a typed product without requiring JSON", async () => {
  const f = fixture();
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL("http://localhost/next/organizations?view=products"),
  });
  await click(f.host, "New product");
  control(f.host, "Name").value = "Portal";
  control(f.host, "Purpose").value = "Capture customer input";
  control(f.host, "Product type").value = "service";
  await submit(f.host);
  const posted = f.requests.find((r) => r.method === "POST");
  assert.equal(posted.path, "/organizations/org/platform/products");
  assert.equal(posted.body.name, "Portal");
  assert.equal(posted.body.runtimeKind, "service");
  assert.equal(posted.body.ownerPersonId, null);
});
test("campaign and requirement forms post their own scoped contracts", async () => {
  const f = fixture();
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL("http://localhost/next/organizations?view=campaigns"),
  });
  await click(f.host, "New campaign");
  control(f.host, "Name").value = "Launch";
  control(f.host, "Objective").value = "Validate the market";
  control(f.host, "Product").value = "product";
  await submit(f.host);
  let posted = f.requests.find((r) => r.method === "POST");
  assert.equal(posted.path, "/organizations/org/platform/campaigns");
  assert.equal(posted.body.productId, "product");
  assert.equal(posted.body.objective, "Validate the market");
  const campaign = {
    id: "campaign",
    product_id: "product",
    name: "Launch",
    objective: "Validate",
    state: "draft",
    revision: 1,
    stakeholder_ids: [],
    requirements: [],
  };
  const g = fixture({
    "/organizations/org/platform/campaigns/campaign": campaign,
    "/organizations/org/platform/campaigns/campaign/requirements": {
      id: "requirement",
    },
  });
  await g.contract.renderProductPlatform(g.host, {
    organization: g.org,
    url: new URL(
      "http://localhost/next/organizations?view=campaigns&campaign=campaign",
    ),
  });
  await click(g.host, "Propose requirement");
  control(g.host, "Title").value = "Save leads";
  control(g.host, "Requirement").value = "Persist data";
  control(g.host, "Acceptance criteria").value =
    "Lead survives restart\nInvalid email rejected";
  control(g.host, "Evidence").value = "https://example.test/customer-note";
  await submit(g.host);
  posted = g.requests.find((r) => r.method === "POST");
  assert.equal(
    posted.path,
    "/organizations/org/platform/campaigns/campaign/requirements",
  );
  assert.deepEqual(Array.from(posted.body.acceptanceCriteria), [
    "Lead survives restart",
    "Invalid email rejected",
  ]);
  assert.equal(posted.body.evidence[0].kind, "url");
});
test("workflow-chain start reads the schema form and invokes campaign start", async () => {
  const campaign = {
    id: "campaign",
    product_id: "product",
    name: "Launch",
    objective: "Validate",
    state: "draft",
    revision: 1,
    stakeholder_ids: [],
    requirements: [],
  };
  const f = fixture({
    "/organizations/org/platform/campaigns/campaign": campaign,
    "/engagement-templates": [
      { id: "chain", name: "Discovery", stages: [{ workflowId: "workflow" }] },
    ],
    "/workflows/workflow": {
      version: {
        inputSchema: {
          type: "object",
          properties: { company: { type: "string" } },
          required: ["company"],
        },
      },
    },
    "/organizations/org/platform/campaigns/campaign/start": {
      engagement_id: "engagement",
    },
  });
  f.sandbox.schemaForm = (schema: any) => {
    assert.equal(schema.required[0], "company");
    return {
      element: new Element("schema-fields"),
      read: () => ({ company: "Test customer" }),
    };
  };
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?view=campaigns&campaign=campaign",
    ),
  });
  await click(f.host, "Start workflow chain");
  const picker = control(f.host, "Workflow chain");
  picker.value = "chain";
  await picker.listeners.change();
  await submit(f.host);
  const posted = f.requests.find((r) => r.method === "POST");
  assert.equal(
    posted.path,
    "/organizations/org/platform/campaigns/campaign/start",
  );
  assert.equal(posted.body.templateId, "chain");
  assert.equal(posted.body.input.company, "Test customer");
});
test("deployment review supports a reasoned decline of the exact release", async () => {
  const f = fixture({
    "/products/product/service-delivery": {
      configuration: null,
      capabilities: {},
      releases: [
        {
          id: "release",
          environment: "preview",
          state: "awaiting_approval",
          source_commit: "a".repeat(40),
          image: "registry/app@sha256:123",
        },
      ],
    },
    "/service-delivery/releases/release/reject": { state: "failed" },
  });
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?product=product&tab=hosting",
    ),
  });
  await click(f.host, "Decline deployment");
  control(f.host, "Reason").value =
    "Tests do not cover the customer acceptance criteria";
  await submit(f.host);
  const posted = f.requests.find((r) => r.method === "POST");
  assert.equal(posted.path, "/service-delivery/releases/release/reject");
  assert.match(posted.body.reason, /acceptance criteria/);
  assert(!f.requests.some((r) => r.path.endsWith("/approve")));
});

test("hosting edits preserve runtime settings while allowing database and migration removal", async () => {
  const configuration = {
    previewHost: "preview.example.test",
    publicPort: 8443,
    ingressClass: "custom-ingress",
    tlsSecretName: "app-tls",
    imagePullSecret: "registry-access",
    cpu: "750m",
    memory: "2Gi",
    replicas: 3,
    database: { secret: "old-database", key: "DATABASE_URL" },
    migrationCommand: ["npm", "run", "migrate"],
  };
  const f = fixture({
    "/products/product/service-delivery": {
      configuration: { revision: 4, configuration },
      capabilities: {},
      releases: [],
    },
    "/products/product/service-database?environment=preview": {
      state: "not_provisioned",
    },
    "/products/product/service-database?environment=live": {
      state: "not_provisioned",
    },
  });
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?product=product&tab=hosting",
    ),
  });
  await click(f.host, "Configure");
  assert.equal(control(f.host, "Public port · optional").value, 8443);
  assert.equal(control(f.host, "Ingress class").value, "custom-ingress");
  control(f.host, "Public port · optional").value = "3006";
  control(f.host, "Ingress class").value = "revos-products";
  control(f.host, "Database secret name").value = "";
  control(f.host, "Migration command · one argument per line").value = "";
  await submit(f.host);
  const saved = f.requests.find((r) => r.method === "PUT");
  assert.equal(saved.path, "/products/product/service-delivery");
  assert.equal(saved.body.revision, 4);
  const value = saved.body.configuration;
  assert.equal(value.publicPort, 3006);
  assert.equal(value.ingressClass, "revos-products");
  assert.equal(value.tlsSecretName, "app-tls");
  assert.equal(value.imagePullSecret, "registry-access");
  assert.equal(value.cpu, "750m");
  assert.equal(value.memory, "2Gi");
  assert.equal(value.replicas, 3);
  assert(!("database" in value));
  assert(!("migrationCommand" in value));
});

test("new local hosting defaults its public port but supports standard HTTP ports", async () => {
  const f = fixture({
    "/products/product/service-delivery": {
      configuration: null,
      capabilities: {},
      releases: [],
    },
  });
  await f.contract.renderProductPlatform(f.host, {
    organization: f.org,
    url: new URL(
      "http://localhost/next/organizations?product=product&tab=hosting",
    ),
  });
  await click(f.host, "Configure");
  assert.equal(control(f.host, "Public port · optional").value, 3006);
  assert.equal(control(f.host, "Ingress class").value, "revos-products");
  control(f.host, "Preview hostname").value = "preview.example.test";
  control(f.host, "Public port · optional").value = "";
  await submit(f.host);
  const value = f.requests.find((r) => r.method === "PUT").body.configuration;
  assert(!("publicPort" in value));
  assert.equal(value.ingressClass, "revos-products");
});
