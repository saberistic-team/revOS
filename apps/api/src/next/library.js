import {
  h,
  api,
  button,
  link,
  badge,
  tabs,
  empty,
  jsonDetails,
  schemaForm,
  output,
  notify,
  navigate,
  setContext,
  time,
  guardUnsaved,
} from "./core.js";

const sections = [
  { key: "workflows", label: "Workflows" },
  { key: "chains", label: "Chains" },
  { key: "skills", label: "Skills" },
  { key: "knowledge", label: "Reference knowledge" },
  { key: "tools", label: "Tools" },
];
const clone = (value) => structuredClone(value);
const pretty = (value) => JSON.stringify(value, null, 2);
const para = (value) => h("p", { class: "nx-muted" }, value);
const card = (...children) => h("section", { class: "nx-card" }, ...children);
const row = (...children) => h("div", { class: "nx-row" }, ...children);
const actions = (...children) => h("div", { class: "nx-actions" }, ...children);

export function groupedSkills(skills) {
  const groups = new Map();
  for (const skill of skills) {
    if (skill.executionType !== "agent") continue;
    if (!groups.has(skill.skillId)) groups.set(skill.skillId, []);
    groups.get(skill.skillId).push(skill);
  }
  return [...groups.values()].map((versions) =>
    versions.sort((a, b) => b.version - a.version),
  );
}

export function updateSchemaField(schema, oldName, newName, patch, required) {
  newName = newName.trim();
  if (!newName) throw Error("Give the field a name.");
  if (oldName !== newName && Object.hasOwn(schema.properties || {}, newName))
    throw Error("Each field needs a unique name.");
  const next = clone(schema),
    entries = Object.entries(next.properties || {});
  next.properties = Object.fromEntries(
    entries.map(([key, value]) =>
      key === oldName ? [newName, { ...value, ...patch }] : [key, value],
    ),
  );
  if (!Object.hasOwn(next.properties, newName))
    next.properties[newName] = patch;
  next.required = [
    ...new Set(
      (next.required || [])
        .filter((key) => key !== oldName)
        .concat(required ? [newName] : []),
    ),
  ];
  return next;
}

export function summarizeWorkflowChanges(before, after) {
  if (!before) return ["First published version"];
  const changes = [];
  for (const [key, label] of [
    ["name", "Name"],
    ["description", "Description"],
    ["agentId", "Agent"],
    ["goal", "Goal"],
    ["instructions", "Instructions"],
    ["inputSchema", "Starting form"],
    ["outputSchema", "Final result"],
  ]) {
    if (before[key] !== undefined && pretty(before[key]) !== pretty(after[key]))
      changes.push(label + " changed");
  }
  if (Array.isArray(before.steps)) {
    const old = new Map(before.steps.map((step) => [step.key, step]));
    for (const step of after.steps) {
      if (!old.has(step.key)) changes.push("Added step: " + step.name);
      else if (pretty(old.get(step.key)) !== pretty(step))
        changes.push("Updated step: " + step.name);
      old.delete(step.key);
    }
    for (const step of old.values()) changes.push("Removed step: " + step.name);
    if (
      pretty(before.steps.map((s) => s.key)) !==
        pretty(after.steps.map((s) => s.key)) &&
      before.steps.length === after.steps.length &&
      before.steps.every((s) => after.steps.some((a) => a.key === s.key))
    )
      changes.push("Step order changed");
  }
  return changes.length ? changes : ["No changes to the compared definition"];
}

export function exactTestRuns(versions, runs, workflowId, agentId, revision) {
  const ids = new Set(
    versions
      .filter(
        (v) =>
          v.workflowId === workflowId &&
          v.createdBy === `builder:${agentId}:draft-${revision}`,
      )
      .map((v) => v.id),
  );
  return runs.filter(
    (run) => run.status === "completed" && ids.has(run.workflowVersionId),
  );
}

function inputField(label, value, change, options = {}) {
  const control = h(options.multiline ? "textarea" : "input", {
    type: options.type || "text",
    disabled: !!options.disabled,
  });
  control.value = value ?? "";
  if (options.multiline) control.rows = options.rows || 5;
  if (options.min !== undefined) control.min = options.min;
  if (options.max !== undefined) control.max = options.max;
  control.addEventListener("input", () =>
    change(options.type === "number" ? Number(control.value) : control.value),
  );
  const field = h(
    "label",
    { class: "nx-field" },
    h("span", {}, label),
    control,
  );
  if (options.help) field.append(para(options.help));
  return field;
}

function choice(label, value, items, change, disabled = false) {
  const control = h("select", { disabled });
  for (const item of items)
    control.append(h("option", { value: String(item[0]) }, item[1]));
  control.value = value ?? "";
  control.addEventListener("change", () => change(control.value));
  return h("label", { class: "nx-field" }, h("span", {}, label), control);
}

function checkbox(label, value, change) {
  const control = h("input", { type: "checkbox" });
  control.checked = !!value;
  control.addEventListener("change", () => change(control.checked));
  return h("label", { class: "nxl-check" }, control, h("span", {}, label));
}

function disclosure(title, ...children) {
  return h(
    "details",
    { class: "nxl-disclosure" },
    h("summary", {}, title),
    ...children,
  );
}

function multiPicker(label, items, selected, change) {
  let ids = [...new Set(selected || [])];
  const root = h("div", { class: "nxl-picker" }),
    pills = h("div", { class: "nxl-pills" }),
    select = h("select", { "aria-label": "Add " + label.toLowerCase() });
  const draw = () => {
    select.replaceChildren(
      h("option", { value: "" }, "Add " + label.toLowerCase() + "…"),
      ...items
        .filter((i) => !ids.includes(i.id))
        .map((i) => h("option", { value: i.id }, i.name)),
    );
    pills.replaceChildren(
      ...ids.map((id) =>
        h(
          "span",
          { class: "nxl-pill" },
          items.find((i) => i.id === id)?.name || "Unavailable selection",
          button(
            "Remove",
            () => {
              ids = ids.filter((i) => i !== id);
              change(ids);
              draw();
            },
            {
              "aria-label":
                "Remove " +
                (items.find((i) => i.id === id)?.name ||
                  "unavailable selection"),
            },
          ),
        ),
      ),
    );
    if (!ids.length)
      pills.append(h("span", { class: "nx-muted nx-small" }, "None selected"));
  };
  select.addEventListener("change", () => {
    if (select.value) {
      ids.push(select.value);
      change(ids);
      draw();
    }
  });
  root.append(h("strong", {}, label), select, pills);
  draw();
  return root;
}

function schemaEditor(title, get, put, validators) {
  const root = card(h("h3", {}, title)),
    fields = h("div", { class: "nxl-schema-fields" }),
    raw = h("textarea", { "aria-label": title + " JSON schema", rows: 10 }),
    feedback = h("p", { class: "nx-error", role: "status" });
  let invalid = false;
  const validate = () => {
    if (invalid) throw Error(title + ": enter a valid JSON schema.");
  };
  validators.push(validate);
  const commit = (value) => {
    put(value);
    raw.value = pretty(value);
    invalid = false;
    feedback.textContent = "";
  };
  const draw = () => {
    const schema = get();
    fields.replaceChildren();
    raw.value = pretty(schema);
    if (
      schema.type !== "object" ||
      (schema.properties &&
        (typeof schema.properties !== "object" ||
          Array.isArray(schema.properties)))
    ) {
      fields.append(
        para(
          "This schema uses an advanced structure. Keep editing it below; it will be preserved.",
        ),
      );
      return;
    }
    for (const [name, definition] of Object.entries(schema.properties || {})) {
      const item = card();
      let key = name;
      const edit = (newKey, patch, required) => {
        try {
          const next = updateSchemaField(get(), key, newKey, patch, required);
          commit(next);
          key = newKey.trim();
        } catch (error) {
          feedback.textContent = error.message;
          invalid = true;
        }
      };
      const required = () => (get().required || []).includes(key);
      item.append(
        inputField("Field name", name, (value) => edit(value, {}, required())),
        choice(
          "Type",
          definition.type || "string",
          [
            ["string", "Text"],
            ["number", "Number"],
            ["integer", "Whole number"],
            ["boolean", "Yes / no"],
            ["array", "List"],
            ["object", "Group"],
          ],
          (value) => {
            const patch = { type: value };
            if (value === "array" && !definition.items)
              patch.items = { type: "string" };
            edit(key, patch, required());
          },
        ),
        inputField(
          "Label / description",
          definition.description || "",
          (value) => edit(key, { description: value }, required()),
        ),
        checkbox("Required", required(), (value) => edit(key, {}, value)),
      );
      if (
        definition.type === "string" &&
        (!definition.enum ||
          definition.enum.every((v) => typeof v === "string"))
      )
        item.append(
          inputField(
            "Choices (one per line, optional)",
            (definition.enum || []).join("\n"),
            (value) => {
              const next = clone(get()),
                prop = { ...next.properties[key] };
              if (value.trim())
                prop.enum = value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean);
              else delete prop.enum;
              next.properties[key] = prop;
              commit(next);
            },
            { multiline: true, rows: 2 },
          ),
        );
      item.append(
        button("Remove field", () => {
          const next = clone(get());
          delete next.properties[key];
          next.required = (next.required || []).filter((n) => n !== key);
          commit(next);
          draw();
        }),
      );
      fields.append(item);
    }
    fields.append(
      button("Add field", () => {
        let name = "field";
        let n = 1;
        while (Object.hasOwn(get().properties || {}, name))
          name = "field_" + ++n;
        commit(updateSchemaField(get(), null, name, { type: "string" }, false));
        draw();
      }),
    );
  };
  raw.value = pretty(get());
  raw.addEventListener("input", () => {
    try {
      const value = JSON.parse(raw.value);
      if (!value || Array.isArray(value) || typeof value !== "object")
        throw Error();
      put(value);
      invalid = false;
      feedback.textContent = "";
    } catch {
      put(get());
      invalid = true;
      feedback.textContent = "Enter a valid JSON schema object.";
    }
  });
  raw.addEventListener("change", () => {
    if (!invalid) draw();
  });
  root.append(fields, disclosure("Advanced schema", raw), feedback);
  draw();
  return root;
}

function outputSettings(config, changed) {
  const settings = clone(
    config.outputs || {
      presentation: "auto",
      artifacts: { mode: "manual", formats: [], instructions: "" },
    },
  );
  settings.artifacts = {
    mode: "manual",
    formats: [],
    instructions: "",
    ...settings.artifacts,
  };
  const commit = () => {
    config.outputs = settings;
    changed();
  };
  return card(
    h("h3", {}, "Presentation & artifacts"),
    para(
      "Choose how people read this result and which downloadable files may be produced.",
    ),
    choice(
      "Result presentation",
      settings.presentation || "auto",
      [
        ["auto", "Automatic report"],
        ["report", "Report"],
        ["cards", "Cards"],
        ["table", "Table"],
        ["diagram", "Diagram / sections"],
      ],
      (v) => {
        settings.presentation = v;
        commit();
      },
    ),
    choice(
      "Create files",
      settings.artifacts.mode,
      [
        ["manual", "On request"],
        ["always", "Always create selected formats"],
        ["model", "Let the model choose from selected formats"],
      ],
      (v) => {
        settings.artifacts.mode = v;
        commit();
      },
    ),
    multiPicker(
      "Formats",
      [
        { id: "pdf", name: "PDF report" },
        { id: "xlsx", name: "Spreadsheet" },
        { id: "pptx", name: "Slide deck" },
        { id: "png", name: "Infographic / diagram image" },
      ],
      settings.artifacts.formats,
      (v) => {
        settings.artifacts.formats = v;
        commit();
      },
    ),
    inputField(
      "Artifact instructions",
      settings.artifacts.instructions,
      (v) => {
        settings.artifacts.instructions = v;
        commit();
      },
      { multiline: true, rows: 3 },
    ),
  );
}

export async function renderLibrary(ctx) {
  const { root } = ctx,
    route = new URL(ctx.url, location.origin);
  let tab = sections.some((s) => s.key === route.searchParams.get("tab"))
    ? route.searchParams.get("tab")
    : "workflows";
  const [catalog, listing, chains] = await Promise.all([
    api("/builder/catalog"),
    api("/builder/workflows"),
    api("/engagement-templates"),
  ]);
  if (ctx.signal?.aborted) return;
  let org =
    route.searchParams.get("organization") ||
    catalog.organizations.find((o) => o.kind === "platform")?.id ||
    catalog.organizations[0]?.id ||
    "";
  let item = route.searchParams.get("item") || "",
    view = route.searchParams.get("view") || "overview",
    step = route.searchParams.get("step") || "";
  if (!route.searchParams.has("organization") && item)
    org =
      (tab === "workflows"
        ? listing.find((r) => r.workflow.id === item)?.workflow.organizationId
        : tab === "chains"
          ? chains.find((c) => c.id === item)?.organization_id
          : tab === "skills"
            ? catalog.skills.find((s) => s.skillId === item)?.organizationId
            : tab === "knowledge"
              ? catalog.knowledge.find((k) => k.id === item)?.organizationId
              : null) || org;
  let dirty = false,
    busy = false,
    validators = [],
    context = {},
    statusNode,
    detail = null,
    draft = null,
    skillEdit = null,
    referenceEdit = null,
    chainEdit = null;
  let versionDetail = null,
    tests = null,
    validation = null,
    publishReady = false,
    testForm = null,
    testInput = {};
  const owned = (object) =>
    !object.organizationId || object.organizationId === org;
  const skills = () =>
    catalog.skills.filter(
      (s) =>
        s.executionType === "agent" &&
        (!s.organizationId ||
          s.organizationId === org ||
          catalog.organizations.find((o) => o.id === s.organizationId)?.kind ===
            "platform"),
    );
  const linkTo = (section, id = "", params = {}) => {
    const u = new URL("/next/library", location.origin);
    u.searchParams.set("tab", section);
    if (org) u.searchParams.set("organization", org);
    if (id) u.searchParams.set("item", id);
    for (const [key, value] of Object.entries(params))
      if (value) u.searchParams.set(key, value);
    return u.pathname + u.search;
  };
  const updateContext = () => {
    const selectedStep = context.workflowStepId
      ? draft?.steps.find((s) => s.key === context.workflowStepId)
      : null;
    const label = draft
      ? [
          draft.name,
          selectedStep?.name,
          "Draft revision " + detail.draft.revision,
        ]
          .filter(Boolean)
          .join(" → ")
      : context.label || "Library";
    setContext({
      scope: "library",
      organizationId: org,
      ...context,
      label,
      unsaved: dirty,
    });
  };
  const changed = () => {
    dirty = true;
    validation = null;
    publishReady = false;
    if (statusNode) statusNode.textContent = "Unsaved changes";
    context.label =
      skillEdit?.name ||
      referenceEdit?.name ||
      chainEdit?.name ||
      context.label;
    updateContext();
  };
  guardUnsaved(() => dirty, ctx);
  const localView = (value, selectedStep = step) => {
    try {
      check();
    } catch (error) {
      notify(error.message, "error");
      return;
    }
    view = value;
    step = selectedStep;
    route.searchParams.set("view", view);
    if (step) route.searchParams.set("step", step);
    else route.searchParams.delete("step");
    history.replaceState(history.state, "", route);
    drawDetail();
  };
  const check = () => {
    for (const validate of validators) validate();
    for (const input of root.querySelectorAll("input,textarea,select"))
      if (!input.closest(".nxl-sample") && !input.checkValidity()) {
        input.reportValidity();
        throw Error("Check the highlighted field.");
      }
  };
  const perform = (fn) => async () => {
    if (busy || ctx.signal?.aborted) return;
    try {
      check();
    } catch (error) {
      notify(error.message, "error");
      return;
    }
    busy = true;
    const disabled = [
      ...root.querySelectorAll("button,input,select,textarea"),
    ].map((n) => [n, n.disabled]);
    disabled.forEach(([n]) => (n.disabled = true));
    try {
      await fn();
    } catch (error) {
      notify(error.message || String(error), "error");
    } finally {
      busy = false;
      disabled.forEach(([n, old]) => (n.disabled = old));
    }
  };
  const saveDraft = async () => {
    if (!dirty) return;
    const result = await api("/builder/workflows/" + item, {
      method: "PUT",
      body: { revision: detail.draft.revision, definition: draft },
    });
    detail = { ...detail, ...result };
    dirty = false;
    validation = null;
    context.draftRevision = detail.draft.revision;
    updateContext();
    notify("Draft saved.");
  };
  const reload = () => navigate(linkTo(tab, item, { view, step }));
  const header = h(
    "header",
    { class: "nx-page-head" },
    h(
      "div",
      {},
      h(
        "p",
        { class: "nx-muted nx-small" },
        "Reusable processes and capabilities",
      ),
      h("h1", {}, "Library"),
    ),
  );
  header.append(
    choice(
      "Organization",
      org,
      catalog.organizations.map((o) => [o.id, o.name]),
      (value) => {
        const next = new URL(linkTo(tab), location.origin);
        next.searchParams.set("organization", value);
        navigate(next.pathname + next.search);
      },
    ),
  );
  root.append(
    header,
    tabs(sections, tab, (key) => navigate(linkTo(key))),
  );
  const content = h("div", { class: "nxl-content" });
  root.append(content);
  if (!org) {
    content.append(
      empty(
        "No organization available",
        "Create an organization in the existing workspace to begin authoring.",
      ),
    );
    return;
  }

  if (tab === "workflows" && item && item !== "new") {
    detail = await api("/builder/workflows/" + item);
    draft = clone(detail.draft.definition);
    if (detail.workflow.organizationId !== org) {
      navigate(linkTo(tab));
      return;
    }
  }
  if (ctx.signal?.aborted) return;

  function searchIndex(items, makeRow, placeholder) {
    const list = h("div", { class: "nx-list" }),
      query = h("input", {
        type: "search",
        placeholder,
        "aria-label": placeholder,
      });
    const render = () => {
      const q = query.value.toLowerCase().trim(),
        shown = items.filter((i) =>
          (i.name + " " + (i.description || "")).toLowerCase().includes(q),
        );
      list.replaceChildren(...shown.map(makeRow));
      if (!shown.length)
        list.append(
          empty(
            "No matching items",
            q ? "Try a different search." : "Create an item to get started.",
          ),
        );
    };
    query.addEventListener("input", render);
    render();
    return h("div", { class: "nxl-index" }, query, list);
  }

  function indexRow(name, description, href, ...tags) {
    return h(
      "article",
      { class: "nxl-index-row" },
      h("div", {}, link(name, href), description ? para(description) : null),
      row(...tags),
    );
  }
  function creator(label, onCreate) {
    let name = "";
    return disclosure(
      label,
      inputField("Name", "", (v) => (name = v)),
      button(
        "Create",
        perform(async () => {
          if (!name.trim()) throw Error("Give this item a name.");
          await onCreate(name.trim());
        }),
        { primary: true },
      ),
    );
  }
  function drawIndex() {
    context = {
      label: "Library · " + sections.find((s) => s.key === tab).label,
    };
    updateContext();
    content.replaceChildren();
    if (tab === "workflows") {
      content.append(
        creator("New workflow", async (name) => {
          const r = await api("/builder/workflows", {
            method: "POST",
            body: { organizationId: org, name },
          });
          navigate(linkTo(tab, r.workflow.id));
        }),
        searchIndex(
          listing
            .filter((r) => r.workflow.organizationId === org)
            .map((r) => ({
              ...r,
              name: r.draft?.definition?.name || r.workflow.name,
              description: r.workflow.description,
            })),
          (r) =>
            indexRow(
              r.name,
              r.description,
              linkTo(tab, r.workflow.id),
              badge(r.workflow.currentVersionId ? "Published" : "Draft"),
              r.draft && r.draft.publishedRevision !== r.draft.revision
                ? badge("Draft changes", "warning")
                : null,
            ),
          "Find a workflow",
        ),
      );
    } else if (tab === "chains") {
      content.append(
        actions(link("New chain", linkTo(tab, "new"))),
        para(
          "Connect published workflows. Each stage requires approval before the next begins.",
        ),
        searchIndex(
          chains.filter((c) => c.organization_id === org),
          (c) =>
            indexRow(
              c.name,
              (c.stages || []).map((s) => s.name).join(" → "),
              linkTo(tab, c.id),
              badge((c.stages || []).length + " stages"),
            ),
          "Find a chain",
        ),
      );
    } else if (tab === "skills") {
      content.append(
        actions(link("New skill", linkTo(tab, "new"))),
        searchIndex(
          groupedSkills(skills()).map((versions) => ({
            ...versions[0],
            versions,
          })),
          (s) =>
            indexRow(
              s.name,
              s.description,
              linkTo(tab, s.skillId),
              badge("v" + s.version),
              badge(s.versions.length + " versions"),
            ),
          "Find a skill",
        ),
      );
    } else if (tab === "knowledge") {
      content.append(
        actions(link("Add reference", linkTo(tab, "new"))),
        para(
          "Reusable reference material for skills. Customer research remains connected to its organization and source history.",
        ),
        searchIndex(
          catalog.knowledge.filter(owned),
          (k) =>
            indexRow(
              k.name,
              (k.content || "").slice(0, 160),
              linkTo(tab, k.id),
              badge(
                k.type === "repository" ? "Organization record" : "Reference",
              ),
            ),
          "Find reference knowledge",
        ),
      );
    } else {
      content.append(
        para(
          "Capabilities supplied by the engine. Select a tool to inspect its purpose, contract and dependent skills.",
        ),
        searchIndex(
          catalog.tools,
          (t) =>
            indexRow(
              t.name,
              t.description,
              linkTo(tab, t.id),
              badge("Registered"),
            ),
          "Find a tool",
        ),
        card(
          h("h3", {}, "Presentation & files"),
          para(
            "Reports, tables, diagrams and downloadable files are configured on workflow steps and skills.",
          ),
          link("Browse workflows", linkTo("workflows")),
        ),
      );
    }
  }

  function detailHead(title, subtitle, ...tools) {
    const head = h(
      "div",
      { class: "nx-page-head nxl-detail-head" },
      h(
        "div",
        {},
        link("← " + sections.find((s) => s.key === tab).label, linkTo(tab)),
        h("h2", {}, title),
        subtitle ? para(subtitle) : null,
      ),
    );
    statusNode = h(
      "span",
      { class: "nx-status", role: "status" },
      dirty ? "Unsaved changes" : "Saved",
    );
    head.append(actions(statusNode, ...tools));
    return head;
  }
  function renderWorkflow() {
    context = {
      kind: "workflow",
      id: item,
      workflowId: item,
      label: draft.name,
      draftRevision: detail.draft.revision,
      workflowStepId:
        view === "steps" ? step || draft.steps[0]?.key : undefined,
    };
    updateContext();
    content.append(
      detailHead(
        draft.name,
        "Draft revision " + detail.draft.revision,
        button(
          "Save draft",
          perform(async () => {
            await saveDraft();
            drawDetail();
          }),
          { primary: true },
        ),
        button("Reload", reload),
      ),
    );
    content.append(
      tabs(
        [
          { key: "overview", label: "Purpose" },
          { key: "steps", label: "Steps" },
          { key: "forms", label: "Inputs & outputs" },
          { key: "tests", label: "Test & versions" },
        ],
        view,
        (value) => localView(value),
      ),
    );
    if (view === "steps") renderSteps();
    else if (view === "forms") renderWorkflowForms();
    else if (view === "tests") renderTests();
    else {
      content.append(
        card(
          inputField("Name", draft.name, (v) => {
            draft.name = v;
            changed();
          }),
          inputField("Description", draft.description, (v) => {
            draft.description = v;
            changed();
          }),
          inputField(
            "Goal",
            draft.goal,
            (v) => {
              draft.goal = v;
              changed();
            },
            {
              multiline: true,
              help: "Describe the result the customer should receive.",
            },
          ),
          inputField(
            "Instructions / process",
            draft.instructions,
            (v) => {
              draft.instructions = v;
              changed();
            },
            { multiline: true, rows: 8 },
          ),
          choice(
            "Agent",
            draft.agentId,
            catalog.agents
              .filter((a) => a.organizationId === org)
              .map((a) => [a.id, a.name]),
            (v) => {
              draft.agentId = v;
              changed();
            },
          ),
          checkbox(
            "Add completed findings to organization knowledge",
            draft.steps.some((s) => s.configuration.captureKnowledge),
            (value) => {
              for (const s of draft.steps)
                delete s.configuration.captureKnowledge;
              if (draft.steps[0])
                draft.steps[0].configuration.captureKnowledge = value;
              changed();
            },
          ),
          para(
            "Knowledge capture needs at least one step. Published versions and existing runs remain unchanged while you edit.",
          ),
        ),
      );
      content.append(
        actions(
          button("Design steps", () => localView("steps")),
          button(
            "Duplicate workflow",
            perform(async () => {
              await saveDraft();
              const r = await api("/builder/workflows", {
                method: "POST",
                body: {
                  organizationId: org,
                  name: draft.name + " copy",
                  duplicateId: item,
                },
              });
              navigate(linkTo(tab, r.workflow.id));
            }),
          ),
        ),
      );
    }
  }

  function renderSteps() {
    if (!draft.steps.some((s) => s.key === step))
      step = draft.steps[0]?.key || "";
    context.workflowStepId = step || undefined;
    updateContext();
    const outline = h("nav", {
        class: "nxl-step-outline",
        "aria-label": "Workflow steps",
      }),
      editor = h("div", { class: "nxl-step-editor" });
    const selected = draft.steps.find((s) => s.key === step);
    draft.steps.forEach((s, i) =>
      outline.append(
        button(i + 1 + ". " + s.name, () => localView("steps", s.key), {
          "aria-current": s.key === step ? "step" : undefined,
          class: s.key === step ? "nxl-selected" : "",
        }),
      ),
    );
    const add = (type) => {
      const key =
          "step_" + crypto.randomUUID().replaceAll("-", "").slice(0, 10),
        names = {
          agent_loop: "Agent task",
          skill: "Fixed skill",
          human_review: "Human approval",
        };
      draft.steps.push({
        key,
        name: names[type],
        type,
        skillVersionId: null,
        configuration:
          type === "human_review"
            ? { inputFrom: "previous", outputMode: "input" }
            : {
                provider: "openai",
                model: "gpt-4.1-mini",
                goal: "",
                inputFrom: "previous",
                skillVersionIds: [],
                maxTurns: 12,
                maxToolCalls: 8,
                maxSkillSelections: 4,
                allowHumanQuestions: true,
                allowHumanReview: false,
                outputSchema: { type: "object" },
              },
      });
      changed();
      localView("steps", key);
    };
    outline.append(
      disclosure(
        "Add a step",
        button("Agent task", () => add("agent_loop")),
        button("Fixed skill", () => add("skill")),
        button("Human approval", () => add("human_review")),
      ),
    );
    content.append(h("div", { class: "nxl-step-layout" }, outline, editor));
    if (!selected) {
      editor.append(
        empty(
          "Add the first step",
          "Choose an agent task, a fixed skill or a human checkpoint.",
        ),
      );
      return;
    }
    const s = selected,
      c = s.configuration,
      index = draft.steps.indexOf(s);
    const move = (delta) => {
      [draft.steps[index], draft.steps[index + delta]] = [
        draft.steps[index + delta],
        draft.steps[index],
      ];
      changed();
      drawDetail();
    };
    editor.append(
      row(
        badge(
          s.type === "agent_loop"
            ? "Agent task"
            : s.type === "skill"
              ? "Fixed skill"
              : "Human approval",
        ),
        button("Move up", () => move(-1), { disabled: index === 0 }),
        button("Move down", () => move(1), {
          disabled: index === draft.steps.length - 1,
        }),
        button("Remove step", () => {
          if (!window.confirm("Remove “" + s.name + "” from this draft?"))
            return;
          draft.steps.splice(index, 1);
          changed();
          step = "";
          drawDetail();
        }),
      ),
    );
    editor.append(
      card(
        inputField("Step name", s.name, (v) => {
          s.name = v;
          changed();
        }),
        choice(
          "Receives",
          c.inputFrom || "previous",
          [
            ["previous", "Previous step result"],
            ["initial", "Starting form"],
            ["context", "All prior results"],
            ...draft.steps
              .slice(0, index)
              .map((p) => ["steps." + p.key, p.name]),
          ],
          (v) => {
            c.inputFrom = v;
            changed();
          },
        ),
      ),
    );
    if (s.type === "human_review")
      editor.append(
        card(
          h("h3", {}, "Human checkpoint"),
          para(
            "Execution pauses with this step’s input available to the reviewer. Approval continues the run; revision and stop remain distinct decisions.",
          ),
          choice(
            "Pass forward after approval",
            c.outputMode || "review",
            [
              ["input", "Reviewed input unchanged"],
              ["review", "Reviewed input, approval and note"],
            ],
            (v) => {
              c.outputMode = v;
              changed();
            },
          ),
        ),
      );
    else {
      editor.append(
        card(
          inputField(
            "What should this step accomplish?",
            c.goal || "",
            (v) => {
              c.goal = v;
              changed();
            },
            { multiline: true },
          ),
          s.type === "skill"
            ? choice(
                "Required skill version",
                s.skillVersionId || "",
                [
                  ["", "Choose a skill"],
                  ...skills().map((k) => [k.id, k.name + " · v" + k.version]),
                ],
                (v) => {
                  s.skillVersionId = v || null;
                  changed();
                },
              )
            : multiPicker(
                "Skills the model may choose",
                skills().map((k) => ({
                  id: k.id,
                  name: k.name + " · v" + k.version,
                })),
                c.skillVersionIds || [],
                (v) => {
                  c.skillVersionIds = v;
                  changed();
                },
              ),
          checkbox(
            "May ask a human a question",
            c.allowHumanQuestions !== false,
            (v) => {
              c.allowHumanQuestions = v;
              changed();
            },
          ),
          checkbox("May request human approval", !!c.allowHumanReview, (v) => {
            c.allowHumanReview = v;
            changed();
          }),
        ),
      );
      editor.append(
        schemaEditor(
          "Expected result",
          () => c.outputSchema || { type: "object" },
          (v) => {
            c.outputSchema = v;
            changed();
          },
          validators,
        ),
      );
      editor.append(
        disclosure(
          "Advanced execution settings",
          inputField("OpenAI model", c.model || "gpt-4.1-mini", (v) => {
            c.model = v;
            changed();
          }),
          ...[
            ["maxTurns", "Maximum model turns", 12],
            ["maxToolCalls", "Maximum tool calls", 8],
            ["maxSkillSelections", "Maximum skill selections", 4],
          ].map(([key, label, def]) =>
            inputField(
              label,
              c[key] ?? def,
              (v) => {
                c[key] = v;
                changed();
              },
              { type: "number", min: 1 },
            ),
          ),
          jsonDetails(
            { key: s.key, provider: c.provider || "openai" },
            "Step identifiers",
          ),
        ),
      );
    }
    editor.append(outputSettings(c, changed));
  }

  function renderWorkflowForms() {
    content.append(
      schemaEditor(
        "Starting form",
        () => draft.inputSchema,
        (v) => {
          draft.inputSchema = v;
          changed();
        },
        validators,
      ),
      schemaEditor(
        "Final result",
        () => draft.outputSchema,
        (v) => {
          draft.outputSchema = v;
          changed();
        },
        validators,
      ),
    );
    const preview = card(h("h3", {}, "Starting form preview")),
      holder = h("div", { class: "nxl-sample" });
    const show = () => {
      try {
        holder.replaceChildren(schemaForm(draft.inputSchema, {}).element);
      } catch (error) {
        holder.replaceChildren(para(error.message));
      }
    };
    preview.append(button("Refresh preview", show), holder);
    show();
    content.append(preview);
    content.append(
      para(
        "Presentation and downloadable files are configured on each step and reusable skill. Preview real results after a test run.",
      ),
    );
  }

  async function loadTests() {
    const rows = await api("/workflows/" + item + "/runs");
    tests = await Promise.all(
      rows.map(async (run) => {
        try {
          return await api("/runs/" + run.id);
        } catch {
          return run;
        }
      }),
    );
  }
  async function loadVersion(versionId) {
    const response = await api(
      "/builder/workflows/" + item + "/versions/" + versionId,
    );
    const v = response.version || response;
    return {
      ...v,
      instructions: v.sopMarkdown,
      steps: (response.steps || []).map(
        ({ key, name, type, skillVersionId, configuration }) => {
          const config = { ...configuration };
          delete config.builderAgentId;
          return { key, name, type, skillVersionId, configuration: config };
        },
      ),
    };
  }
  function renderTests() {
    testForm = schemaForm(draft.inputSchema, testInput);
    testForm.element.classList.add("nxl-sample");
    testForm.element.addEventListener("input", () => {
      try {
        testInput = testForm.read();
      } catch {}
    });
    const testCard = card(
      h("h3", {}, "Try this draft"),
      para(
        "Test a fixed copy of the saved draft. Test runs use the configured model and tools; publishing remains a separate action.",
      ),
      testForm.element,
      actions(
        button(
          "Validate draft",
          perform(async () => {
            await saveDraft();
            await api("/builder/workflows/" + item + "/validate", {
              method: "POST",
              body: { revision: detail.draft.revision },
            });
            validation = detail.draft.revision;
            notify("This saved revision is valid.");
            drawDetail();
          }),
        ),
        button(
          "Start test",
          () => {
            testInput = testForm.read();
            return perform(async () => {
              await saveDraft();
              const result = await api("/builder/workflows/" + item + "/test", {
                method: "POST",
                body: { revision: detail.draft.revision, input: testInput },
              });
              navigate("/next/run?workflow=" + item + "&run=" + result.run.id);
            })();
          },
          { primary: true },
        ),
      ),
    );
    content.append(testCard);
    const publication = card(
      h("h3", {}, "Publish a version"),
      para(
        "Publishing makes this version available to new runs. Existing runs keep their original version.",
      ),
      button(
        "Review publication",
        perform(async () => {
          await saveDraft();
          const reviewedRevision = detail.draft.revision;
          await api("/builder/workflows/" + item + "/validate", {
            method: "POST",
            body: { revision: reviewedRevision },
          });
          validation = reviewedRevision;
          await loadTests();
          const refreshed = await api("/builder/workflows/" + item);
          if (refreshed.draft.revision !== reviewedRevision)
            throw Error(
              "The draft changed while preparing publication. Reload and review the new revision before publishing.",
            );
          detail = refreshed;
          versionDetail = detail.workflow.currentVersionId
            ? await loadVersion(detail.workflow.currentVersionId)
            : null;
          if (versionDetail) {
            versionDetail.name = detail.workflow.name;
            versionDetail.description = detail.workflow.description;
          }
          publishReady = true;
          drawDetail();
        }),
      ),
    );
    if (publishReady && !dirty) {
      publication.append(
        badge("Validated revision " + detail.draft.revision, "success"),
        h(
          "ul",
          {},
          ...summarizeWorkflowChanges(versionDetail, draft).map((c) =>
            h("li", {}, c),
          ),
        ),
      );
      const matches = exactTestRuns(
          detail.versions,
          tests || [],
          item,
          draft.agentId,
          detail.draft.revision,
        ),
        tested = matches[0];
      publication.append(
        para(
          tested
            ? "A completed test matches this exact saved draft."
            : "No matching completed test was found among recent runs for this saved revision. Publishing without one is allowed.",
        ),
      );
      if (tested)
        publication.append(
          link(
            "Inspect matching test",
            "/next/run?workflow=" + item + "&run=" + tested.id,
          ),
        );
      publication.append(
        button(
          tested
            ? "Publish tested version"
            : "Publish without a completed test",
          perform(async () => {
            const revision = detail.draft.revision;
            const result = await api(
              "/builder/workflows/" + item + "/publish",
              {
                method: "POST",
                body: {
                  revision,
                  ...(tested ? { testedRunId: tested.id } : {}),
                },
              },
            );
            notify(
              result.alreadyPublished
                ? "This revision is already published."
                : "Published version " + result.version + ".",
            );
            dirty = false;
            reload();
          }),
          { primary: true },
        ),
      );
    }
    content.append(publication);
    const history = card(
      h("h3", {}, "Versions & test snapshots"),
      para(
        "The current published release is available for new runs. Other immutable snapshots may be former releases or draft tests.",
      ),
      button(
        "Load recent tests",
        perform(async () => {
          await loadTests();
          drawDetail();
        }),
      ),
    );
    for (const v of detail.versions || []) {
      const associated = (tests || []).filter(
        (r) => r.workflowVersionId === v.id,
      );
      const entry = card(
        row(
          h("strong", {}, "Version " + v.version),
          badge(
            v.id === detail.workflow.currentVersionId
              ? "Published release"
              : associated.length
                ? "Snapshot with runs"
                : "Saved snapshot",
          ),
        ),
        para(time(v.createdAt)),
        button(
          "Inspect version",
          perform(async () => {
            const data = await loadVersion(v.id);
            entry.append(
              card(
                h("h4", {}, "Goal"),
                h("p", {}, data.goal),
                h("h4", {}, "Instructions"),
                h("pre", { class: "nxl-readable" }, data.instructions),
                h("ol", {}, ...data.steps.map((s) => h("li", {}, s.name))),
                jsonDetails(data, "Complete version snapshot"),
              ),
            );
          }),
        ),
      );
      for (const r of associated)
        entry.append(
          row(
            link(
              "Test / run · " + time(r.createdAt),
              "/next/run?workflow=" + item + "&run=" + r.id,
            ),
            badge(r.status),
          ),
        );
      history.append(entry);
    }
    if (!(detail.versions || []).length)
      history.append(
        para(
          "No snapshots yet. Test or publish the saved draft to create one.",
        ),
      );
    content.append(history);
  }

  function renderChain() {
    const original = chains.find(
      (c) => c.id === item && c.organization_id === org,
    );
    if (item !== "new" && !original) {
      content.append(
        empty(
          "Chain not found",
          "Choose a chain belonging to this organization.",
        ),
      );
      return;
    }
    chainEdit ||= original
      ? clone(original)
      : {
          name: "New chain",
          stages: [
            { name: "Understand", workflowId: "" },
            { name: "Research", workflowId: "" },
            { name: "Proposal", workflowId: "" },
            { name: "Product", workflowId: "" },
          ],
        };
    context = {
      kind: "chain",
      id: original?.id,
      chainId: original?.id,
      label: chainEdit.name,
      draftRevision: original?.revision,
    };
    updateContext();
    content.append(
      detailHead(
        chainEdit.name,
        original ? "Saved revision " + original.revision : "New chain",
        button(
          "Save chain",
          perform(async () => {
            const saved = await api("/engagement-templates", {
              method: "POST",
              body: {
                ...(original
                  ? { id: original.id, revision: original.revision }
                  : {}),
                organizationId: org,
                name: chainEdit.name,
                stages: chainEdit.stages,
              },
            });
            dirty = false;
            notify("Chain saved.");
            navigate(linkTo(tab, saved.id));
          }),
          { primary: true },
        ),
      ),
      card(
        inputField("Chain name", chainEdit.name, (v) => {
          chainEdit.name = v;
          changed();
        }),
        para(
          "Each stage requires approval before the next starts. Starting an engagement pins the then-current published workflow versions. Existing engagements retain their pinned versions.",
        ),
      ),
    );
    const available = listing
      .map((r) => r.workflow)
      .filter(
        (w) =>
          w.currentVersionId &&
          (w.organizationId === org ||
            catalog.organizations.find((o) => o.id === w.organizationId)
              ?.kind === "platform"),
      );
    chainEdit.stages.forEach((stage, index) => {
      const selected = available.find((w) => w.id === stage.workflowId),
        move = (delta) => {
          [chainEdit.stages[index], chainEdit.stages[index + delta]] = [
            chainEdit.stages[index + delta],
            chainEdit.stages[index],
          ];
          changed();
          drawDetail();
        };
      content.append(
        card(
          row(badge("Stage " + (index + 1)), h("h3", {}, stage.name)),
          inputField("Stage name", stage.name, (v) => {
            stage.name = v;
            changed();
          }),
          choice(
            "Published workflow",
            stage.workflowId,
            [
              ["", "Choose a workflow"],
              ...available.map((w) => [w.id, w.name]),
            ],
            (v) => {
              stage.workflowId = v;
              changed();
              drawDetail();
            },
          ),
          selected
            ? link(
                "Inspect " + selected.name,
                linkTo("workflows", selected.id, {
                  organization: selected.organizationId,
                }),
              )
            : null,
          para(
            index
              ? "Receives the starting inputs, previous approved-stage result and attributed feedback."
              : "Begins with the engagement’s starting form.",
          ),
          actions(
            button("Move up", () => move(-1), { disabled: index === 0 }),
            button("Move down", () => move(1), {
              disabled: index === chainEdit.stages.length - 1,
            }),
            button(
              "Remove stage",
              () => {
                chainEdit.stages.splice(index, 1);
                changed();
                drawDetail();
              },
              { disabled: chainEdit.stages.length === 1 },
            ),
          ),
        ),
      );
    });
    content.append(
      button(
        "Add stage",
        () => {
          chainEdit.stages.push({ name: "New stage", workflowId: "" });
          changed();
          drawDetail();
        },
        { disabled: chainEdit.stages.length >= 12 },
      ),
    );
  }

  function renderSkill() {
    const versions = skills()
      .filter((s) => s.skillId === item)
      .sort((a, b) => b.version - a.version);
    const selected =
      versions.find((s) => s.id === route.searchParams.get("version")) ||
      versions[0];
    if (item !== "new" && !selected) {
      content.append(
        empty("Skill not found", "Choose a skill in this catalog."),
      );
      return;
    }
    if (item === "new" && !skillEdit)
      skillEdit = {
        organizationId: org,
        name: "New skill",
        description: "",
        instructions: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        configuration: { allowedToolIds: [], allowedKnowledgeIds: [] },
      };
    const s = skillEdit || selected;
    context = {
      kind: "skill",
      id: selected?.skillId,
      skillVersionId: selected?.id,
      version: selected?.version,
      label: s.name,
    };
    updateContext();
    content.append(
      detailHead(
        s.name,
        skillEdit
          ? "Editing a new immutable version"
          : "Version " + selected.version,
        skillEdit
          ? button(
              "Save skill version",
              perform(async () => {
                const saved = await api("/builder/skills", {
                  method: "POST",
                  body: skillEdit,
                });
                dirty = false;
                notify(
                  "Skill version saved. Existing workflows keep their pinned versions.",
                );
                navigate(linkTo(tab, saved.skillId, { version: saved.id }));
              }),
              { primary: true },
            )
          : selected.organizationId === org
            ? button(
                "Create new version",
                () => {
                  skillEdit = {
                    organizationId: org,
                    skillId: selected.skillId,
                    name: selected.name,
                    description: selected.description,
                    instructions: selected.instructions,
                    inputSchema: clone(selected.inputSchema),
                    outputSchema: clone(selected.outputSchema),
                    configuration: clone(selected.configuration),
                  };
                  drawDetail();
                },
                { primary: true },
              )
            : null,
      ),
    );
    if (skillEdit) {
      content.append(
        card(
          inputField(
            "Name",
            s.name,
            (v) => {
              s.name = v;
              changed();
            },
            { disabled: !!s.skillId },
          ),
          inputField(
            "Description",
            s.description,
            (v) => {
              s.description = v;
              changed();
            },
            { disabled: !!s.skillId },
          ),
          inputField(
            "Instructions",
            s.instructions,
            (v) => {
              s.instructions = v;
              changed();
            },
            { multiline: true, rows: 10 },
          ),
        ),
        schemaEditor(
          "Skill inputs",
          () => s.inputSchema,
          (v) => {
            s.inputSchema = v;
            changed();
          },
          validators,
        ),
        schemaEditor(
          "Skill result",
          () => s.outputSchema,
          (v) => {
            s.outputSchema = v;
            changed();
          },
          validators,
        ),
        card(
          h("h3", {}, "Capabilities"),
          multiPicker(
            "Allowed tools",
            catalog.tools,
            s.configuration.allowedToolIds,
            (v) => {
              s.configuration.allowedToolIds = v;
              s.configuration.requiredToolIds = (
                s.configuration.requiredToolIds || []
              ).filter((id) => v.includes(id));
              changed();
            },
          ),
          multiPicker(
            "Allowed knowledge",
            catalog.knowledge.filter(owned),
            s.configuration.allowedKnowledgeIds,
            (v) => {
              s.configuration.allowedKnowledgeIds = v;
              s.configuration.requiredKnowledgeIds = (
                s.configuration.requiredKnowledgeIds || []
              ).filter((id) => v.includes(id));
              changed();
            },
          ),
          para(
            "Only selected capabilities may be used. Existing tool configuration and required selections remain preserved unless a capability is removed.",
          ),
        ),
        outputSettings(s.configuration, changed),
      );
    } else {
      content.append(
        card(
          h("p", {}, selected.description),
          h("h3", {}, "Instructions"),
          h("pre", { class: "nxl-readable" }, selected.instructions),
        ),
        card(
          h("h3", {}, "Capabilities"),
          h(
            "ul",
            {},
            ...(selected.configuration.allowedToolIds || []).map((id) =>
              h(
                "li",
                {},
                link(
                  catalog.tools.find((t) => t.id === id)?.name ||
                    "Unavailable tool",
                  linkTo("tools", id),
                ),
              ),
            ),
            ...(selected.configuration.allowedKnowledgeIds || []).map((id) =>
              h(
                "li",
                {},
                link(
                  catalog.knowledge.find((k) => k.id === id)?.name ||
                    "Unavailable reference",
                  linkTo("knowledge", id),
                ),
              ),
            ),
          ),
          jsonDetails(
            {
              input: selected.inputSchema,
              output: selected.outputSchema,
              configuration: selected.configuration,
            },
            "Contracts & output settings",
          ),
        ),
      );
      content.append(
        card(
          h("h3", {}, "Used in workflow drafts"),
          ...workflowUsage(selected.id),
        ),
      );
      content.append(
        card(
          h("h3", {}, "Version history"),
          ...versions.map((v) =>
            row(
              link(
                "Version " + v.version,
                linkTo(tab, item, { version: v.id }),
              ),
              v.id === selected.id ? badge("Selected") : null,
            ),
          ),
          para("Choose a version explicitly in a workflow draft to adopt it."),
        ),
      );
    }
  }
  function workflowUsage(skillId) {
    const used = listing.filter(
      (r) =>
        r.workflow.organizationId === org &&
        r.draft?.definition.steps.some(
          (s) =>
            s.skillVersionId === skillId ||
            (s.configuration.skillVersionIds || []).includes(skillId),
        ),
    );
    return used.length
      ? used.map((r) =>
          link(r.draft.definition.name, linkTo("workflows", r.workflow.id)),
        )
      : [
          para(
            "No saved draft in this organization currently selects this version. Published snapshots may still use it.",
          ),
        ];
  }
  function renderReference() {
    const selected = catalog.knowledge.find((k) => k.id === item && owned(k));
    if (item !== "new" && !selected) {
      content.append(
        empty(
          "Reference not found",
          "Choose reference knowledge belonging to this organization.",
        ),
      );
      return;
    }
    if (item === "new" && !referenceEdit)
      referenceEdit = {
        organizationId: org,
        name: "New reference",
        content: "",
      };
    const data = referenceEdit || selected;
    context = {
      kind: "knowledge",
      id: selected?.id,
      knowledgeId: selected?.id,
      label: data.name,
    };
    updateContext();
    content.append(
      detailHead(
        data.name,
        selected?.type === "repository"
          ? "Organization record · source history preserved"
          : "Reusable reference knowledge",
        referenceEdit
          ? button(
              "Save reference",
              perform(async () => {
                const saved = await api("/builder/knowledge", {
                  method: "POST",
                  body: referenceEdit,
                });
                dirty = false;
                notify("Reference saved.");
                navigate(linkTo(tab, saved.id));
              }),
              { primary: true },
            )
          : selected.type !== "repository"
            ? button(
                "Edit reference",
                () => {
                  referenceEdit = {
                    id: selected.id,
                    organizationId: org,
                    name: selected.name,
                    content: selected.content,
                  };
                  drawDetail();
                },
                { primary: true },
              )
            : link(
                "Open in Organizations",
                "/next/organizations?organization=" +
                  org +
                  "&view=knowledge&document=" +
                  selected.id,
              ),
      ),
    );
    if (referenceEdit)
      content.append(
        card(
          inputField("Name", data.name, (v) => {
            data.name = v;
            changed();
          }),
          inputField(
            "Content",
            data.content,
            (v) => {
              data.content = v;
              changed();
            },
            { multiline: true, rows: 18 },
          ),
          para(
            "New runs can retrieve the updated reference. Existing execution snapshots keep their recorded content.",
          ),
        ),
      );
    else
      content.append(
        card(output(data.content)),
        card(
          h("h3", {}, "Used by skills"),
          ...groupedSkills(skills())
            .filter((versions) =>
              versions.some((s) =>
                (s.configuration.allowedKnowledgeIds || []).includes(
                  selected.id,
                ),
              ),
            )
            .map((versions) =>
              link(versions[0].name, linkTo("skills", versions[0].skillId)),
            ),
        ),
      );
  }
  function renderTool() {
    const selected = catalog.tools.find((t) => t.id === item);
    if (!selected) {
      content.append(empty("Tool not found", "Choose a registered tool."));
      return;
    }
    context = {
      kind: "tool",
      id: selected.id,
      toolId: selected.id,
      label: selected.name,
    };
    updateContext();
    const users = groupedSkills(skills()).filter((versions) =>
      versions.some((s) =>
        (s.configuration.allowedToolIds || []).includes(selected.id),
      ),
    );
    content.append(
      detailHead(selected.name, "Registered engine capability"),
      card(
        h("p", {}, selected.description),
        badge("Registered"),
        para(
          "Registration confirms this capability is in the catalog. Connection health and credentials are not reported by this endpoint. Skills must explicitly grant access before use.",
        ),
      ),
      card(
        h("h3", {}, "Used by skills"),
        ...(users.length
          ? users.map((versions) =>
              link(versions[0].name, linkTo("skills", versions[0].skillId)),
            )
          : [para("No skill in this catalog currently grants this tool.")]),
      ),
      jsonDetails(
        {
          handler: selected.handler,
          input: selected.inputSchema,
          output: selected.outputSchema,
        },
        "Advanced integration contract",
      ),
    );
    try {
      const example = schemaForm(selected.inputSchema, {});
      content.append(
        card(
          h("h3", {}, "Input example"),
          para(
            "Explore the expected input. This form does not execute the tool.",
          ),
          example.element,
        ),
      );
    } catch {
      content.append(
        para("See the integration contract for this tool’s input format."),
      );
    }
  }
  function drawDetail() {
    if (ctx.signal?.aborted) return;
    validators = [];
    content.replaceChildren();
    if (!item || (tab === "workflows" && item === "new")) {
      drawIndex();
      return;
    }
    if (tab === "workflows") renderWorkflow();
    else if (tab === "chains") renderChain();
    else if (tab === "skills") renderSkill();
    else if (tab === "knowledge") renderReference();
    else renderTool();
  }
  drawDetail();
}
