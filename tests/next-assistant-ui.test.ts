import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  resolve(__dirname, "../apps/api/src/next/assistant.js"),
  "utf8",
);
const core = readFileSync(
  resolve(__dirname, "../apps/api/src/next/core.js"),
  "utf8",
);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const targetA = {
  scope: "knowledge",
  organizationId: "org-a",
  kind: "document",
  id: "document-a",
  documentId: "document-a",
  productId: null,
  version: 3,
  label: "Customer A → Market · v3",
};
const targetB = {
  scope: "knowledge",
  organizationId: "org-a",
  kind: "product",
  id: "product-b",
  productId: "product-b",
  documentId: null,
  buildId: "build-b",
  label: "Customer A → Product B",
};
const targetKey = (c: any) =>
  [
    c.scope,
    c.organizationId,
    c.kind,
    c.id || c.productId || c.documentId || c.workflowId || c.runId || "",
    c.workflowStepId || "",
    c.version || c.draftRevision || "",
  ].join(":");

function harness() {
  class Events {
    listeners: Record<string, Function[]> = {};
    addEventListener(type: string, fn: Function) {
      (this.listeners[type] ||= []).push(fn);
    }
    dispatchEvent(event: any) {
      for (const fn of this.listeners[event.type] || []) fn(event);
      return true;
    }
  }
  class Element extends Events {
    tagName: string;
    children: Element[] = [];
    parentNode: Element | null = null;
    text = "";
    className = "";
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    value = "";
    disabled = false;
    hidden = false;
    checked = false;
    scrollHeight = 500;
    clientHeight = 400;
    scrollTop = 100;
    onclick?: Function;
    onchange?: Function;
    namespaceURI = "http://www.w3.org/2000/svg";
    classList = {
      add: (value: string) => {
        this.className += " " + value;
      },
      toggle: (value: string, yes: boolean) => {
        this.className =
          this.className.replace(value, "") + (yes ? " " + value : "");
      },
    };
    constructor(tag: string) {
      super();
      this.tagName = tag.toUpperCase();
    }
    setAttribute(key: string, value: any) {
      this.attrs[key] = String(value);
    }
    getAttribute(key: string) {
      return this.attrs[key];
    }
    append(...items: any[]) {
      for (const value of items) {
        const node =
          value instanceof Element
            ? value
            : Object.assign(new Element("#text"), { text: String(value) });
        node.remove();
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...items: any[]) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.text = "";
      this.append(...items);
    }
    remove() {
      if (this.parentNode)
        this.parentNode.children = this.parentNode.children.filter(
          (n) => n !== this,
        );
      this.parentNode = null;
    }
    get textContent(): string {
      return this.text + this.children.map((n) => n.textContent).join("");
    }
    set textContent(value: string) {
      this.replaceChildren();
      this.text = value;
    }
    set innerHTML(_value: string) {
      throw Error("Unsafe HTML injection");
    }
    all(): Element[] {
      return this.children.flatMap((n) => [n, ...n.all()]);
    }
    matches(selector: string) {
      if (selector.startsWith("#")) return this.attrs.id === selector.slice(1);
      if (selector.startsWith("."))
        return this.className.split(/\s+/).includes(selector.slice(1));
      const attr = selector.match(/^\[([^=]+)="([^"]*)"\]$/);
      return attr
        ? this.attrs[attr[1]] === attr[2]
        : this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector: string) {
      return this.all().filter((n) => n.matches(selector));
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
    focus() {}
    async click() {
      if (this.disabled) return;
      const event = { type: "click", preventDefault() {} };
      for (const fn of this.listeners.click || []) await fn(event);
      if (this.onclick) await this.onclick(event);
    }
  }
  const body = new Element("body");
  const ids = [
    "nx-assistant",
    "nx-assistant-toggle",
    "nx-workarea",
    "nx-notifications",
  ];
  for (const id of ids) {
    const n = new Element(id.endsWith("toggle") ? "button" : "div");
    n.setAttribute("id", id);
    body.append(n);
  }
  const root = body.querySelector("#nx-assistant")!;
  root.hidden = true;
  const document = {
    body,
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (value: string) =>
      Object.assign(new Element("#text"), { text: value }),
    querySelector: (selector: string) => body.querySelector(selector),
  };
  const window = new Events(),
    storage = new Map<string, string>(),
    ticks: Function[] = [],
    calls: any[] = [];
  const state: any = { threads: [], jobs: [], changes: [] },
    conversations = new Map<string, any>();
  let interception: ((path: string, options: any) => any) | null = null;
  const box: any = {
    document,
    window,
    Node: Element,
    location: { origin: "http://localhost:3004" },
    URL,
    URLSearchParams,
    console,
    Event: class {
      constructor(public type: string) {}
    },
    CustomEvent: class {
      type: string;
      detail: any;
      constructor(type: string, options: any) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) || null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    setInterval: (fn: Function) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval() {},
    setTimeout() {},
    navigator: { language: "en-US" },
  };
  vm.createContext(box);
  vm.runInContext(core.replace(/^export /gm, ""), box);
  box.api = async (path: string, options: any = {}) => {
    calls.push({ path, ...plain(options) });
    const intercepted = interception?.(path, options);
    if (intercepted !== undefined) return intercepted;
    if (path.includes("/assistant?")) return structuredClone(state);
    if (options.method === "POST" && path.endsWith("/threads"))
      return { id: "created-thread" };
    if (options.method === "POST" && path.endsWith("/messages"))
      return { accepted: true };
    const thread = path.match(/\/threads\/([^/]+)$/)?.[1];
    if (thread)
      return structuredClone(conversations.get(thread) || { messages: [] });
    throw Error("Unexpected mocked request: " + path);
  };
  vm.runInContext(
    source
      .replace(/^import\s+[\s\S]*?from ['"]\.\/core\.js['"];\s*/, "")
      .replace(/^export /gm, ""),
    box,
  );
  const controller = box.mountAssistant();
  const composer = root.querySelector("textarea")!,
    messages = root.querySelector(".nx-chat-scroll")!,
    history = root.querySelector("select")!;
  const button = (label: string) =>
    root.querySelectorAll("button").find((n) => n.textContent === label)!;
  return {
    box,
    root,
    body,
    composer,
    messages,
    history,
    calls,
    state,
    conversations,
    storage,
    button,
    intercept(fn: typeof interception) {
      interception = fn;
    },
    context(c: any) {
      box.setContext(c);
    },
    open() {
      controller.show(true);
    },
    type(value: string) {
      composer.value = value;
      composer.dispatchEvent({ type: "input" });
    },
    remember(c: any, thread: string) {
      storage.set("nx-thread:" + targetKey(c), thread);
    },
    async tick() {
      for (const fn of ticks) fn();
      await settle();
    },
    chooseThread(thread: string) {
      history.value = thread;
      history.onchange?.();
    },
  };
}

test("target switches preserve independent drafts and restore the conversation selector", async () => {
  const app = harness();
  app.state.threads = [
    { id: "t1", title: "Conversation", createdAt: "2026-09-17" },
  ];
  app.context(targetA);
  app.open();
  await settle();
  app.type("Unsent correction for document A");
  app.context(targetB);
  await settle();
  assert.equal(app.composer.value, "");
  app.type("Unsent product request B");
  app.context(targetA);
  await settle();
  assert.equal(app.composer.value, "Unsent correction for document A");
  assert.equal(
    app.history.querySelectorAll("option").length,
    2,
    "same organization thread inventory must reappear after target change",
  );
  app.context(targetB);
  await settle();
  assert.equal(app.composer.value, "Unsent product request B");
});

test("clicking Send posts trimmed text with the exact captured typed context", async () => {
  const app = harness();
  app.context(targetA);
  app.open();
  await settle();
  app.type("  Explain this finding  ");
  await app.button("Send").click();
  await settle();
  const sent = app.calls.find((c) => c.path.endsWith("/messages"));
  assert.ok(sent, "Send button must submit through the API");
  const { organizationId: _org, scope: _scope, ...selection } = targetA;
  assert.deepEqual(sent.body, {
    content: "Explain this finding",
    context: selection,
  });
  assert.equal(app.composer.value, "");
});

test("sending remains bound to its original target while a new thread is being created", async () => {
  const app = harness(),
    pending = deferred();
  app.context(targetA);
  app.open();
  await settle();
  app.type("Send for document A");
  app.intercept((path, options) =>
    options.method === "POST" && path.endsWith("/threads")
      ? pending.promise
      : undefined,
  );
  const sending = app.button("Send").click();
  await settle();
  app.context(targetB);
  app.type("Keep my product draft");
  pending.resolve({ id: "thread-a" });
  await sending;
  await settle();
  const sent = app.calls.find((c) => c.path.endsWith("/messages"));
  assert.ok(sent);
  assert.equal(sent.path, "/workspace/org-a/threads/thread-a/messages");
  assert.equal(sent.body.context.documentId, "document-a");
  assert.equal(sent.body.context.productId, null);
  assert.equal(app.composer.value, "Keep my product draft");
});

test("text typed while sending is not cleared when the pending request completes", async () => {
  const app = harness(),
    pending = deferred();
  app.remember(targetA, "t1");
  app.context(targetA);
  app.open();
  await settle();
  app.type("First question");
  app.intercept((path, options) =>
    options.method === "POST" && path.endsWith("/messages")
      ? pending.promise
      : undefined,
  );
  const sending = app.button("Send").click();
  await settle();
  app.type("My next question");
  pending.resolve({ accepted: true });
  await sending;
  await settle();
  assert.ok(
    app.calls.some((c) => c.path.endsWith("/messages")),
    "test must exercise an actual mocked send",
  );
  assert.equal(app.composer.value, "My next question");
  assert.equal(
    app.storage.get("nx-draft:" + targetKey(targetA)),
    "My next question",
  );
});

test("a running assistant job keeps Send disabled after a successful request", async () => {
  const app = harness();
  app.remember(targetA, "t1");
  app.context(targetA);
  app.open();
  await settle();
  app.type("First question");
  app.intercept((path, options) => {
    if (options.method === "POST" && path.endsWith("/messages")) {
      app.state.jobs = [
        { id: "j1", state: "running", payload: { threadId: "t1" } },
      ];
      return { accepted: true };
    }
    return undefined;
  });
  await app.button("Send").click();
  await settle();
  assert.equal(app.button("Send").disabled, true);
  const sent = app.calls.filter((c) => c.path.endsWith("/messages")).length;
  app.type("Second question");
  await app.button("Send").click();
  assert.equal(
    app.calls.filter((c) => c.path.endsWith("/messages")).length,
    sent,
  );
});

test("New chat can send immediately while a different conversation is running", async () => {
  const app = harness();
  app.remember(targetA, "t1");
  app.state.jobs = [
    { id: "j1", state: "running", payload: { threadId: "t1" } },
  ];
  app.context(targetA);
  app.open();
  await settle();
  assert.equal(app.button("Send").disabled, true);
  await app.button("New chat").click();
  assert.equal(
    app.button("Send").disabled,
    false,
    "new conversation must not inherit the previous job's disabled state",
  );
  app.type("Start a separate conversation");
  await app.button("Send").click();
  await settle();
  assert.ok(
    app.calls.some(
      (call) =>
        call.path === "/workspace/org-a/threads/created-thread/messages",
    ),
  );
});

test("history selection immediately uses the newly selected conversation's job state", async () => {
  const app = harness();
  app.remember(targetA, "t1");
  app.state.threads = [
    { id: "t1", title: "Working" },
    { id: "t2", title: "Ready" },
  ];
  app.state.jobs = [
    { id: "j1", state: "running", payload: { threadId: "t1" } },
  ];
  app.context(targetA);
  app.open();
  await settle();
  assert.equal(app.button("Send").disabled, true);
  app.chooseThread("t2");
  assert.equal(app.button("Send").disabled, false);
  app.chooseThread("t1");
  assert.equal(app.button("Send").disabled, true);
  await settle();
});

test("Sending status appears immediately and survives refresh while the request is pending", async () => {
  const app = harness(),
    pending = deferred();
  app.context(targetA);
  app.open();
  await settle();
  app.type("Explain this finding");
  app.intercept((path, options) =>
    options.method === "POST" && path.endsWith("/threads")
      ? pending.promise
      : undefined,
  );
  const request = app.button("Send").click();
  assert.match(app.root.textContent, /Sending…/);
  assert.equal(app.button("Send").getAttribute("aria-busy"), "true");
  await app.tick();
  assert.match(app.root.textContent, /Sending…/);
  pending.resolve({ id: "created-thread" });
  await request;
  await settle();
  assert.doesNotMatch(app.root.textContent, /Sending…/);
  assert.equal(app.button("Send").disabled, false);
});

test("reopening a running conversation does not briefly enable Send before refresh", async () => {
  const app = harness(),
    pending = deferred();
  app.remember(targetA, "t1");
  app.state.jobs = [
    { id: "j1", state: "running", payload: { threadId: "t1" } },
  ];
  app.context(targetA);
  app.open();
  await settle();
  app.intercept((path) =>
    path.includes("/assistant?") ? pending.promise : undefined,
  );
  app.open();
  assert.equal(app.button("Send").disabled, true);
  pending.resolve(structuredClone(app.state));
  await settle();
});

test("New chat fences an old pending conversation response", async () => {
  const app = harness(),
    pending = deferred();
  app.remember(targetA, "t1");
  app.intercept((path) =>
    path.endsWith("/threads/t1") ? pending.promise : undefined,
  );
  app.context(targetA);
  app.open();
  await settle();
  await app.button("New chat").click();
  pending.resolve({
    messages: [
      { id: "old", role: "assistant", content: "STALE HISTORY", metadata: {} },
    ],
  });
  await settle();
  assert.doesNotMatch(app.messages.textContent, /STALE HISTORY/);
  assert.equal(app.history.value, "");
  assert.equal(app.storage.get("nx-thread:" + targetKey(targetA)), "");
});

test("a response resolving after a target change cannot appear under the new target", async () => {
  const app = harness(),
    pending = deferred();
  app.remember(targetA, "t1");
  app.remember(targetB, "t2");
  app.intercept((path) =>
    path.endsWith("/threads/t1") ? pending.promise : undefined,
  );
  app.context(targetA);
  app.open();
  await settle();
  app.context(targetB);
  pending.resolve({
    messages: [
      {
        id: "old",
        role: "assistant",
        content: "OLD TARGET RESPONSE",
        metadata: {},
      },
    ],
  });
  await settle();
  assert.doesNotMatch(app.messages.textContent, /OLD TARGET RESPONSE/);
  app.conversations.set("t2", {
    messages: [
      {
        id: "new",
        role: "assistant",
        content: "New product response",
        metadata: {},
      },
    ],
  });
  await app.tick();
  assert.match(app.messages.textContent, /New product response/);
});

test("switching history clears the old conversation and fences late responses", async () => {
  const app = harness(),
    pending = deferred();
  app.remember(targetA, "t1");
  app.state.threads = [
    { id: "t1", title: "One" },
    { id: "t2", title: "Two" },
  ];
  app.conversations.set("t1", {
    messages: [
      {
        id: "old",
        role: "assistant",
        content: "OLD CONVERSATION",
        metadata: {},
      },
    ],
  });
  app.context(targetA);
  app.open();
  await settle();
  assert.match(app.messages.textContent, /OLD CONVERSATION/);
  app.intercept((path) =>
    path.endsWith("/threads/t1") ? pending.promise : undefined,
  );
  await app.tick();
  app.chooseThread("t2");
  assert.doesNotMatch(
    app.messages.textContent,
    /OLD CONVERSATION/,
    "previous history must disappear immediately",
  );
  pending.resolve({
    messages: [
      {
        id: "late",
        role: "assistant",
        content: "LATE OLD RESPONSE",
        metadata: {},
      },
    ],
  });
  await settle();
  assert.doesNotMatch(app.messages.textContent, /LATE OLD RESPONSE/);
  app.conversations.set("t2", {
    messages: [
      {
        id: "new",
        role: "assistant",
        content: "Current history",
        metadata: {},
      },
    ],
  });
  await app.tick();
  assert.match(app.messages.textContent, /Current history/);
});

test("proposal review includes full long text, detailed steps and every supplied changed field", () => {
  const app = harness(),
    long = "Evidence ".repeat(600) + "END OF COMPLETE CONTENT";
  const node = app.box.proposalSummary({
    before: { title: "Old title", content: "Before", definition: undefined },
    body: {
      title: "Changed title",
      content: long,
      agentId: "agent-2",
      relatedIds: ["reference-3"],
      steps: [
        {
          key: "research",
          name: "Research",
          configuration: { maxTurns: 80, allowedToolIds: ["tool-4"] },
        },
      ],
    },
  });
  assert.match(node.textContent, /END OF COMPLETE CONTENT/);
  assert.match(node.textContent, /Changed title/);
  assert.match(node.textContent, /agent-2/);
  assert.match(node.textContent, /reference-3/);
  assert.match(node.textContent, /maxTurns/);
  assert.match(node.textContent, /tool-4/);
});

test("public message and proposal text are rendered as text, never executable markup", async () => {
  const app = harness();
  app.remember(targetA, "t1");
  app.conversations.set("t1", {
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "<img src=x onerror=bad()><script>bad()</script>",
        metadata: { questions: ["<svg onload=bad()>"] },
      },
    ],
  });
  app.state.changes = [
    {
      id: "c1",
      state: "proposed",
      kind: "knowledge",
      title: "<iframe src=bad>",
      reason: "<script>bad()</script>",
      body: { content: "<img src=x onerror=bad()>" },
      provenance: { assistantThreadId: "t1" },
    },
  ];
  app.context(targetA);
  app.open();
  await settle();
  assert.match(app.messages.textContent, /<img src=x onerror=bad\(\)>/);
  for (const tag of ["img", "script", "iframe"])
    assert.equal(app.messages.querySelectorAll(tag).length, 0, tag);
  assert.equal(
    app.calls.some((c) => c.method === "POST"),
    false,
    "reading proposals must not approve them",
  );
});
