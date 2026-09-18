import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  [key: string]: any;
  constructor(tag: string, attrs: Record<string, any> = {}) {
    this.tagName = tag;
    this.attributes = {} as Record<string, any>;
    this.children = [] as any[];
    this.parentElement = null as Element | null;
    this.dataset = {} as Record<string, any>;
    this.listeners = {} as Record<string, Function[]>;
    this._text = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this._scrollTop = 0;
    this.classList = { add: () => {} };
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") this.className = v;
      else if (k === "value") this.value = v;
      else if (
        k === "disabled" ||
        k === "hidden" ||
        k === "open" ||
        k === "required"
      )
        this[k] = v;
      else this.attributes[k] = v;
    }
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children.forEach((c: any) => {
      if (c instanceof Element) c.parentElement = null;
    });
    this.children = [] as any[];
  }
  get textContent(): string {
    return (
      this._text +
      this.children
        .map((c: any) => (c instanceof Element ? c.textContent : String(c)))
        .join("")
    );
  }
  append(...nodes: any[]) {
    for (let n of nodes) {
      if (n instanceof Element) {
        n.remove();
        n.parentElement = this;
      }
      this.children.push(n);
    }
    if (this.tagName === "select" && !this.value)
      this.value =
        this.children.find(
          (c: any) => c instanceof Element && c.tagName === "option",
        )?.value || "";
  }
  replaceChildren(...n: any[]) {
    this.children.forEach((c: any) => {
      if (c instanceof Element) c.parentElement = null;
    });
    this.children = [] as any[];
    this._text = "";
    this.append(...n);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (c: any) => c !== this,
      );
      this.parentElement = null as Element | null;
    }
  }
  replaceWith(n: Element) {
    if (!this.parentElement) return;
    const p = this.parentElement,
      i = p.children.indexOf(this);
    this.parentElement = null as Element | null;
    n.parentElement = p;
    p.children[i] = n;
  }
  insertBefore(n: Element, b: Element | null) {
    n.remove();
    n.parentElement = this;
    const i = this.children.indexOf(b);
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
  }
  addEventListener(e: string, fn: Function) {
    (this.listeners[e] ??= []).push(fn);
  }
  async emit(e: string, target: Element = this) {
    for (const fn of this.listeners[e] || [])
      await fn({ target, preventDefault() {} });
    if (["input", "change", "click"].includes(e) && this.parentElement)
      await this.parentElement.emit(e, target);
  }
  closest(tag: string): Element | null {
    return this.tagName === tag
      ? this
      : this.parentElement?.closest(tag) || null;
  }
  click() {
    return this.emit("click");
  }
  reportValidity() {
    return true;
  }
  get clientHeight() {
    return 200;
  }
  get scrollHeight() {
    return this.children.length * 100;
  }
  get scrollTop() {
    return this._scrollTop;
  }
  set scrollTop(v: number) {
    this._scrollTop = Math.max(
      0,
      Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight)),
    );
  }
  get offsetTop() {
    return this.parentElement
      ? this.parentElement.children.indexOf(this) * 100
      : 0;
  }
  get offsetHeight() {
    return 100;
  }
}
function all(root: Element): Element[] {
  return [
    root,
    ...root.children.filter((x: any) => x instanceof Element).flatMap(all),
  ];
}
function find(root: Element, p: (element: Element) => boolean) {
  return all(root).find(p);
}
function environment(overrides: Record<string, any> = {}) {
  const posts: any[] = [],
    polls: Function[] = [],
    contexts: any[] = [],
    nav: string[] = [],
    guards: (() => boolean)[] = [],
    navigationDirty: boolean[] = [],
    saved = new Map<string, string>();
  let uuid = 0;
  const definition: any = {
    id: "w",
    name: "Research",
    organizationId: "owner",
    currentVersionId: "v1",
    version: {
      version: 1,
      inputSchema: {
        type: "object",
        properties: { company: { type: "string" } },
      },
    },
  };
  const run: any = {
    id: "r",
    status: "waiting",
    input: {},
    workflowVersionId: "v1",
    temporalWorkflowId: "run:r",
    customerOrganizationId: "customer",
    executionDefinition: {
      workflow: { id: "w" },
      customer: { name: "Acme" },
      steps: [{ id: "s", key: "research", name: "Research result" }],
    },
    steps: [
      {
        key: "research",
        status: "waiting",
        input: { report: "original" },
        output: null,
      },
    ],
  };
  const session: any = {
    id: "session",
    workflowStepId: "s",
    status: "waiting",
    reviewId: "session:0",
    snapshot: { catalog: [], definition: { tools: [], knowledge: [] } },
    turns: [
      {
        turn: 0,
        decision: {
          action: "request_review",
          target: null,
          summary: "Review the prototype",
          payload: '{"report":"Review material"}',
        },
        outcome: null,
      },
    ],
  };
  const engagement: any = {
    id: "e",
    name: "Acme discovery",
    organization_id: "owner",
    customer_organization_id: "customer",
    state: "running",
    stage_index: 0,
    stages: [
      { name: "Research", workflowId: "w" },
      { name: "Proposal", workflowId: "p" },
    ],
    attempts: [
      {
        id: "a",
        run_id: "r",
        stage_index: 0,
        revision: 1,
        state: "running",
        run_status: "waiting",
        output: null,
      },
    ],
  };
  const build: any = {
    id: "b",
    organization_id: "customer",
    run_id: "r",
    parent_id: null,
    state: "running",
    created_at: "2026-09-17T12:00:00Z",
    updated_at: "2026-09-17T12:03:00Z",
    progress: {
      phase: "building",
      lastEventAt: "2026-09-17T12:03:00Z",
      message: "Editing the prototype",
      events: [],
      files: [],
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Public update",
          at: "2026-09-17T12:03:00Z",
        },
        { id: "m2", role: "reasoning", text: "Hidden thought" },
      ],
    },
  };
  const fixtures: Record<string, any> = {
    "/engagements/e": engagement,
    "/engagements": [engagement],
    "/customers": [{ id: "customer", name: "Acme" }],
    "/workflows": [definition],
    "/workflows/w": definition,
    "/workflows/w/runs": [
      { id: "r", status: "waiting", createdAt: "2026-09-17T12:00:00Z" },
    ],
    "/runs/r": run,
    "/runs/r/sessions": [session],
    "/sessions/session": session,
    "/runs/r/outputs": { sources: [], jobs: [] },
    "/runs/r/builds": [],
    "/runs/r/question": { question: null },
    "/runs/r/feedback": [],
    "/builds/b": build,
    ...overrides,
  };
  const helpers: any = {
    h: (tag: string, attrs: Record<string, any> = {}, ...kids: any[]) => {
      const e = new Element(tag, attrs);
      e.append(
        ...kids
          .flat(Infinity)
          .filter((x: any) => x !== null && x !== undefined && x !== false),
      );
      return e;
    },
    api: async (path: string, opts: any = {}) => {
      if (opts.method === "POST") {
        posts.push({ path, body: opts.body });
        if (fixtures.onPost) return fixtures.onPost(path, opts.body);
        return { id: "new-run", state: "pending", attempt: 1 };
      }
      if (!(path in fixtures)) throw Error("Unexpected endpoint " + path);
      return structuredClone(fixtures[path]);
    },
    button: (label: string, fn: Function, attrs: any = {}) => {
      const e = new Element("button", attrs);
      e.append(label);
      e.addEventListener("click", async () => {
        if (e.disabled) return;
        await fn();
      });
      return e;
    },
    link: (label: string, url: string, attrs: any = {}) => {
      const e = new Element("a", { href: url, ...attrs });
      e.append(label);
      return e;
    },
    badge: (value: any) => {
      const e = new Element("span");
      e.append(value);
      return e;
    },
    tabs: (items: any[], selected: any, fn: Function) => {
      const e = new Element("nav");
      for (const item of items)
        e.append(helpers.button(item.label, () => fn(item.key)));
      return e;
    },
    empty: (title: string, description: string) =>
      helpers.h("div", {}, title, description),
    jsonDetails: (value: any, label: string) =>
      helpers.h(
        "details",
        {},
        helpers.h("summary", {}, label),
        helpers.h("pre", {}, JSON.stringify(value)),
      ),
    schemaForm: () => ({
      element: helpers.h("div", {}, "schema form"),
      read: () =>
        fixtures.readSchema ? fixtures.readSchema() : { company: "Acme" },
    }),
    output: (v: any) => helpers.h("div", {}, JSON.stringify(v)),
    notify: () => {},
    navigate: (url: string) => {
      navigationDirty.push(guards.some((fn) => fn()));
      nav.push(url);
    },
    guardUnsaved: (check: () => boolean) => guards.push(check),
    setContext: (c: any) => contexts.push(c),
    poll: (fn: Function) => polls.push(fn),
    time: (v: any) => String(v || ""),
    safeUrl: (v: any) =>
      typeof v === "string" && v ? new URL(v, "http://local").href : null,
  };
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    structuredClone,
    Date,
    Map,
    Set,
    JSON,
    Number,
    String,
    Math,
    crypto: { randomUUID: () => `uuid-${++uuid}` },
    sessionStorage: {
      getItem: (k: string) => saved.get(k),
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    },
    location: { href: "http://local/next/run", origin: "http://local" },
    history: { state: {}, replaceState() {} },
    __helpers: helpers,
  });
  let code = fs
    .readFileSync("apps/api/src/next/run.js", "utf8")
    .replace(
      /^import[\s\S]*?from "\.\/core\.js";\n/,
      "const {h,api,button,link,badge,tabs,empty,jsonDetails,schemaForm,output,notify,navigate,setContext,poll,time,safeUrl,guardUnsaved}=__helpers;\n",
    )
    .replaceAll("export async function", "async function")
    .replaceAll("export function", "function");
  code += "\nglobalThis.subject={renderRun,selectedAttempt,runUrl};";
  vm.runInContext(code, context);
  const render = async (path: string) => {
    const ctx = {
      root: new Element("main"),
      url: new URL("http://local" + path),
      signal: { aborted: false },
      onCleanup() {},
    };
    await context.subject.renderRun(ctx);
    return ctx;
  };
  return {
    render,
    posts,
    polls,
    contexts,
    nav,
    guards,
    navigationDirty,
    fixtures,
    run,
    session,
    engagement,
    build,
    saved,
    subject: context.subject,
  };
}

const byButton = (root: Element, label: string) => {
  const element = find(
    root,
    (e) => e.tagName === "button" && e.textContent === label,
  );
  assert(element, `Missing button: ${label}`);
  return element;
};
const byLabel = (root: Element, label: string) => {
  const element = find(root, (e) => e.attributes["aria-label"] === label);
  assert(element, `Missing input: ${label}`);
  return element;
};
const plain = (value: any) => JSON.parse(JSON.stringify(value));

test("Run keeps review drafts under polling and submits the exact review and step IDs", async () => {
  const env = environment();
  const ctx = await env.render("/next/run?engagement=e&run=r");
  assert.match(ctx.root.textContent, /Review this result/);
  assert.doesNotMatch(ctx.root.textContent, /Could not refresh/);
  const textarea = byLabel(ctx.root, "Review feedback");
  textarea.value = "Add mobile filters";
  await textarea.emit("input");
  await env.polls[0]();
  assert.equal(byLabel(ctx.root, "Review feedback"), textarea);
  await byButton(ctx.root, "Revise this result").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/runs/r/review",
    body: {
      stepKey: "research",
      approved: false,
      note: "Add mobile filters",
      reviewId: "session:0",
      action: "revise",
    },
  });
  assert.equal(textarea.parentElement?.parentElement?.disabled, true);
});

test("Run rejects foreign engagement runs and hides mutation controls on historical rounds", async () => {
  const env = environment();
  assert.throws(
    () => env.subject.selectedAttempt(env.engagement, "foreign-run", null),
    /does not belong/,
  );
  assert.throws(
    () => env.subject.selectedAttempt(env.engagement, null, "99"),
    /does not exist/,
  );
  env.engagement.attempts.push({
    id: "a2",
    run_id: "r2",
    stage_index: 0,
    revision: 2,
    state: "running",
  });
  const ctx = await env.render("/next/run?engagement=e&run=r");
  assert.match(ctx.root.textContent, /read-only/);
  assert(
    !find(
      ctx.root,
      (e) =>
        e.tagName === "button" &&
        /Approve|Revise this|Pause after|Add guidance/.test(e.textContent),
    ),
  );
  assert.equal(env.posts.length, 0);
});

test("Run questions capture the exact question and preserve answers until submitted", async () => {
  const env = environment({
    "/runs/r/question": {
      question: {
        questionId: "q1",
        question: "Which market?",
        options: ["US", "UK"],
      },
    },
  });
  const ctx = await env.render("/next/run?run=r");
  const answer = byLabel(ctx.root, "Your answer");
  await byButton(ctx.root, "UK").click();
  assert.equal(answer.value, "UK");
  await env.polls[0]();
  assert.equal(byLabel(ctx.root, "Your answer"), answer);
  await byButton(ctx.root, "Answer & continue").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/runs/r/answer",
    body: { questionId: "q1", answer: "UK" },
  });
});

test("Stage feedback is bound to the current attempt and attributes customer input", async () => {
  const env = environment();
  env.run.status = "completed";
  env.run.steps[0].status = "completed";
  env.session.status = "completed";
  env.session.reviewId = null;
  env.engagement.state = "awaiting_approval";
  env.engagement.attempts[0].state = "awaiting_approval";
  env.engagement.attempts[0].output = { report: "Stage result" };
  const ctx = await env.render("/next/run?engagement=e&run=r");
  assert.match(ctx.root.textContent, /Stage result/);
  const note = byLabel(ctx.root, "Stage feedback");
  note.value = "Focus on independent brokerages";
  byLabel(ctx.root, "Feedback from").value = "customer";
  await byButton(ctx.root, "Request another round").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/engagements/e/decision",
    body: {
      attemptId: "a",
      action: "revise",
      feedback: "Focus on independent brokerages",
      source: "customer",
    },
  });
  assert.equal(note.parentElement?.parentElement?.disabled, true);
});

test("Stage approval names the next stage and pause is bound to the current round", async () => {
  const env = environment();
  env.run.status = "completed";
  env.run.steps[0].status = "completed";
  env.session.status = "completed";
  env.session.reviewId = null;
  env.engagement.state = "awaiting_approval";
  env.engagement.attempts[0].state = "awaiting_approval";
  const ctx = await env.render("/next/run?engagement=e&run=r");
  await byButton(ctx.root, "Approve Research & start Proposal").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/engagements/e/decision",
    body: {
      attemptId: "a",
      action: "approve",
      feedback: "",
      source: "operator",
    },
  });
  const another = environment();
  const active = await another.render("/next/run?engagement=e&run=r");
  await byButton(active.root, "Pause after current action").click();
  assert.deepEqual(plain(another.posts[0]), {
    path: "/engagements/e/decision",
    body: { attemptId: "a", action: "pause", feedback: "", source: "operator" },
  });
});

test("Customer confirmation preserves the selected identity under polling", async () => {
  const env = environment();
  env.run.organizationResolution = {
    state: "awaiting",
    identity: { name: "New customer", domain: "new.example" },
    candidates: [{ id: "customer", name: "Acme" }],
  };
  const ctx = await env.render("/next/run?run=r");
  const choice = byLabel(ctx.root, "Confirm customer organization");
  choice.value = "customer";
  await choice.emit("change");
  await env.polls[0]();
  assert.equal(byLabel(ctx.root, "Confirm customer organization"), choice);
  await byButton(ctx.root, "Confirm & continue").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/runs/r/organization",
    body: { organizationId: "customer" },
  });
});

test("Build updates show only public assistant messages and preserve chat anchors", async () => {
  const env = environment();
  env.build.progress.messages = Array.from({ length: 6 }, (_, i) => ({
    id: "m" + i,
    role: "assistant",
    text: "Public " + i,
    at: "2026-09-17T12:03:00Z",
  }));
  env.build.progress.messages.push({
    id: "hidden",
    role: "reasoning",
    text: "Hidden thought",
  });
  const ctx = await env.render("/next/run?build=b&view=updates");
  const log = byLabel(ctx.root, "OpenHands public updates");
  assert.doesNotMatch(ctx.root.textContent, /Hidden thought/);
  assert.equal(log.scrollTop, 400);
  log.scrollTop = 100;
  await log.emit("scroll");
  const anchored = log.children[1];
  env.build.progress.messages.push({
    id: "m7",
    role: "assistant",
    text: "New public update",
  });
  await env.polls[0]();
  assert.equal(log.children[1], anchored);
  assert.equal(log.scrollTop, 100);
  assert.equal(byButton(ctx.root, "Jump to latest").hidden, false);
  await byButton(ctx.root, "Jump to latest").click();
  assert.equal(log.scrollTop, 500);
  assert.equal(byButton(ctx.root, "Jump to latest").hidden, true);
});

test("Build preview stays mounted during refresh and optional links never target undefined", async () => {
  const env = environment();
  let ctx = await env.render("/next/run?build=b&view=preview");
  assert.match(ctx.root.textContent, /Preview not available/);
  assert(!find(ctx.root, (e) => e.tagName === "iframe"));
  assert(
    !find(
      ctx.root,
      (e) => e.tagName === "a" && /undefined|null/.test(e.attributes.href),
    ),
  );
  env.build.result = { previewUrl: "http://preview.local:31000/" };
  await env.polls[0]();
  const iframe = find(ctx.root, (e) => e.tagName === "iframe");
  assert(iframe);
  assert.equal(iframe.attributes.sandbox, "allow-scripts allow-forms");
  env.build.progress.message = "More recent activity";
  await env.polls[0]();
  assert.equal(
    find(ctx.root, (e) => e.tagName === "iframe"),
    iframe,
  );
});

test("Build resume reuses the request ID after uncertainty and suppresses stale failure actions", async () => {
  const env = environment();
  env.build.state = "failed";
  env.build.error = "Coding limit reached";
  let call = 0;
  env.fixtures.onPost = () => {
    if (++call === 1) throw Error("Connection lost");
    return { id: "b", state: "pending", attempt: 1 };
  };
  const ctx = await env.render("/next/run?build=b");
  await assert.rejects(
    () => byButton(ctx.root, "Resume build").click(),
    /Connection lost/,
  );
  await byButton(ctx.root, "Resume build").click();
  assert.equal(env.posts[0].body.requestId, env.posts[1].body.requestId);
  const pending = byButton(ctx.root, "Resuming…");
  assert.equal(pending.parentElement?.disabled, true);
  assert(
    !find(
      ctx.root,
      (e) => e.tagName === "button" && e.textContent === "Resume build",
    ),
  );
  await env.polls[0]();
  assert.equal(byButton(ctx.root, "Resuming…").parentElement?.disabled, true);
  env.build.state = "running";
  env.build.result = { _retry: { attempt: 1 } };
  await env.polls[0]();
  assert(
    !find(
      ctx.root,
      (e) => e.tagName === "button" && /Resum/.test(e.textContent),
    ),
  );
});

test("Workflow launch uses schema values and its captured workflow selection", async () => {
  const env = environment();
  const ctx = await env.render("/next/run?new=workflow&workflow=w");
  await byButton(ctx.root, "Start workflow").click();
  assert.deepEqual(plain(env.posts[0]), {
    path: "/workflows/w/runs",
    body: { input: { company: "Acme" } },
  });
  assert.match(env.nav[0], /run=new-run/);
  assert.match(env.nav[0], /workflow=w/);
});

test("Artifact generation targets the displayed source and keeps existing previews stable", async () => {
  const env = environment();
  const source = {
    kind: "skill",
    title: "Market research",
    skillVersionId: "sv",
    output: { report: "Findings" },
    settings: {
      presentation: { mode: "report" },
      artifacts: { mode: "on_demand", formats: ["pdf"] },
    },
    source: { runId: "r", workflowStepId: "s", sessionId: "session", turn: 2 },
  };
  env.fixtures["/runs/r/outputs"] = {
    sources: [source],
    jobs: [
      {
        id: "artifact",
        workflowStepId: "s",
        sessionId: "session",
        turn: 2,
        skillVersionId: "sv",
        state: "completed",
        settings: source.settings,
        files: [
          {
            id: "file",
            filename: "research.pdf",
            mimeType: "application/pdf",
            byteSize: 2048,
          },
        ],
      },
    ],
  };
  const ctx = await env.render("/next/run?run=r");
  const preview = find(
    ctx.root,
    (e) =>
      e.tagName === "details" &&
      e.children[0]?.textContent === "Preview research.pdf",
  );
  assert(preview);
  preview.open = true;
  await preview.emit("toggle");
  const iframe = find(ctx.root, (e) => e.tagName === "iframe");
  await env.polls[0]();
  assert.equal(
    find(ctx.root, (e) => e.tagName === "iframe"),
    iframe,
  );
  byLabel(ctx.root, "File format for Market research").value = "pptx";
  await byButton(ctx.root, "Generate file").click();
  assert.equal(env.posts[0].path, "/outputs/generate");
  assert.deepEqual(plain(env.posts[0].body.source), source.source);
  assert.deepEqual(plain(env.posts[0].body.settings.artifacts), {
    mode: "always",
    formats: ["pptx"],
  });
});

test("Run chooses Activity for active work once and respects an explicit Results view", async () => {
  const env = environment();
  env.run.status = "running";
  env.fixtures["/runs/r/builds"] = [env.build];
  const ctx = await env.render("/next/run?run=r");
  assert.match(ctx.root.textContent, /Open build updates/);
  assert.match(ctx.root.textContent, /OpenHands: Public update/);
  assert.doesNotMatch(ctx.root.textContent, /Hidden thought/);
  env.run.status = "completed";
  env.build.state = "completed";
  await env.polls[0]();
  assert.match(ctx.root.textContent, /Open build updates/);
  const explicit = await env.render("/next/run?run=r&view=results");
  assert.doesNotMatch(explicit.root.textContent, /Open build updates/);
  assert.match(explicit.root.textContent, /Products & previews/);
});

test("A completed build opens its preview initially, without changing the view on refresh", async () => {
  const env = environment();
  env.build.state = "completed";
  env.build.result = { previewUrl: "http://preview.example/" };
  const ctx = await env.render("/next/run?build=b");
  assert(find(ctx.root, (e) => e.tagName === "iframe"));
  env.build.state = "running";
  await env.polls[0]();
  assert(find(ctx.root, (e) => e.tagName === "iframe"));
  assert(
    !find(
      ctx.root,
      (e) => e.attributes["aria-label"] === "OpenHands public updates",
    ),
  );
});

test("Launch guards invalid partial edits and clears the guard before successful navigation", async () => {
  const env = environment();
  env.fixtures.readSchema = () => {
    throw Error("A required field is incomplete");
  };
  const ctx = await env.render("/next/run?new=workflow&workflow=w");
  assert.equal(env.guards.length, 1);
  assert.equal(env.guards[0](), false);
  const schema = find(
    ctx.root,
    (e) => e.tagName === "div" && e.textContent === "schema form",
  );
  assert(schema);
  await schema.emit("input");
  assert.equal(env.guards[0](), true);
  assert(!env.saved.has("nx-run:launch:inputs:w"));
  await assert.rejects(
    () => byButton(ctx.root, "Start workflow").click(),
    /required field/,
  );
  assert.equal(env.guards[0](), true);
  env.fixtures.readSchema = () => ({ company: "Acme" });
  env.fixtures.onPost = () => {
    throw Error("Launch unavailable");
  };
  await assert.rejects(
    () => byButton(ctx.root, "Start workflow").click(),
    /Launch unavailable/,
  );
  assert.equal(env.guards[0](), true);
  env.fixtures.onPost = () => ({ id: "new-run" });
  await byButton(ctx.root, "Start workflow").click();
  assert.equal(env.guards[0](), false);
  assert.deepEqual(env.navigationDirty, [false]);
});

test("Launch navigation guard covers engagement name and customer changes", async () => {
  for (const fieldLabel of ["Engagement name", "Customer organization"]) {
    const env = environment({
      "/engagement-templates": [
        {
          id: "chain",
          name: "Discovery chain",
          stages: [{ name: "Research", workflowId: "w" }],
        },
      ],
    });
    const ctx = await env.render("/next/run?new=engagement");
    const field = find(
      ctx.root,
      (e) => e.tagName === "label" && e.children[0]?.textContent === fieldLabel,
    );
    assert(field);
    const input = field.children[1];
    input.value =
      fieldLabel === "Engagement name" ? "Partial discovery brief" : "customer";
    await input.emit(input.tagName === "select" ? "change" : "input");
    assert.equal(
      env.guards[0](),
      true,
      `${fieldLabel} should guard navigation`,
    );
    assert.equal(env.posts.length, 0);
  }
});
