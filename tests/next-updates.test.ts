import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const updates = readFileSync(
  resolve(__dirname, "../apps/api/src/next/updates.js"),
  "utf8",
);
const core = readFileSync(
  resolve(__dirname, "../apps/api/src/next/core.js"),
  "utf8",
);
const server = ts.transpileModule(
  readFileSync(resolve(__dirname, "../apps/api/src/next.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function browser(version: string | null = "loaded-version") {
  class Element {
    children: Element[] = [];
    text = "";
    attributes: Record<string, any> = {};
    listeners: Record<string, Function[]> = {};
    className = "";
    disabled = false;
    classList = {
      add: (name: string) => {
        this.className += " " + name;
      },
    };
    constructor(public tag: string) {}
    append(...values: any[]) {
      for (const value of values)
        this.children.push(
          value instanceof Element
            ? value
            : Object.assign(new Element("text"), { text: String(value) }),
        );
    }
    setAttribute(key: string, value: any) {
      this.attributes[key] = value;
    }
    get textContent(): string {
      return this.text + this.children.map((n) => n.textContent).join("");
    }
    addEventListener(type: string, fn: Function) {
      (this.listeners[type] ||= []).push(fn);
    }
    async click() {
      if (this.disabled) return;
      for (const fn of this.listeners.click || []) await fn({});
    }
    all(): Element[] {
      return this.children.flatMap((n) => [n, ...n.all()]);
    }
  }
  const body = new Element("body"),
    notices = new Element("div");
  body.append(notices);
  const events = new Map<string, Function[]>(),
    intervals = new Map<number, { fn: Function; ms: number }>(),
    timeouts = new Map<number, Function>();
  let sequence = 0,
    reloads = 0,
    requests = 0;
  const calls: any[] = [];
  let fetcher = async (_path: string, _options: any): Promise<any> => ({
    ok: true,
    json: async () => ({ version }),
  });
  const document = {
    body,
    hidden: false,
    querySelector(selector: string) {
      return selector === 'meta[name="revos-ui-version"]'
        ? version
          ? { content: version }
          : null
        : selector === "#nx-notifications"
          ? notices
          : null;
    },
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) =>
      Object.assign(new Element("text"), { text }),
    addEventListener(name: string, fn: Function) {
      events.set(name, [...(events.get(name) || []), fn]);
    },
    removeEventListener(name: string, fn: Function) {
      events.set(
        name,
        (events.get(name) || []).filter((handler) => handler !== fn),
      );
    },
  };
  const box: any = {
    document,
    Node: Element,
    window: { addEventListener() {} },
    location: {
      origin: "http://localhost:3004",
      reload() {
        reloads++;
      },
    },
    AbortController,
    URL,
    console,
    fetch: (path: string, options: any) => {
      requests++;
      calls.push({ path, options });
      return fetcher(path, options);
    },
    setInterval(fn: Function, ms: number) {
      const id = ++sequence;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    setTimeout(fn: Function) {
      const id = ++sequence;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timeouts.delete(id);
    },
  };
  vm.createContext(box);
  vm.runInContext(core.replace(/^export /gm, ""), box);
  vm.runInContext(
    updates
      .replace(/^import\s+[\s\S]*?from ['"]\.\/core\.js['"];\s*/, "")
      .replace(/^export /gm, ""),
    box,
  );
  return {
    box,
    body,
    notices,
    document,
    intervals,
    calls,
    get requests() {
      return requests;
    },
    get reloads() {
      return reloads;
    },
    start: () => box.watchInterfaceUpdates(),
    response(fn: typeof fetcher) {
      fetcher = fn;
    },
    async interval() {
      for (const { fn } of intervals.values()) fn();
      await settle();
    },
    async visible(hidden: boolean) {
      document.hidden = hidden;
      for (const fn of events.get("visibilitychange") || []) fn();
      await settle();
    },
    async timeout() {
      for (const fn of [...timeouts.values()]) fn();
      await settle();
    },
  };
}

test("same interface version stays quiet and starts exactly one 30-second watcher", async () => {
  const app = browser(),
    first = app.start();
  await settle();
  assert.equal(app.start(), first);
  assert.equal(app.intervals.size, 1);
  assert.equal([...app.intervals.values()][0].ms, 30000);
  await app.interval();
  assert.equal(app.requests, 2);
  assert.equal(app.notices.children.length, 0);
  assert.equal(app.reloads, 0);
  assert.ok(
    app.calls.every(
      (call) =>
        call.path === "/next-api/ui-version" &&
        call.options.cache === "no-store",
    ),
  );
});

test("a new version shows one persistent notice and never reloads automatically", async () => {
  const app = browser();
  app.response(async () => ({
    ok: true,
    json: async () => ({ version: "new-version" }),
  }));
  app.start();
  await settle();
  assert.equal(app.notices.children.length, 1);
  assert.match(
    app.notices.textContent,
    /A new interface version is available\./,
  );
  await app.interval();
  await app.visible(false);
  assert.equal(app.notices.children.length, 1);
  assert.equal(app.reloads, 0);
  const button = app.notices.all().find((node) => node.tag === "button")!;
  assert.equal(button.textContent, "Refresh");
  await button.click();
  assert.equal(app.reloads, 1, "only a deliberate click invokes native reload");
});

test("transient errors and invalid responses are silent and later checks recover", async () => {
  const app = browser();
  app.response(async () => {
    throw Error("Offline");
  });
  app.start();
  await settle();
  assert.equal(app.notices.children.length, 0);
  assert.equal(app.reloads, 0);
  app.response(async () => ({
    ok: false,
    json: async () => {
      throw Error("Should not parse error");
    },
  }));
  await app.interval();
  app.response(async () => ({ ok: true, json: async () => ({ version: "" }) }));
  await app.interval();
  assert.equal(app.notices.children.length, 0);
  app.response(async () => ({
    ok: true,
    json: async () => ({ version: "new-version" }),
  }));
  await app.interval();
  assert.equal(app.notices.children.length, 1);
  app.response(async () => {
    throw Error("Temporary interruption");
  });
  await app.interval();
  assert.equal(
    app.notices.children.length,
    1,
    "existing update notice must survive an unavailable check",
  );
  assert.equal(app.reloads, 0);
});

test("checks do not overlap and visibility resumes discovery", async () => {
  const app = browser(),
    pending = deferred();
  app.response(() => pending.promise);
  app.start();
  await settle();
  await app.interval();
  await app.visible(false);
  assert.equal(app.requests, 1);
  pending.resolve({
    ok: true,
    json: async () => ({ version: "loaded-version" }),
  });
  await settle();
  await app.visible(true);
  await app.interval();
  assert.equal(app.requests, 1);
  app.response(async () => ({
    ok: true,
    json: async () => ({ version: "new-version" }),
  }));
  await app.visible(false);
  assert.equal(app.requests, 2);
  assert.equal(app.notices.children.length, 1);
});

test("a timed-out check releases the poll and stopping prevents late notices", async () => {
  const app = browser();
  app.response(
    (_path, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(Error("Aborted")),
        ),
      ),
  );
  const watch = app.start();
  await settle();
  await app.timeout();
  const pending = deferred();
  app.response(() => pending.promise);
  await app.interval();
  assert.equal(app.requests, 2);
  watch.stop();
  pending.resolve({ ok: true, json: async () => ({ version: "new-version" }) });
  await settle();
  assert.equal(app.notices.children.length, 0);
  assert.equal(app.intervals.size, 0);
  await app.visible(false);
  assert.equal(app.requests, 2);
});

test("HTML without a version does not guess or request a refresh", async () => {
  const app = browser(null);
  assert.equal(app.start(), null);
  await settle();
  assert.equal(app.requests, 0);
  assert.equal(app.intervals.size, 0);
});

function serverHarness(
  files: Record<string, string>,
  order = Object.keys(files),
) {
  const routes = new Map<string, Function>(),
    module = { exports: {} as any };
  const box = {
    module,
    exports: module.exports,
    __dirname: "/virtual/api",
    require(name: string) {
      if (name === "node:fs")
        return {
          readdirSync: () => order,
          readFileSync: (path: string) => files[path.split("/").at(-1)!],
        };
      if (name === "node:path") return { join };
      if (name === "node:crypto") return { createHash };
      return {};
    },
  };
  vm.runInNewContext(server, box);
  module.exports.registerNext({
    get(path: string, handler: Function) {
      routes.set(path, handler);
    },
    post() {},
  });
  return {
    async request(path: string) {
      const result: any = { headers: {}, body: null, mime: null };
      const reply = {
        header(key: string, value: string) {
          result.headers[key] = value;
          return this;
        },
        type(value: string) {
          result.mime = value;
          return this;
        },
        send(value: any) {
          result.body = value;
          return this;
        },
      };
      await routes.get(path)!({}, reply);
      return result;
    },
  };
}
const fixture = {
  "index.html":
    "<!doctype html><html><head><title>Workspace</title></head><body>Saved work</body></html>",
  "app.js": "const app = 1;",
  "app.css": "body {color:green}",
  "core.js": "const core = 1;",
};

test("server version is deterministic across directory order and matches uncached HTML", async () => {
  const a = serverHarness(fixture),
    b = serverHarness(fixture, Object.keys(fixture).reverse());
  const current = await a.request("/next-api/ui-version"),
    other = await b.request("/next-api/ui-version");
  assert.match(current.body.version, /^[a-f0-9]{64}$/);
  assert.equal(current.body.version, other.body.version);
  assert.equal(current.headers["Cache-Control"], "no-store");
  for (const path of ["/next", "/next/*"]) {
    const html = await a.request(path);
    assert.equal(html.headers["Cache-Control"], "no-store");
    assert.equal(html.mime, "text/html");
    assert.ok(
      html.body.includes(
        `<meta name="revos-ui-version" content="${current.body.version}">`,
      ),
    );
  }
  const asset = await a.request("/next/assets/app.js");
  assert.equal(asset.body, fixture["app.js"]);
  assert.equal(asset.mime, "text/javascript");
});

test("HTML, script, or stylesheet changes change the advertised version", async () => {
  const baseline = (
    await serverHarness(fixture).request("/next-api/ui-version")
  ).body.version;
  for (const file of ["index.html", "app.js", "app.css"]) {
    const changed = {
      ...fixture,
      [file]: fixture[file as keyof typeof fixture] + "\nchanged",
    };
    assert.notEqual(
      (await serverHarness(changed).request("/next-api/ui-version")).body
        .version,
      baseline,
      file,
    );
  }
});
