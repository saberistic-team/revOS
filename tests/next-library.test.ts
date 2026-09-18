import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class Element {
  children: any[] = [];
  parent: Element | null = null;
  handlers: Record<string, Function[]> = {};
  value: any = "";
  disabled = false;
  required = false;
  checked = false;
  className = "";
  _text = "";
  classList = {
    add: (...names: string[]) => {
      this.className += " " + names.join(" ");
    },
  };
  constructor(
    public tag: string,
    attrs: any = {},
  ) {
    Object.assign(this, attrs);
    this.className = attrs.class || "";
  }
  append(...children: any[]) {
    for (const child of children.flat(Infinity))
      if (child !== null && child !== undefined && child !== false) {
        this.children.push(child);
        if (child instanceof Element) child.parent = this;
      }
  }
  replaceChildren(...children: any[]) {
    this.children = [];
    this._text = "";
    this.append(...children);
  }
  set textContent(value: string) {
    this.children = [];
    this._text = value;
  }
  get textContent(): string {
    return (
      this._text +
      this.children
        .map((c) => (c instanceof Element ? c.textContent : String(c)))
        .join(" ")
    );
  }
  addEventListener(name: string, fn: Function) {
    (this.handlers[name] ||= []).push(fn);
  }
  async fire(name: string) {
    for (const fn of this.handlers[name] || []) await fn({ target: this });
  }
  querySelectorAll(selector: string): Element[] {
    const tags = selector.split(",");
    return this.children
      .filter((c) => c instanceof Element)
      .flatMap((c) => [
        ...(tags.includes(c.tag) ? [c] : []),
        ...c.querySelectorAll(selector),
      ]);
  }
  closest(selector: string): Element | null {
    return this.className.split(" ").includes(selector.slice(1))
      ? this
      : this.parent?.closest(selector) || null;
  }
  checkValidity() {
    return this.disabled || !this.required || !!this.value;
  }
  reportValidity() {
    return this.checkValidity();
  }
}
const h = (tag: string, attrs: any = {}, ...children: any[]) => {
  const el = new Element(tag, attrs);
  el.append(...children);
  return el;
};
let requests: any[] = [],
  contexts: any[] = [],
  notices: any[] = [],
  navigations: string[] = [],
  guard: () => boolean = () => false;
let mutate: (path: string, options: any) => any = () => {
  throw Error("Unexpected mutation");
};
let reads: Record<string, any>;
const definition = {
  name: "Discovery",
  description: "Learn about the customer",
  agentId: "agent",
  goal: "Find opportunities",
  instructions: "Use evidence",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  outputSchema: { type: "object" },
  steps: [
    {
      key: "research",
      name: "Research",
      type: "agent_loop",
      skillVersionId: null,
      configuration: {
        provider: "openai",
        model: "gpt-4.1",
        goal: "Find evidence",
        skillVersionIds: ["skill-v2"],
        inputFrom: "initial",
      },
    },
    {
      key: "report",
      name: "Report",
      type: "skill",
      skillVersionId: "skill-v2",
      configuration: {
        provider: "openai",
        model: "gpt-4.1",
        goal: "Write report",
        inputFrom: "previous",
      },
    },
  ],
};
const workflow = {
  id: "workflow",
  name: "Discovery",
  organizationId: "org",
  currentVersionId: "v1",
};
const draft = { revision: 3, publishedRevision: 1, definition };
const versions = [
  {
    id: "v1",
    workflowId: "workflow",
    version: 1,
    createdBy: "builder:agent:draft-1",
    createdAt: "2026-09-17T00:00:00Z",
  },
  {
    id: "v3",
    workflowId: "workflow",
    version: 3,
    createdBy: "builder:agent:draft-3",
    createdAt: "2026-09-17T00:00:00Z",
  },
];
const skill = {
  skillId: "skill",
  name: "Research skill",
  description: "Find evidence",
  organizationId: "org",
  executionType: "agent",
  instructions: "Research the customer",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  configuration: {
    allowedToolIds: ["tool"],
    allowedKnowledgeIds: ["reference"],
  },
};
const catalogue = {
  organizations: [
    { id: "org", name: "Platform", kind: "platform" },
    { id: "customer", name: "Customer", kind: "customer" },
  ],
  agents: [{ id: "agent", name: "Research agent", organizationId: "org" }],
  skills: [
    { ...skill, id: "skill-v1", version: 1 },
    { ...skill, id: "skill-v2", version: 2 },
  ],
  knowledge: [
    {
      id: "reference",
      organizationId: "org",
      name: "Methodology",
      type: "reference",
      content: "Use verified sources",
    },
  ],
  tools: [
    {
      id: "tool",
      name: "Web research",
      description: "Find public sources",
      handler: "web",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};
const core = {
  h,
  api: async (path: string, options: any = {}) => {
    requests.push({ path, ...options });
    if (options.method && options.method !== "GET")
      return mutate(path, options);
    if (!(path in reads)) throw Error("Unknown endpoint " + path);
    return structuredClone(reads[path]);
  },
  button: (label: string, fn: Function, attrs: any = {}) => {
    const el = h("button", attrs, label);
    el.addEventListener("click", async () => {
      if (el.disabled) return;
      try {
        await fn();
      } catch (e: any) {
        notices.push(e.message);
      }
    });
    return el;
  },
  link: (label: string, href: string) => h("a", { href }, label),
  badge: (label: string) => h("span", {}, label),
  tabs: (items: any[], selected: string, onSelect: Function) =>
    h(
      "nav",
      {},
      ...items.map((i) =>
        core.button(i.label, () => onSelect(i.key), {
          "aria-pressed": i.key === selected,
        }),
      ),
    ),
  empty: (title: string, description: string) =>
    h("section", {}, title, description),
  jsonDetails: (value: any, label: string) =>
    h("details", {}, label, JSON.stringify(value)),
  schemaForm: (_schema: any, initial: any) => {
    const element = h(
      "div",
      {},
      h("input", { required: true, value: initial?.name || "" }),
    );
    return {
      element,
      read: () => {
        const field = element.querySelectorAll("input")[0];
        if (!field.checkValidity()) throw Error("Name required");
        return { name: field.value };
      },
    };
  },
  output: (value: any) => h("div", {}, JSON.stringify(value)),
  notify: (value: string) => notices.push(value),
  navigate: (url: string) => navigations.push(url),
  setContext: (value: any) => contexts.push(value),
  time: (value: string) => value,
  guardUnsaved: (fn: () => boolean) => (guard = fn),
};
(globalThis as any).__nextLibraryCore = core;
(globalThis as any).location = { origin: "http://localhost:3004" };
(globalThis as any).history = { state: {}, replaceState: () => {} };
(globalThis as any).window = { confirm: () => true };
let library: any;
before(async () => {
  const source = (
    await readFile("apps/api/src/next/library.js", "utf8")
  ).replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]\.\/core\.js['"];?/,
    "const {$1} = globalThis.__nextLibraryCore;",
  );
  library = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
});
function setup() {
  requests = [];
  contexts = [];
  notices = [];
  navigations = [];
  guard = () => false;
  reads = {
    "/builder/catalog": catalogue,
    "/builder/workflows": [{ workflow, draft }],
    "/engagement-templates": [
      {
        id: "chain",
        organization_id: "org",
        name: "Journey",
        revision: 5,
        stages: [
          { name: "Understand", workflowId: "workflow" },
          { name: "Research", workflowId: "workflow" },
        ],
      },
    ],
    "/builder/workflows/workflow": { workflow, draft, versions },
    "/workflows/workflow/runs": [{ id: "completed", status: "completed" }],
    "/runs/completed": {
      id: "completed",
      status: "completed",
      workflowVersionId: "v3",
    },
    "/builder/workflows/workflow/versions/v1": {
      version: {
        ...versions[0],
        goal: definition.goal,
        sopMarkdown: definition.instructions,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
      },
      steps: definition.steps,
    },
  };
  mutate = () => {
    throw Error("Unexpected mutation");
  };
}
async function render(query: string) {
  const root = h("main");
  await library.renderLibrary({
    root,
    url: "http://localhost:3004/next/library?" + query,
    signal: new AbortController().signal,
    onCleanup: () => {},
  });
  return root;
}
const buttonNamed = (root: Element, label: string) => {
  const found = root
    .querySelectorAll("button")
    .find((b) => b.textContent === label);
  assert.ok(found, "button " + label + " exists");
  return found;
};
const inputNamed = (root: Element, label: string) => {
  const found = root
    .querySelectorAll("input,textarea")
    .find(
      (n) =>
        n.parent?.tag === "label" && n.parent.children[0].textContent === label,
    );
  assert.ok(found, "input " + label + " exists");
  return found;
};

test("groups skill versions without merging skill identities", () => {
  const result = library.groupedSkills([
    ...catalogue.skills,
    { ...skill, id: "other-v1", skillId: "other", version: 1 },
    {
      ...skill,
      id: "code",
      skillId: "code",
      executionType: "code",
      version: 1,
    },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result[0].map((v: any) => v.version),
    [2, 1],
  );
});
test("editing a schema field preserves nested constraints and required names", () => {
  const input = {
    type: "object",
    properties: {
      old: {
        type: "array",
        items: { type: "string", format: "email" },
        minItems: 1,
      },
    },
    required: ["old"],
    additionalProperties: false,
  };
  const changed = library.updateSchemaField(
    input,
    "old",
    "contacts",
    { description: "People" },
    true,
  );
  assert.deepEqual(changed.properties.contacts.items, {
    type: "string",
    format: "email",
  });
  assert.equal(changed.properties.contacts.minItems, 1);
  assert.deepEqual(changed.required, ["contacts"]);
  assert.equal(changed.additionalProperties, false);
  assert.ok(input.properties.old);
  assert.throws(
    () =>
      library.updateSchemaField(
        { properties: { a: {}, b: {} } },
        "a",
        "b",
        {},
        false,
      ),
    /unique/,
  );
});
test("workflow comparison includes changed steps, additions, removals and order", () => {
  const updated = structuredClone(definition);
  updated.steps[0].name = "Research sources";
  assert.ok(
    library
      .summarizeWorkflowChanges(definition, updated)
      .includes("Updated step: Research sources"),
  );
  updated.steps.reverse();
  assert.ok(
    library
      .summarizeWorkflowChanges(definition, updated)
      .includes("Step order changed"),
  );
});
test("only completed tests of the exact workflow, agent and saved revision can be promoted", () => {
  const runs = [
    { id: "valid", status: "completed", workflowVersionId: "v3" },
    { id: "old", status: "completed", workflowVersionId: "v1" },
    { id: "failed", status: "failed", workflowVersionId: "v3" },
  ];
  assert.deepEqual(
    library
      .exactTestRuns(versions, runs, "workflow", "agent", 3)
      .map((r: any) => r.id),
    ["valid"],
  );
  assert.deepEqual(
    library.exactTestRuns(versions, runs, "workflow", "agent", 4),
    [],
  );
  assert.deepEqual(
    library.exactTestRuns(versions, runs, "other", "agent", 3),
    [],
  );
});
test("skill index is read-only and presents one item for all versions", async () => {
  setup();
  const root = await render("tab=skills&organization=org");
  assert.equal(
    root.querySelectorAll("a").filter((a) => a.textContent === "Research skill")
      .length,
    1,
  );
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => !r.method));
});
test("workflow step selection carries exact assistant context and protects unsaved edits", async () => {
  setup();
  const root = await render(
    "tab=workflows&item=workflow&organization=org&view=steps&step=report",
  );
  assert.equal(contexts.at(-1).workflowStepId, "report");
  assert.equal(contexts.at(-1).draftRevision, 3);
  assert.equal(contexts.at(-1).label, "Discovery → Report → Draft revision 3");
  assert.equal(
    inputNamed(root, "What should this step accomplish?").value,
    "Write report",
  );
  const field = inputNamed(root, "Step name");
  field.value = "Better report";
  await field.fire("input");
  assert.equal(guard(), true);
  assert.equal(contexts.at(-1).unsaved, true);
  assert.equal(
    contexts.at(-1).label,
    "Discovery → Better report → Draft revision 3",
  );
  await buttonNamed(root, "Purpose").fire("click");
  assert.equal(guard(), true);
  await buttonNamed(root, "Steps").fire("click");
  assert.equal(inputNamed(root, "Step name").value, "Better report");
});
test("publication requires an explicit review and submits the matching test and revision", async () => {
  setup();
  mutate = (path, options) => {
    if (path.endsWith("/validate")) return { valid: true };
    if (path.endsWith("/publish")) return { version: 3 };
    throw Error("Unexpected mutation " + path);
  };
  const root = await render(
    "tab=workflows&item=workflow&organization=org&view=tests",
  );
  assert.ok(
    !root
      .querySelectorAll("button")
      .some((b) => b.textContent === "Publish tested version"),
  );
  await buttonNamed(root, "Review publication").fire("click");
  assert.deepEqual(notices, []);
  assert.ok(!requests.some((r) => r.path.endsWith("/publish")));
  await buttonNamed(root, "Publish tested version").fire("click");
  assert.deepEqual(requests.find((r) => r.path.endsWith("/publish")).body, {
    revision: 3,
    testedRunId: "completed",
  });
});
test("invalid test input cannot dispatch a run", async () => {
  setup();
  const root = await render(
    "tab=workflows&item=workflow&organization=org&view=tests",
  );
  await buttonNamed(root, "Start test").fire("click");
  assert.ok(notices.includes("Name required"));
  assert.ok(!requests.some((r) => r.path.endsWith("/test")));
});
test("publication refuses a revision that changed during review", async () => {
  setup();
  mutate = (path) => {
    if (path.endsWith("/validate")) {
      reads["/builder/workflows/workflow"] = {
        workflow,
        draft: { ...draft, revision: 4 },
        versions,
      };
      return { valid: true };
    }
    throw Error("Unexpected mutation " + path);
  };
  const root = await render(
    "tab=workflows&item=workflow&organization=org&view=tests",
  );
  await buttonNamed(root, "Review publication").fire("click");
  assert.ok(
    notices.some((n) => n.includes("changed while preparing publication")),
  );
  assert.ok(
    !root
      .querySelectorAll("button")
      .some(
        (b) =>
          b.textContent.startsWith("Publish tested") ||
          b.textContent.startsWith("Publish without"),
      ),
  );
  assert.ok(!requests.some((r) => r.path.endsWith("/publish")));
});
test("chain editing is scoped to its selected organization and saves ordered stages with revision", async () => {
  setup();
  mutate = (_path, options) => ({ id: "chain", ...options.body });
  const root = await render("tab=chains&item=chain&organization=org");
  assert.equal(contexts.at(-1).chainId, "chain");
  assert.equal(contexts.at(-1).organizationId, "org");
  await root
    .querySelectorAll("button")
    .filter((b) => b.textContent === "Move down")[0]
    .fire("click");
  assert.equal(guard(), true);
  await buttonNamed(root, "Save chain").fire("click");
  const saved = requests.find(
    (r) => r.path === "/engagement-templates" && r.method === "POST",
  ).body;
  assert.equal(saved.revision, 5);
  assert.equal(saved.stages[0].name, "Research");
  assert.equal(saved.organizationId, "org");
});
test("a failed save retains edits and the original optimistic revision", async () => {
  setup();
  mutate = () => {
    throw Error("Draft changed in another editor. Reload before saving.");
  };
  const root = await render("tab=workflows&item=workflow&organization=org");
  const field = inputNamed(root, "Goal");
  field.value = "New goal";
  await field.fire("input");
  await buttonNamed(root, "Save draft").fire("click");
  assert.equal(guard(), true);
  assert.equal(inputNamed(root, "Goal").value, "New goal");
  assert.equal(requests.find((r) => r.method === "PUT").body.revision, 3);
  assert.ok(notices.some((n) => n.includes("another editor")));
});
