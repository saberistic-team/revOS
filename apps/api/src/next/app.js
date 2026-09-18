import {
  h,
  api,
  button,
  link,
  badge,
  icon,
  empty,
  navigate,
  setContext,
  canNavigate,
  poll,
  notify,
} from "./core.js";
import { mountAssistant } from "./assistant.js";
import { renderRun } from "./run.js";
import { renderLibrary } from "./library.js";
import { renderOrganizations } from "./organizations.js";
import { watchInterfaceUpdates } from "./updates.js";
const main = document.querySelector("#nx-main"),
  navigation = document.querySelector("#nx-navigation");
const sections = [
  ["inbox", "Inbox"],
  ["run", "Run"],
  ["organizations", "Organizations"],
  ["library", "Library"],
];
for (const [key, label] of sections)
  navigation.append(link(label, "/next/" + key, { icon: key }));
let abort,
  cleanups = [],
  generation = 0,
  lastUrl = location.href;
async function route() {
  const current = ++generation;
  abort?.abort();
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
  cleanups = [];
  abort = new AbortController();
  const url = new URL(location.href),
    section = url.pathname.split("/")[2] || "run";
  lastUrl = url.href;
  setContext({
    scope:
      section === "organizations"
        ? "knowledge"
        : section === "library"
          ? "library"
          : "run",
  });
  for (const a of navigation.querySelectorAll("a"))
    a.setAttribute(
      "aria-current",
      a.pathname.endsWith("/" + section) ? "page" : "false",
    );
  document.title = `revOS · ${sections.find((s) => s[0] === section)?.[1] || "Workspace"}`;
  document.querySelector("#nx-breadcrumb").textContent =
    sections.find((s) => s[0] === section)?.[1] || "Workspace";
  main.className = "";
  main.replaceChildren(
    h("p", { class: "nx-loading", role: "status" }, "Loading workspace…"),
  );
  const ctx = {
    root: main,
    url,
    signal: abort.signal,
    onCleanup: (fn) => cleanups.push(fn),
  };
  try {
    await (
      {
        run: renderRun,
        library: renderLibrary,
        organizations: renderOrganizations,
        inbox: renderInbox,
      }[section] || renderRun
    )(ctx);
    if (current !== generation) return;
    main.querySelector(".nx-loading")?.remove();
    document.querySelector("#nx-connection").textContent = "";
  } catch (e) {
    if (current !== generation || e.name === "AbortError") return;
    main.replaceChildren(
      empty("This workspace could not load", e.message),
      button("Try again", route, { icon: "refresh" }),
    );
  }
}
async function renderInbox(ctx) {
  const heading = h(
      "div",
      { class: "nx-page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Needs your input"),
        h(
          "p",
          { class: "nx-muted" },
          "Questions and decisions across your work.",
        ),
      ),
    ),
    list = h("div", { class: "nx-list" }),
    filters = h("div", { class: "nx-actions" });
  let selected = "all",
    data = [],
    signature = "";
  const draw = () => {
    const shown =
      selected === "all"
        ? data
        : data.filter((i) => i.organizationId === selected);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((i) =>
            h(
              "article",
              { class: "nx-row" },
              h(
                "div",
                {},
                h("h3", {}, i.title),
                h(
                  "div",
                  { class: "nx-actions" },
                  h("span", { class: "nx-muted nx-small" }, i.organizationName),
                  badge(i.label),
                ),
              ),
              link("Open", i.href, { icon: "arrow" }),
            ),
          )
        : [
            empty(
              "You’re all caught up",
              "Questions and reviews will appear here when your work needs a decision.",
            ),
          ]),
    );
  };
  ctx.root.replaceChildren(heading, filters, list);
  async function update() {
    const next = await api("/next-api/inbox", { signal: ctx.signal });
    if (ctx.signal.aborted) return;
    const sig = JSON.stringify(next);
    if (sig === signature) return;
    signature = sig;
    data = next.items;
    const select = h(
      "select",
      { "aria-label": "Filter by organization" },
      h("option", { value: "all" }, "All organizations"),
      ...[
        ...new Map(data.map((i) => [i.organizationId, i.organizationName])),
      ].map(([id, name]) => h("option", { value: id }, name)),
    );
    select.value = selected;
    select.onchange = () => {
      selected = select.value;
      draw();
    };
    filters.replaceChildren(select);
    draw();
  }
  await update();
  poll(update, 7000, ctx);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (
    !a ||
    !a.getAttribute("href") ||
    e.defaultPrevented ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey ||
    e.button !== 0 ||
    a.target ||
    a.download
  )
    return;
  const u = new URL(a.href);
  if (
    u.hash &&
    u.pathname === location.pathname &&
    u.search === location.search
  )
    return;
  if (u.origin === location.origin && u.pathname.startsWith("/next")) {
    e.preventDefault();
    navigate(u.href);
  }
});
window.addEventListener("nx:navigate", () => void route());
window.addEventListener("popstate", () => {
  if (!canNavigate()) {
    history.pushState({}, "", lastUrl);
    return;
  }
  void route();
});
window.addEventListener("nx:context", (e) => {
  document.querySelector("#nx-breadcrumb").textContent =
    e.detail.label ||
    sections.find((s) => location.pathname.endsWith(s[0]))?.[1] ||
    "Workspace";
});
window.addEventListener("nx:connection", (e) => {
  document.querySelector("#nx-connection").textContent = e.detail.ok
    ? ""
    : "Connection interrupted · retrying";
});
mountAssistant();
const dialog = document.querySelector("#nx-search"),
  query = document.querySelector("#nx-search-input"),
  results = document.querySelector("#nx-search-results");
let searchItems = [];
async function openSearch() {
  dialog.showModal();
  query.focus();
  if (!searchItems.length) {
    try {
      const [catalog, workflows, engagements, products] = await Promise.all([
        api("/builder/catalog"),
        api("/workflows"),
        api("/engagements"),
        api("/next-api/search-products"),
      ]);
      searchItems = [
        {
          name: "New engagement",
          kind: "Start",
          url: "/next/run?new=engagement",
        },
        {
          name: "Run a workflow",
          kind: "Start",
          url: "/next/run?new=workflow",
        },
        ...products.map((p) => ({
          name: p.name,
          kind: "Product",
          url:
            "/next/organizations?organization=" +
            p.organizationId +
            "&view=products&product=" +
            p.id,
        })),
        ...sections.map(([key, name]) => ({
          name,
          kind: "Page",
          url: "/next/" + key,
        })),
        ...catalog.organizations.map((o) => ({
          name: o.name,
          kind: "Organization",
          url: "/next/organizations?organization=" + o.id,
        })),
        ...workflows.map((w) => ({
          name: w.name,
          kind: "Workflow",
          url:
            "/next/library?tab=workflows&organization=" +
            w.organizationId +
            "&item=" +
            w.id,
        })),
        ...engagements.map((e) => ({
          name: e.name,
          kind: "Engagement",
          url: "/next/run?engagement=" + e.id,
        })),
      ];
    } catch (e) {
      results.replaceChildren(h("p", { class: "nx-error" }, e.message));
      return;
    }
  }
  renderSearch();
}
function renderSearch() {
  const q = query.value.toLowerCase();
  results.replaceChildren(
    ...searchItems
      .filter((i) => (i.name + " " + i.kind).toLowerCase().includes(q))
      .slice(0, 25)
      .map((i) => {
        const a = link("", i.url);
        a.append(
          h("span", {}, i.name),
          h("span", { class: "nx-muted nx-small" }, i.kind),
        );
        a.addEventListener("click", () => dialog.close());
        return a;
      }),
  );
}
query.oninput = renderSearch;
document.querySelector("#nx-search-button").onclick = openSearch;
document.querySelector("#nx-search-close").onclick = () => dialog.close();
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    void openSearch();
  }
  if (e.key === "Escape")
    document
      .querySelector("#nx-assistant-toggle")
      .getAttribute("aria-expanded") === "true" &&
      document.querySelector("#nx-assistant-toggle").click();
});
watchInterfaceUpdates();
void route();
