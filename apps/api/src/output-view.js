/* Render saved values as DOM text. Never execute model HTML or JavaScript. */
(() => {
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const label = (s) =>
    String(s)
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  function value(v, depth = 0) {
    if (v === null || v === undefined)
      return el("span", "Not provided", "ov-unknown");
    if (typeof v !== "object") {
      const text = String(v);
      const p = el("p");
      // Only explicit HTTP(S) links from saved evidence become clickable.
      for (const part of text.split(/(https?:\/\/[^\s<>"']+)/g)) {
        if (/^https?:\/\//i.test(part)) {
          const a = el("a", part);
          a.href = part;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          p.append(a);
        } else p.append(document.createTextNode(part));
      }
      return p;
    }
    if (depth > 12)
      return el("p", "Nested content available in Raw JSON.", "ov-unknown");
    if (Array.isArray(v)) {
      if (!v.length) return el("p", "None recorded", "ov-unknown");
      const list = el("ol", undefined, "ov-list");
      for (const item of v) {
        const li = el("li");
        li.append(value(item, depth + 1));
        list.append(li);
      }
      return list;
    }
    const box = el("div", undefined, "ov-fields");
    for (const [k, x] of Object.entries(v)) {
      const section = el("section", undefined, "ov-field");
      section.append(el("h4", label(k)), value(x, depth + 1));
      box.append(section);
    }
    return box;
  }
  function table(rows) {
    if (
      !rows.length ||
      !rows.every((x) => x && typeof x === "object" && !Array.isArray(x))
    )
      return value(rows);
    const columns = [...new Set(rows.flatMap(Object.keys))];
    const wrap = el("div", undefined, "ov-table-scroll");
    const t = el("table", undefined, "ov-table");
    const head = el("tr");
    columns.forEach((c) => head.append(el("th", label(c))));
    const thead = el("thead");
    thead.append(head);
    t.append(thead);
    const body = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      for (const c of columns) {
        const td = el("td");
        td.append(value(r[c]));
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  function render(data, mode = "auto") {
    const root = el("div", undefined, "output-view");
    if (mode === "table") {
      if (Array.isArray(data)) root.append(table(data));
      else if (data && typeof data === "object")
        for (const [k, v] of Object.entries(data)) {
          root.append(
            el("h3", label(k)),
            Array.isArray(v) ? table(v) : value(v),
          );
        }
      else root.append(value(data));
    } else if (mode === "cards" || mode === "diagram") {
      const items = Array.isArray(data)
        ? data.map((v, i) => [String(i + 1), v])
        : data && typeof data === "object"
          ? Object.entries(data)
          : [["Result", data]];
      const grid = el(
        "div",
        undefined,
        mode === "diagram" ? "ov-diagram" : "ov-cards",
      );
      if (mode === "diagram")
        root.append(
          el(
            "p",
            "Sections shown in recorded order; no causal relationships are inferred.",
            "ov-unknown",
          ),
        );
      for (const [k, v] of items) {
        const c = el("section", undefined, "ov-card");
        c.append(el("h3", label(k)), value(v));
        grid.append(c);
      }
      root.append(grid);
    } else root.append(value(data));
    return root;
  }
  window.OutputView = { render, label };
})();
