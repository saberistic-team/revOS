export function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class" || key === "className") n.className = value;
    else if (key.startsWith("on") && typeof value === "function")
      n.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "style" && typeof value === "object")
      Object.assign(n.style, value);
    else if (
      [
        "value",
        "checked",
        "selected",
        "disabled",
        "hidden",
        "open",
        "required",
        "readOnly",
        "multiple",
      ].includes(key)
    )
      n[key] = value;
    else n.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== null && child !== undefined && child !== false)
      n.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  return n;
}
export async function api(path, { method = "GET", body, signal } = {}) {
  const r = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("The service returned an unreadable response. Try again.");
  }
  if (!r.ok) throw Error(data.error || `Request failed (${r.status})`);
  return data;
}
const paths = {
  inbox: "M4 4h16v16H4z M4 13h5l2 3h2l2-3h5",
  run: "m8 5 11 7-11 7z",
  play: "m8 5 11 7-11 7z",
  organizations:
    "M4 21V7h9v14 M13 11h7v10 M7 10h3 M7 14h3 M7 18h3 M16 14h1 M16 18h1",
  library: "M4 4h4v16H4z M10 4h4v16h-4z M17 4l4 15-3 1-4-15z",
  assistant: "M4 4h16v13H9l-5 4z M8 8h8 M8 12h5",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  plus: "M12 5v14 M5 12h14",
  close: "m6 6 12 12 M6 18 18 6",
  x: "m6 6 12 12 M6 18 18 6",
  chevron: "m9 5 7 7-7 7",
  arrow: "M5 12h14 m-6-6 6 6-6 6",
  back: "M19 12H5 m6-6-6 6 6 6",
  check: "m5 12 4 4L19 6",
  external: "M14 3h7v7 M10 14 21 3 M10 4H4v16h16v-6",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h8",
  files: "M8 3h12v15H8z M4 7v14h12",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l4 2",
  history: "M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l3 2",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  product: "M3 5h18v14H3z M3 9h18 M6 7h.01 M9 7h.01",
  code: "m8 6-6 6 6 6 m8-12 6 6-6 6 m-3-15-2 18",
  tools: "M14 4a6 6 0 0 0-8 8L2 18l4 4 6-6a6 6 0 0 0 8-8l-4 4-4-4 4-4z",
  workflow: "M4 3h6v6H4z M14 15h6v6h-6z M7 9v9h7",
  branch: "M6 4v14 M6 10h8a4 4 0 0 0 4-4V3 M3 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  book: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3z M12 6v16",
  map: "m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16",
  edit: "m4 16 12-12 4 4L8 20H4z M13 7l4 4",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4",
  pause: "M8 4v16 M16 4v16",
  stop: "M5 5h14v14H5z",
  refresh:
    "M20 10a8 8 0 0 0-14-6L3 7 M3 2v5h5 M4 14a8 8 0 0 0 14 6l3-3 M21 22v-5h-5",
  mic: "M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 10v7 M12 7h.01",
  alert: "m12 3 10 18H2z M12 8v6 M12 17h.01",
  send: "m3 3 18 9-18 9 4-9z M7 12h14",
};
const aliases = {
  "building-2": "organizations",
  "message-circle": "assistant",
  "file-text": "file",
  "book-open": "book",
  "external-link": "external",
  "arrow-right": "arrow",
  "arrow-left": "back",
  "git-branch": "branch",
  "circle-check": "check",
  "circle-alert": "alert",
  "app-window": "product",
  "code-2": "code",
  "chevron-right": "chevron",
  "refresh-cw": "refresh",
  ellipsis: "more",
  "trash-2": "close",
  save: "check",
};
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.7");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.classList.add("nx-icon");
  const p = document.createElementNS(s.namespaceURI, "path");
  p.setAttribute("d", paths[aliases[name] || name] || paths.file);
  s.append(p);
  return s;
}
export function button(
  label,
  onClick,
  { primary = false, icon: iconName, ...attrs } = {},
) {
  const b = h(
    "button",
    {
      type: "button",
      ...attrs,
      class: [
        primary ? "nx-button nx-primary" : "nx-button",
        attrs.class || "",
      ].join(" "),
    },
    iconName ? icon(iconName) : null,
    label,
  );
  if (onClick)
    b.addEventListener("click", async (e) => {
      if (b.disabled) return;
      const disabled = b.disabled;
      b.disabled = true;
      try {
        await onClick(e);
      } catch (err) {
        notify(err.message || String(err), "error");
      } finally {
        b.disabled = disabled;
      }
    });
  return b;
}
export function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(String(value), location.origin);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function link(label, href, { icon: iconName, ...attrs } = {}) {
  const url = safeUrl(href);
  return h(
    "a",
    {
      ...attrs,
      href: url || undefined,
      class: ["nx-link", attrs.class || ""].join(" "),
      ...(url && new URL(url).origin !== location.origin
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {}),
    },
    iconName ? icon(iconName) : null,
    label,
  );
}
export function badge(text, tone = "") {
  const normalized = String(text || "").replaceAll("_", " ");
  return h(
    "span",
    {
      class:
        "nx-badge " +
        (tone ||
          (/fail|stop|reject/i.test(normalized)
            ? "danger"
            : /wait|review|question|pending/i.test(normalized)
              ? "warning"
              : /complete|approved|ready|published/i.test(normalized)
                ? "success"
                : "")),
    },
    normalized,
  );
}
export function tabs(items, selected, onSelect) {
  return h(
    "nav",
    { class: "nx-tabs", "aria-label": "Page sections" },
    ...items.map((i) =>
      button(i.label, () => onSelect(i.key), {
        "aria-pressed": i.key === selected,
        class: i.key === selected ? "active" : "",
      }),
    ),
  );
}
export function empty(title, description = "") {
  return h(
    "div",
    { class: "nx-empty" },
    h("h2", {}, title),
    description ? h("p", { class: "nx-muted" }, description) : null,
  );
}
export function jsonDetails(value, label = "Technical details") {
  return h(
    "details",
    { class: "nx-technical" },
    h("summary", {}, label),
    h("pre", {}, JSON.stringify(value, null, 2)),
  );
}
export function output(value) {
  return window.OutputView
    ? window.OutputView.render(value)
    : h(
        "pre",
        {},
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      );
}
export function time(value) {
  if (!value) return "Not recorded";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(value);
}
export function notify(text, type = "info") {
  const root = document.querySelector("#nx-notifications");
  if (!root) return;
  const node = h(
    "div",
    { class: "nx-toast " + type, role: type === "error" ? "alert" : "status" },
    text,
    button("Dismiss", () => node.remove(), {
      class: "nx-quiet",
      "aria-label": "Dismiss notification",
    }),
  );
  root.append(node);
  if (type !== "error") setTimeout(() => node.remove(), 7000);
}
let context = {},
  unsaved = new Set();
export function setContext(next) {
  context = { ...next };
  window.dispatchEvent(new CustomEvent("nx:context", { detail: context }));
}
export const getContext = () => context;
export function guardUnsaved(checkFn, ctx) {
  unsaved.add(checkFn);
  ctx?.onCleanup(() => unsaved.delete(checkFn));
  return () => unsaved.delete(checkFn);
}
export function canNavigate() {
  return (
    ![...unsaved].some((fn) => fn()) ||
    window.confirm(
      "Leave this page with unsaved changes? Your saved version will remain unchanged.",
    )
  );
}
export function navigate(url, { replace = false, force = false } = {}) {
  if (!force && !canNavigate()) return false;
  const target = new URL(url, location.origin);
  if (
    target.origin !== location.origin ||
    !target.pathname.startsWith("/next")
  ) {
    location.href = target.href;
    return true;
  }
  history[replace ? "replaceState" : "pushState"]({}, "", target);
  window.dispatchEvent(new Event("nx:navigate"));
  return true;
}
window.addEventListener("beforeunload", (e) => {
  if ([...unsaved].some((fn) => fn())) {
    e.preventDefault();
    e.returnValue = "";
  }
});
export function poll(fn, ms, ctx) {
  let busy = false,
    stopped = false;
  const tick = async () => {
    if (stopped || busy || ctx?.signal.aborted || document.hidden) return;
    busy = true;
    try {
      await fn();
      window.dispatchEvent(
        new CustomEvent("nx:connection", { detail: { ok: true } }),
      );
    } catch (e) {
      if (e.name !== "AbortError") {
        window.dispatchEvent(
          new CustomEvent("nx:connection", {
            detail: { ok: false, message: e.message },
          }),
        );
      }
    } finally {
      busy = false;
    }
  };
  const id = setInterval(tick, ms);
  const stop = () => {
    stopped = true;
    clearInterval(id);
  };
  ctx?.onCleanup(stop);
  return stop;
}

// Recursive, schema-backed forms: ordinary inputs for objects, choices and lists.
export function schemaForm(schema = {}, initial = {}) {
  const element = h("div", { class: "nx-schema-form" });
  let count = 0;
  function field(s, value, title, required = false, depth = 0) {
    const id = "nx-field-" + crypto.randomUUID(),
      type = Array.isArray(s.type)
        ? s.type.find((t) => t !== "null")
        : s.type || (s.properties ? "object" : "string");
    if (type === "object" && depth < 8) {
      const box = h(
        "fieldset",
        { class: "nx-form-group" },
        title ? h("legend", {}, title) : null,
      );
      const entries = Object.entries(s.properties || {});
      if (!entries.length) {
        const t = h(
          "textarea",
          { "aria-label": title || "Additional input", rows: 4 },
          JSON.stringify(value || {}, null, 2),
        );
        box.append(
          h(
            "p",
            { class: "nx-muted nx-small" },
            "This input has no field definition. Enter an object.",
          ),
          t,
        );
        return {
          node: box,
          read: () => {
            const v = JSON.parse(t.value || "{}");
            if (!v || typeof v !== "object" || Array.isArray(v))
              throw Error("Enter a JSON object.");
            return v;
          },
        };
      }
      const fields = entries.map(([key, child]) => [
        key,
        field(
          child,
          value?.[key],
          child.title ||
            key
              .replaceAll("_", " ")
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .replace(/^./, (v) => v.toUpperCase()),
          (s.required || []).includes(key),
          depth + 1,
        ),
      ]);
      fields.forEach(([, f]) => box.append(f.node));
      return {
        node: box,
        read: () =>
          Object.fromEntries(
            fields
              .map(([k, f]) => [k, f.read()])
              .filter(([, v]) => v !== undefined),
          ),
      };
    }
    if (type === "array" && depth < 8) {
      const box = h(
        "fieldset",
        { class: "nx-form-group" },
        h("legend", {}, title),
      );
      const list = h("div"),
        rows = [];
      const add = (v) => {
        const f = field(
            s.items || { type: "string" },
            v,
            "Item",
            false,
            depth + 1,
          ),
          r = h("div", { class: "nx-array-item" }, f.node);
        const row = { f, r };
        r.append(
          button("Remove", () => {
            rows.splice(rows.indexOf(row), 1);
            r.remove();
          }),
        );
        rows.push(row);
        list.append(r);
      };
      (Array.isArray(value) ? value : []).forEach(add);
      box.append(
        list,
        button("Add item", () => add(undefined), { icon: "plus" }),
      );
      return {
        node: box,
        read: () => {
          const v = rows.map((r) => r.f.read());
          if (s.minItems && v.length < s.minItems)
            throw Error(`${title}: add at least ${s.minItems} items.`);
          return v;
        },
      };
    }
    let input;
    if (Array.isArray(s.enum)) {
      input = h(
        "select",
        { id, required },
        !required ? h("option", { value: "" }, "Choose…") : null,
        ...s.enum.map((v, i) =>
          h("option", { value: String(i), selected: v === value }, String(v)),
        ),
      );
      if (value === undefined) input.value = required ? "0" : "";
    } else if (type === "boolean")
      input = h("input", { id, type: "checkbox", checked: value === true });
    else if (["number", "integer"].includes(type))
      input = h("input", {
        id,
        type: "number",
        required,
        value: value ?? "",
        step: type === "integer" ? "1" : "any",
        min: s.minimum,
        max: s.maximum,
      });
    else if (s.format === "date")
      input = h("input", { id, type: "date", required, value: value ?? "" });
    else
      input = h(
        s.maxLength > 240 ||
          /notes|description|brief|instructions|context|problem/i.test(title)
          ? "textarea"
          : "input",
        {
          id,
          required,
          type: s.format === "email" ? "email" : "text",
          value:
            typeof value === "string"
              ? value
              : value === undefined
                ? ""
                : JSON.stringify(value),
          maxLength: s.maxLength,
          minLength: s.minLength,
          rows: 3,
        },
      );
    const box = h(
      "div",
      { class: "nx-field" },
      h("label", { for: id }, title, required ? " *" : ""),
      input,
      s.description
        ? h("p", { class: "nx-muted nx-small" }, s.description)
        : null,
    );
    count++;
    return {
      node: box,
      read: () => {
        if (!input.checkValidity())
          throw Error(`${title}: ${input.validationMessage}`);
        if (type === "boolean") return input.checked;
        if (input.value === "") return required ? "" : undefined;
        if (s.enum) return s.enum[Number(input.value)];
        if (["number", "integer"].includes(type)) return Number(input.value);
        return input.value;
      },
    };
  }
  const result = field(schema, initial, "", true);
  element.append(result.node);
  return { element, read: () => result.read() };
}
