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
  poll,
  time,
  safeUrl,
  guardUnsaved,
} from "./core.js";

const text = (value) => String(value ?? "").replaceAll("_", " ");
const muted = (value) => h("p", { class: "nx-muted" }, value);
const row = (...children) => h("div", { class: "nx-row" }, children);
const actions = (...children) => h("div", { class: "nx-actions" }, children);
const field = (label, control, help) =>
  h(
    "label",
    { class: "nx-field" },
    h("span", {}, label),
    control,
    help ? h("small", { class: "nx-muted" }, help) : null,
  );
const statusTone = (value) =>
  ["failed", "needs_attention"].includes(value)
    ? "danger"
    : ["waiting", "awaiting_approval", "paused"].includes(value)
      ? "warning"
      : ["completed", "approved"].includes(value)
        ? "success"
        : "neutral";
const status = (value) => badge(text(value || "pending"), statusTone(value));
const post = (path, body = {}) => api(path, { method: "POST", body });
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const store = {
  get(key, fallback = "") {
    try {
      return JSON.parse(sessionStorage.getItem("nx-run:" + key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem("nx-run:" + key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      sessionStorage.removeItem("nx-run:" + key);
    } catch {}
  },
};
export function runUrl(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  return "/next/run" + (params.size ? "?" + params : "");
}
function changed(root, value, render) {
  const signature = JSON.stringify(value);
  if (root._signature === signature) return;
  root._signature = signature;
  root.replaceChildren(...[render()].flat().filter(Boolean));
}
function external(label, url) {
  const safe = typeof url === "string" && url.trim() ? safeUrl(url) : null;
  return safe
    ? link(label, safe, { target: "_blank", rel: "noopener noreferrer" })
    : null;
}
function disclosure(label, ...children) {
  return h("details", {}, h("summary", {}, label), children);
}
function bindDraft(input, key) {
  input.value = store.get(key);
  input.addEventListener("input", () => store.set(key, input.value));
  return input;
}
function sourceChoice(key) {
  const select = h(
    "select",
    { "aria-label": "Feedback from" },
    h("option", { value: "operator" }, "Me"),
    h("option", { value: "customer" }, "Customer"),
  );
  select.value = store.get(key, "operator");
  select.addEventListener("change", () => store.set(key, select.value));
  return select;
}
function loadState(root) {
  const note = h(
    "p",
    { class: "nx-muted nx-small", role: "status" },
    "Loading…",
  );
  root.append(note);
  return {
    note,
    ok() {
      note.className = "nx-muted nx-small";
      note.textContent = "Updated " + new Date().toLocaleTimeString();
    },
    fail(error) {
      note.className = "nx-error";
      note.textContent =
        "Could not refresh this view: " +
        error.message +
        ". Updates will retry automatically.";
    },
  };
}
function pageHead(title, description, controls = []) {
  return h(
    "div",
    { class: "nx-page-head" },
    h("div", {}, h("h1", {}, title), description ? muted(description) : null),
    actions(controls),
  );
}
function guarded(ctx, fn) {
  let busy = false;
  return async () => {
    if (busy || ctx.signal?.aborted) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
}
function live(ctx) {
  return !ctx.signal?.aborted;
}
function decisionForm(title, explanation, key) {
  const root = h("section", { class: "nx-callout nx-run-decision" });
  const body = h("div", { class: "nx-run-decision-material" });
  const fields = h("fieldset");
  const note = h("p", { class: "nx-muted nx-small", role: "status" });
  root.append(h("h2", {}, title), muted(explanation), body, fields, note);
  const send = (label, fn, opts = {}) =>
    button(
      label,
      async () => {
        if (fields.disabled) return;
        fields.disabled = true;
        try {
          await fn();
          note.textContent = "Saved. Waiting for the workflow to continue…";
          store.remove(key);
        } catch (error) {
          fields.disabled = false;
          note.textContent = error.message;
          throw error;
        }
      },
      opts,
    );
  return { root, body, fields, note, send };
}

export async function renderRun(ctx) {
  ctx.root.replaceChildren();
  ctx.root.classList.add("nx-run");
  const url =
    ctx.url instanceof URL
      ? ctx.url
      : new URL(ctx.url || location.href, location.origin);
  const params = url.searchParams;
  if (params.get("build")) return renderBuild(ctx, params);
  if (params.get("new")) return renderLaunch(ctx, params);
  if (params.get("engagement") || params.get("run"))
    return renderExecution(ctx, params);
  return renderIndex(ctx, params);
}

async function renderIndex(ctx, params) {
  const workflowsMode = params.get("mode") === "workflows";
  setContext({
    scope: "run",
    label: workflowsMode ? "Workflow runs" : "Engagements",
  });
  ctx.root.append(
    pageHead(
      workflowsMode ? "Workflow runs" : "Engagements",
      workflowsMode
        ? "Run a published workflow independently."
        : "Follow each customer from understanding to a reviewed result.",
      [
        link(
          workflowsMode ? "Run a workflow" : "New engagement",
          runUrl({ new: workflowsMode ? "workflow" : "engagement" }),
          { class: "nx-button nx-primary" },
        ),
      ],
    ),
  );
  ctx.root.append(
    tabs(
      [
        { key: "engagements", label: "Engagements" },
        { key: "workflows", label: "Workflow runs" },
      ],
      workflowsMode ? "workflows" : "engagements",
      (key) => navigate(runUrl({ mode: key })),
    ),
  );
  const state = loadState(ctx.root),
    controls = h("div"),
    content = h("div", { class: "nx-list" });
  ctx.root.append(controls, content);
  let workflowId = params.get("workflow");
  let catalog = [],
    customers = [];
  const refresh = guarded(ctx, async () => {
    try {
      if (workflowsMode) {
        catalog = await api("/workflows");
        if (!live(ctx)) return;
        workflowId ||=
          catalog.find((w) => w.currentVersionId)?.id || catalog[0]?.id;
        changed(
          controls,
          catalog.map((w) => [w.id, w.name]),
          () => {
            const select = h(
              "select",
              { "aria-label": "Workflow" },
              catalog.map((w) => h("option", { value: w.id }, w.name)),
            );
            select.value = workflowId || "";
            select.addEventListener("change", () =>
              navigate(runUrl({ mode: "workflows", workflow: select.value })),
            );
            return field("Workflow", select);
          },
        );
        const runs = workflowId
          ? await api("/workflows/" + workflowId + "/runs")
          : [];
        if (!live(ctx)) return;
        const workflow = catalog.find((w) => w.id === workflowId);
        setContext({
          scope: "run",
          kind: "workflow",
          id: workflowId,
          workflowId,
          organizationId: workflow?.organizationId,
          label: workflow?.name || "Workflow runs",
        });
        changed(content, runs, () =>
          runs.length
            ? runs.map((r) =>
                h(
                  "article",
                  { class: "nx-card nx-run-index-row" },
                  h(
                    "div",
                    {},
                    link(
                      workflow?.name || "Workflow run",
                      runUrl({ run: r.id, workflow: workflowId }),
                    ),
                    muted(time(r.createdAt)),
                  ),
                  status(r.status),
                  link("Open run", runUrl({ run: r.id, workflow: workflowId })),
                ),
              )
            : empty(
                "No runs yet",
                "Choose a published workflow and use Run a workflow to begin.",
              ),
        );
      } else {
        const [engagements, names] = await Promise.all([
          api("/engagements"),
          api("/customers"),
        ]);
        if (!live(ctx)) return;
        customers = names;
        changed(content, [engagements, customers], () =>
          engagements.length
            ? engagements.map((e) => {
                const stage =
                  e.stages?.[Math.min(e.stage_index, e.stages.length - 1)];
                const customer = customers.find(
                  (c) => c.id === e.customer_organization_id,
                );
                const next =
                  e.state === "awaiting_approval"
                    ? "Review this stage"
                    : e.state === "paused"
                      ? "Paused"
                      : e.state === "needs_attention"
                        ? "Needs attention"
                        : e.state === "completed"
                          ? "View results"
                          : "Open current stage";
                return h(
                  "article",
                  { class: "nx-card nx-run-index-row" },
                  h(
                    "div",
                    {},
                    link(e.name, runUrl({ engagement: e.id })),
                    muted(
                      [
                        customer?.name || "Customer being identified",
                        stage?.name,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                  ),
                  status(e.state),
                  link(next, runUrl({ engagement: e.id })),
                );
              })
            : empty(
                "Start your first engagement",
                "Choose a workflow chain, provide the starting context, and review each stage before moving forward.",
              ),
        );
      }
      state.ok();
    } catch (error) {
      if (live(ctx)) state.fail(error);
    }
  });
  await refresh();
  poll(refresh, 5000, ctx);
}

async function renderLaunch(ctx, params) {
  const engagement = params.get("new") !== "workflow";
  ctx.root.append(
    pageHead(
      engagement ? "New engagement" : "Run a workflow",
      "Review the starting questions before model work begins.",
      [
        link(
          "Back to work",
          runUrl({ mode: engagement ? "engagements" : "workflows" }),
        ),
      ],
    ),
  );
  const [catalog, customers] = await Promise.all([
    api(engagement ? "/engagement-templates" : "/workflows"),
    api("/customers"),
  ]);
  if (!live(ctx)) return;
  const choices = engagement
    ? catalog
    : catalog.filter((w) => w.currentVersionId);
  if (!choices.length) {
    ctx.root.append(
      empty(
        "Nothing published yet",
        "Publish a workflow" +
          (engagement ? " and create a workflow chain" : "") +
          " in Library first.",
      ),
    );
    return;
  }
  const selection = h(
    "select",
    {},
    choices.map((item) => h("option", { value: item.id }, item.name)),
  );
  selection.value =
    params.get(engagement ? "chain" : "workflow") || choices[0].id;
  if (!selection.value) selection.value = choices[0].id;
  const customer = h(
    "select",
    {},
    h("option", { value: "" }, "Detect from the starting context"),
    customers.map((c) => h("option", { value: c.id }, c.name)),
  );
  customer.value = params.get("organization") || "";
  const name = bindDraft(
    h("input", {
      required: true,
      maxLength: 160,
      placeholder: "e.g. NYC Luxury discovery",
    }),
    "launch:name",
  );
  const form = h("form", { class: "nx-card nx-run-launch" }),
    questions = h("div"),
    summary = h("div", { class: "nx-callout" }),
    notice = h("p", { role: "status", class: "nx-muted" });
  const controls = h("fieldset");
  controls.append(field(engagement ? "Workflow chain" : "Workflow", selection));
  if (engagement) controls.append(field("Engagement name", name));
  controls.append(
    field(
      "Customer organization",
      customer,
      "Unclear matches pause for confirmation before customer knowledge is read.",
    ),
    questions,
    summary,
    notice,
  );
  form.append(controls);
  ctx.root.append(form);
  let definition = null,
    inputs = null,
    generation = 0,
    loading = false,
    dirty = false;
  guardUnsaved(() => dirty, ctx);
  form.addEventListener("input", () => {
    dirty = true;
  });
  form.addEventListener("change", () => {
    dirty = true;
  });
  questions.addEventListener("click", (event) => {
    if (event.target.closest("button")) dirty = true;
  });
  const start = button(
    engagement ? "Start engagement" : "Start workflow",
    async () => {
      if (loading || !inputs || !form.reportValidity()) return;
      const input = inputs.read(),
        launchId = selection.value;
      controls.disabled = true;
      try {
        const result = await post(
          engagement ? "/engagements" : "/workflows/" + launchId + "/runs",
          engagement
            ? {
                templateId: launchId,
                name: name.value.trim(),
                input,
                ...(customer.value
                  ? { customerOrganizationId: customer.value }
                  : {}),
              }
            : {
                input,
                ...(customer.value
                  ? { customerOrganizationId: customer.value }
                  : {}),
              },
        );
        dirty = false;
        store.remove("launch:inputs:" + launchId);
        if (live(ctx))
          navigate(
            runUrl(
              engagement
                ? { engagement: result.id }
                : { run: result.id, workflow: launchId },
            ),
          );
      } catch (error) {
        controls.disabled = false;
        throw error;
      }
    },
    { primary: true },
  );
  controls.append(start);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!controls.disabled) start.click();
  });
  async function load() {
    const ticket = ++generation,
      selected = choices.find((item) => item.id === selection.value);
    loading = true;
    controls.disabled = true;
    notice.textContent = "Loading starting questions…";
    try {
      const workflowId = engagement
        ? selected.stages?.[0]?.workflowId
        : selected.id;
      if (!workflowId) throw Error("This chain has no starting workflow.");
      definition = await api("/workflows/" + workflowId);
      if (!live(ctx) || ticket !== generation) return;
      if (!definition.version)
        throw Error("Publish the starting workflow before launching.");
      const schema = structuredClone(
        definition.version.inputSchema || { type: "object", properties: {} },
      );
      if (engagement) {
        delete schema.properties?.engagement;
        schema.required = (schema.required || []).filter(
          (key) => key !== "engagement",
        );
      }
      let initial = store.get("launch:inputs:" + selection.value, {});
      if (
        params.get("from") &&
        !engagement &&
        params.get("workflow") === selection.value
      )
        initial = (await api("/runs/" + params.get("from"))).input || initial;
      if (!live(ctx) || ticket !== generation) return;
      inputs = schemaForm(schema, initial);
      questions.replaceChildren(inputs.element);
      inputs.element.addEventListener("input", () => {
        try {
          store.set("launch:inputs:" + selected.id, inputs.read());
        } catch {}
      });
      summary.replaceChildren(
        h(
          "strong",
          {},
          engagement
            ? selected.stages.map((s) => s.name).join(" → ")
            : definition.name,
        ),
        muted(
          "Starts " +
            definition.name +
            " · published version " +
            definition.version.version +
            ". Model calls begin when you start.",
        ),
      );
      if (engagement)
        summary.append(
          muted(
            "Each stage requires a separate approval before the next begins.",
          ),
        );
      setContext({
        scope: "run",
        kind: "workflow",
        id: workflowId,
        workflowId,
        organizationId: definition.organizationId,
        label: "Start " + definition.name,
      });
      notice.textContent = "";
      controls.disabled = false;
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      if (ticket === generation) loading = false;
    }
  }
  selection.addEventListener("change", load);
  await load();
}

export function selectedAttempt(engagement, runId, stageIndex) {
  if (runId) {
    const attempt = engagement.attempts.find((a) => a.run_id === runId);
    if (!attempt)
      throw Error("This run does not belong to the selected engagement.");
    return { attempt, stageIndex: attempt.stage_index };
  }
  const index =
    stageIndex === null
      ? Math.min(engagement.stage_index, engagement.stages.length - 1)
      : Number(stageIndex);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= engagement.stages.length
  )
    throw Error("This engagement stage does not exist.");
  return {
    attempt: engagement.attempts.filter((a) => a.stage_index === index).at(-1),
    stageIndex: index,
  };
}

async function renderExecution(ctx, params) {
  const engagementId = params.get("engagement");
  let runId = params.get("run"),
    selectedStage = params.has("stage") ? params.get("stage") : null;
  const explicitView = ["results", "activity", "history"].includes(
    params.get("view"),
  );
  let view = explicitView ? params.get("view") : "results",
    viewPinned = explicitView;
  let selectedStep = params.get("step") || "all",
    data = null;
  const header = h("div"),
    banner = h("div"),
    rail = h("nav", {
      class: "nx-run-stages",
      "aria-label": "Engagement stages",
    }),
    decisions = h("div"),
    navigation = h("div"),
    filter = h("div"),
    content = h("section"),
    feedback = h("div"),
    technical = h(
      "details",
      { class: "nx-run-technical" },
      h("summary", {}, "Technical details"),
    );
  const techBody = h("div");
  technical.append(techBody);
  ctx.root.append(
    header,
    rail,
    banner,
    decisions,
    navigation,
    filter,
    content,
    feedback,
    technical,
  );
  const state = loadState(ctx.root);
  const sessionCache = new Map(),
    detailCache = new Map();
  const targets = () => ({
    ...(engagementId ? { engagement: engagementId, stage: selectedStage } : {}),
    run: runId,
    workflow: data?.workflow?.id,
    step: selectedStep === "all" ? null : selectedStep,
    view,
  });
  const refresh = guarded(ctx, async () => {
    try {
      let engagement = null,
        attempt = null;
      if (engagementId) {
        engagement = await api("/engagements/" + engagementId);
        const selected = selectedAttempt(engagement, runId, selectedStage);
        selectedStage = selected.stageIndex;
        attempt = selected.attempt;
        if (!runId && attempt) {
          runId = attempt.run_id;
          const address = new URL(location.href);
          address.searchParams.set("run", runId);
          address.searchParams.set("stage", selectedStage);
          if (live(ctx)) history.replaceState(history.state, "", address);
        }
      }
      if (!live(ctx)) return;
      const currentAttempt = engagement?.attempts
        .filter((a) => a.stage_index === engagement.stage_index)
        .at(-1);
      const historical =
        !!engagement && (!attempt || attempt.id !== currentAttempt?.id);
      if (!runId) {
        setContext({
          scope: "run",
          organizationId: engagement?.organization_id,
          engagementId,
          stageIndex: selectedStage,
          kind: "engagement",
          id: engagementId,
          label: engagement?.name || "Engagement",
        });
        changed(header, [engagement?.name, selectedStage], () =>
          pageHead(
            engagement?.stages[selectedStage]?.name || "Starting engagement",
            engagement?.name,
            [link("All engagements", runUrl())],
          ),
        );
        changed(rail, engagement, () => stageLinks(engagement, selectedStage));
        changed(content, [engagement?.state, selectedStage], () =>
          empty(
            "This stage has not started",
            selectedStage > engagement.stage_index
              ? "It begins after the earlier stages are approved."
              : "The first workflow is being prepared. This page updates automatically.",
          ),
        );
        state.ok();
        return;
      }
      const [run, sessions, outputs, builds, questionResponse, notes] =
        await Promise.all([
          api("/runs/" + runId),
          api("/runs/" + runId + "/sessions"),
          api("/runs/" + runId + "/outputs"),
          api("/runs/" + runId + "/builds"),
          api("/runs/" + runId + "/question"),
          api("/runs/" + runId + "/feedback"),
        ]);
      if (!live(ctx)) return;
      if (!viewPinned) {
        view =
          ["pending", "running"].includes(run.status) ||
          builds.some((build) => ["pending", "running"].includes(build.state))
            ? "activity"
            : "results";
        viewPinned = true;
        const address = new URL(location.href);
        address.searchParams.set("view", view);
        history.replaceState(history.state, "", address);
      }
      const workflowId =
        run.executionDefinition?.workflow?.id || params.get("workflow");
      const workflow = workflowId
        ? detailCache.get(workflowId) ||
          (await api("/workflows/" + workflowId))
        : null;
      if (workflowId) detailCache.set(workflowId, workflow);
      const definitions = run.executionDefinition?.steps || [];
      if (
        selectedStep !== "all" &&
        !definitions.some((s) => s.id === selectedStep)
      )
        selectedStep = "all";
      const selectedSessions =
        selectedStep === "all"
          ? sessions
          : sessions.filter((s) => s.workflowStepId === selectedStep);
      const waiting = sessions.find(
        (s) => s.status === "waiting" && s.reviewId,
      );
      const wanted = [
        ...new Map(
          [...selectedSessions, ...(waiting ? [waiting] : [])].map((s) => [
            s.id,
            s,
          ]),
        ).values(),
      ];
      const details = await Promise.all(
        wanted.map(async (s) => {
          const cache = sessionCache.get(s.id);
          if (
            cache &&
            ["completed", "failed", "cancelled"].includes(s.status) &&
            cache.status === s.status
          )
            return cache;
          const detail = await api("/sessions/" + s.id);
          sessionCache.set(s.id, detail);
          return detail;
        }),
      );
      if (!live(ctx)) return;
      const relatedRuns =
        !engagement && view === "history" && workflowId
          ? await api("/workflows/" + workflowId + "/runs")
          : [];
      if (!live(ctx)) return;
      data = {
        run,
        engagement,
        attempt,
        currentAttempt,
        historical,
        workflow,
        definitions,
        sessions,
        details,
        outputs,
        builds,
        question: questionResponse.question,
        notes,
        relatedRuns,
      };
      const stageName =
        engagement?.stages[selectedStage]?.name || workflow?.name;
      const label = [
        run.executionDefinition?.customer?.name,
        stageName,
        attempt ? "Round " + attempt.revision : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setContext({
        scope: "run",
        organizationId: workflow?.organizationId,
        label,
        workflowId,
        runId,
        engagementId: engagementId || undefined,
        stageIndex: engagement ? selectedStage : undefined,
        attemptId: attempt?.id,
        workflowStepId: selectedStep === "all" ? undefined : selectedStep,
        kind: "run",
        id: runId,
        version: run.workflowVersionId,
      });
      changed(
        header,
        [
          stageName,
          label,
          run.status,
          historical,
          engagement?.state,
          currentAttempt?.id,
        ],
        () =>
          pageHead(stageName, label, [
            status(run.status),
            link(
              engagement ? "All engagements" : "Workflow runs",
              runUrl({
                mode: engagement ? "engagements" : "workflows",
                workflow: engagement ? undefined : workflowId,
              }),
            ),
            ...(!engagement &&
            ["completed", "failed", "cancelled"].includes(run.status)
              ? [
                  link(
                    "Run again",
                    runUrl({
                      new: "workflow",
                      workflow: workflowId,
                      from: runId,
                    }),
                  ),
                ]
              : []),
            ...(!historical &&
            engagement &&
            currentAttempt &&
            !["completed", "cancelled"].includes(engagement.state)
              ? [
                  button(
                    engagement.state === "paused"
                      ? "Resume engagement"
                      : "Pause after current action",
                    async () => {
                      await post("/engagements/" + engagementId + "/decision", {
                        attemptId: currentAttempt.id,
                        action:
                          engagement.state === "paused" ? "resume" : "pause",
                        feedback: "",
                        source: "operator",
                      });
                      await refresh();
                    },
                  ),
                ]
              : []),
          ]),
      );
      changed(
        rail,
        engagement
          ? [
              engagement.stages,
              engagement.stage_index,
              engagement.attempts.map((a) => [a.id, a.run_status, a.state]),
              selectedStage,
            ]
          : null,
        () => (engagement ? stageLinks(engagement, selectedStage) : []),
      );
      changed(
        banner,
        [
          historical,
          currentAttempt?.id,
          engagement?.state,
          engagement?.error,
          run.error,
        ],
        () => [
          historical
            ? h(
                "div",
                { class: "nx-callout" },
                h(
                  "strong",
                  {},
                  "You are viewing a previous or inactive round.",
                ),
                muted("Its results and decisions are read-only."),
                currentAttempt
                  ? link(
                      "Return to current round",
                      runUrl({
                        engagement: engagementId,
                        run: currentAttempt.run_id,
                        stage: currentAttempt.stage_index,
                      }),
                    )
                  : null,
              )
            : null,
          engagement?.state === "paused"
            ? h(
                "div",
                { class: "nx-callout" },
                "Engagement paused. An active tool or coding job may finish; the next agent turn waits for Resume.",
              )
            : null,
          engagement?.error
            ? h(
                "p",
                { class: "nx-error" },
                engagement.error,
                " ",
                link(
                  "Open organization knowledge",
                  "/next/organizations?organization=" +
                    (run.customerOrganizationId ||
                      engagement.customer_organization_id ||
                      ""),
                ),
              )
            : null,
          run.error ? h("p", { class: "nx-error" }, run.error) : null,
        ],
      );
      renderDecision(decisions, data, refresh);
      changed(navigation, [runId, view], () =>
        tabs(
          [
            { key: "results", label: "Results" },
            { key: "activity", label: "Activity" },
            { key: "history", label: "History" },
          ],
          view,
          (next) => navigate(runUrl({ ...targets(), view: next })),
        ),
      );
      changed(
        filter,
        [definitions.map((s) => [s.id, s.name]), selectedStep, view],
        () => {
          if (view === "history") return [];
          const choose = h(
            "select",
            { "aria-label": "Workflow step" },
            h("option", { value: "all" }, "All steps"),
            definitions.map((s) => h("option", { value: s.id }, s.name)),
          );
          choose.value = selectedStep;
          choose.addEventListener("change", () =>
            navigate(
              runUrl({
                ...targets(),
                step: choose.value === "all" ? null : choose.value,
              }),
            ),
          );
          return field("Step", choose);
        },
      );
      if (view === "results")
        renderResults(content, data, selectedStep, refresh, ctx);
      else if (view === "activity") renderActivity(content, data, selectedStep);
      else renderHistory(content, data);
      renderGuidance(feedback, data, refresh);
      renderTechnical(techBody, data, ctx);
      state.ok();
    } catch (error) {
      if (live(ctx)) state.fail(error);
    }
  });
  await refresh();
  poll(refresh, 3000, ctx);
}

function renderTechnical(root, data, ctx) {
  if (!root._parts) {
    const definition = jsonDetails({}, "Pinned workflow and inputs"),
      sessions = h("div"),
      temporal = h("div");
    root.append(
      definition,
      sessions,
      actions(
        button("Load Temporal history", async () => {
          const result = await api("/runs/" + data.run.id + "/history");
          if (live(ctx))
            temporal.replaceChildren(jsonDetails(result, "Temporal events"));
        }),
        external(
          "Open in Temporal",
          "http://localhost:8080/namespaces/default/workflows/" +
            encodeURIComponent(data.run.temporalWorkflowId),
        ),
      ),
      temporal,
    );
    root._parts = { definition, sessions, entries: new Map() };
  }
  const parts = root._parts;
  const update = (element, value) => {
    const next = JSON.stringify(value, null, 2);
    if (element._value === next) return;
    element._value = next;
    element.children[1].textContent = next;
  };
  update(parts.definition, {
    runId: data.run.id,
    workflowVersionId: data.run.workflowVersionId,
    definition: data.run.executionDefinition,
  });
  for (const session of data.details) {
    let entry = parts.entries.get(session.id);
    if (!entry) {
      entry = jsonDetails(
        {},
        (data.definitions.find((d) => d.id === session.workflowStepId)?.name ||
          "Step") + " · skills, tools, knowledge and limits",
      );
      parts.sessions.append(entry);
      parts.entries.set(session.id, entry);
    }
    update(entry, {
      sessionId: session.id,
      state: session.state,
      snapshot: session.snapshot,
    });
  }
}

function stageLinks(engagement, selected) {
  return (engagement?.stages || []).map((stage, index) => {
    const attempt = engagement.attempts
      .filter((a) => a.stage_index === index)
      .at(-1);
    const state =
      engagement.state === "paused" && index === engagement.stage_index
        ? "paused"
        : attempt?.state === "running" && attempt.run_status === "waiting"
          ? "waiting"
          : attempt?.state;
    const label =
      {
        approved: "Done",
        awaiting_approval: "Review",
        running: "Working",
        failed: "Needs attention",
        waiting: "Needs input",
        paused: "Paused",
        revision_requested: "Revising",
      }[state] || "Not started";
    const item = link(
      "",
      runUrl({ engagement: engagement.id, stage: index, run: attempt?.run_id }),
      {
        class:
          "nx-run-stage" + (index === Number(selected) ? " is-selected" : ""),
        ...(index === Number(selected) ? { "aria-current": "step" } : {}),
      },
    );
    item.append(
      h("span", {}, index + 1 + ". " + stage.name),
      badge(label, statusTone(state)),
    );
    return item;
  });
}

function renderDecision(root, data, refresh) {
  const {
    run,
    engagement,
    attempt,
    historical,
    question,
    details,
    definitions,
  } = data;
  const resolution = run.organizationResolution;
  const session = details.find((s) => s.status === "waiting" && s.reviewId);
  const turn = session?.turns.find(
    (t) =>
      session.id + ":" + t.turn === session.reviewId &&
      t.decision.action === "request_review" &&
      !t.outcome,
  );
  const reviewStep = definitions.find((s) => s.id === session?.workflowStepId);
  const waitingStep = run.steps.find(
    (s) => s.status === "waiting" && (!reviewStep || s.key === reviewStep.key),
  );
  const checkpoint =
    waitingStep &&
    definitions.find((step) => step.key === waitingStep.key)?.type ===
      "human_review";
  const participant = waitingStep?.output?.participationQuestionId
    ? waitingStep.output
    : null;
  const delivery = waitingStep?.output?.serviceReleaseId
    ? waitingStep.output
    : null;
  const key = historical
    ? "history"
    : resolution?.state === "awaiting"
      ? "org:" + run.id
      : delivery
        ? "delivery:" + delivery.serviceReleaseId
        : participant
          ? "participant:" + participant.participationQuestionId
          : question
            ? question.questionId
            : turn && waitingStep
              ? session.reviewId
              : run.status === "waiting" && checkpoint && !session
                ? run.id + ":" + waitingStep.key
                : engagement?.state === "paused"
                  ? "paused"
                  : attempt &&
                      ["awaiting_approval", "failed"].includes(attempt.state)
                    ? "stage:" + attempt.id + ":" + attempt.state
                    : "none";
  changed(root, key, () => {
    if (["none", "history", "paused"].includes(key)) return [];
    if (delivery) {
      const view = decisionForm(
        "Preparing the product release",
        "This step waits for tests, deployment approval, and a healthy application.",
        key,
      );
      view.body.append(
        link(
          "Open hosting & review",
          "/next/organizations?organization=" +
            encodeURIComponent(delivery.organizationId) +
            "&view=products&product=" +
            encodeURIComponent(delivery.productId) +
            "&tab=hosting",
        ),
      );
      return view.root;
    }
    if (participant) {
      const view = decisionForm(
        "Waiting for a participant",
        participant.question ||
          "A question has been assigned to a customer stakeholder.",
        key,
      );
      view.body.append(
        h("p", {}, "This step continues after their answer is reviewed."),
        link(
          "Open questions & review",
          "/next/organizations?organization=" +
            encodeURIComponent(participant.organizationId) +
            "&view=people",
        ),
      );
      return view.root;
    }
    if (key.startsWith("org:")) {
      const view = decisionForm(
        "Confirm the customer",
        resolution.reason ||
          resolution.identity?.reason ||
          "Choose where this run’s knowledge belongs before it continues.",
        key,
      );
      const choice = h(
        "select",
        { "aria-label": "Confirm customer organization" },
        h("option", { value: "" }, "Create a new customer"),
        (resolution.candidates || []).map((c) =>
          h(
            "option",
            { value: c.id },
            c.name + (c.domain ? " · " + c.domain : ""),
          ),
        ),
      );
      choice.value = store.get(
        key + ":choice",
        resolution.requestedOrganizationId || "",
      );
      choice.addEventListener("change", () =>
        store.set(key + ":choice", choice.value),
      );
      const name = h("input", {
          value: store.get(key + ":name", resolution.identity?.name || ""),
          maxLength: 200,
          "aria-label": "New customer name",
        }),
        domain = h("input", {
          value: store.get(key + ":domain", resolution.identity?.domain || ""),
          maxLength: 250,
          "aria-label": "Website domain",
        });
      name.addEventListener("input", () =>
        store.set(key + ":name", name.value),
      );
      domain.addEventListener("input", () =>
        store.set(key + ":domain", domain.value),
      );
      view.fields.append(
        field("Customer", choice),
        field("New customer name", name),
        field("Website domain", domain),
        view.send(
          "Confirm & continue",
          async () => {
            if (!choice.value && !name.value.trim())
              throw Error("Enter the new customer name.");
            await post(
              "/runs/" + run.id + "/organization",
              choice.value
                ? { organizationId: choice.value }
                : {
                    name: name.value.trim(),
                    domain: domain.value.trim() || null,
                  },
            );
            await refresh();
          },
          { primary: true },
        ),
      );
      return view.root;
    }
    if (question) {
      const view = decisionForm(
        "The agent has a question",
        question.question,
        key,
      );
      const answer = bindDraft(
        h("textarea", {
          maxLength: 12000,
          rows: 3,
          "aria-label": "Your answer",
        }),
        key,
      );
      view.fields.append(
        actions(
          (question.options || []).map((option) =>
            button(option, () => {
              answer.value = option;
              store.set(key, option);
            }),
          ),
        ),
        field("Your answer", answer),
        view.send(
          "Answer & continue",
          async () => {
            if (!answer.value.trim()) throw Error("Enter an answer first.");
            await post("/runs/" + run.id + "/answer", {
              questionId: question.questionId,
              answer: answer.value.trim(),
            });
            await refresh();
          },
          { primary: true },
        ),
      );
      return view.root;
    }
    if (key.startsWith("stage:")) {
      const stage = engagement.stages[attempt.stage_index],
        next = engagement.stages[attempt.stage_index + 1];
      const view = decisionForm(
        attempt.state === "failed"
          ? "This round needs another attempt"
          : "Review " + stage.name + " · Round " + attempt.revision,
        attempt.state === "failed"
          ? "Describe what should change. A new round uses the previous results and your feedback."
          : "Approval accepts this round" +
              (next
                ? " and starts " + next.name
                : " and completes the engagement") +
              ".",
        key,
      );
      view.body.append(
        attempt.output != null
          ? output(attempt.output)
          : muted("This round has no final result."),
        buildLinks(data.builds, data),
      );
      const note = bindDraft(
          h("textarea", {
            rows: 3,
            maxLength: 12000,
            "aria-label": "Stage feedback",
            placeholder: "Changes requested or an approval note…",
          }),
          key,
        ),
        source = sourceChoice(key + ":source");
      const decide = (action) => async () => {
        if (action === "revise" && !note.value.trim())
          throw Error("Describe the changes requested.");
        await post("/engagements/" + engagement.id + "/decision", {
          attemptId: attempt.id,
          action,
          feedback: note.value.trim(),
          source: source.value,
        });
        await refresh();
      };
      view.fields.append(
        field("Feedback from", source),
        field("Feedback", note),
        actions(
          view.send("Request another round", decide("revise")),
          attempt.state === "awaiting_approval"
            ? view.send(
                next
                  ? "Approve " + stage.name + " & start " + next.name
                  : "Approve final version",
                decide("approve"),
                { primary: true },
              )
            : null,
        ),
      );
      return view.root;
    }
    const view = decisionForm(
      "Review this result",
      (definitions.find((s) => s.key === waitingStep?.key)?.name ||
        waitingStep?.key ||
        "Workflow checkpoint") +
        ". Approval continues this workflow; engagement stage approval is separate.",
      key,
    );
    view.body.append(
      output(turn ? parse(turn.decision.payload) : waitingStep?.input),
      buildLinks(data.builds, data),
    );
    const note = bindDraft(
      h("textarea", {
        rows: 3,
        maxLength: 2000,
        "aria-label": "Review feedback",
        placeholder: "What should change?",
      }),
      key,
    );
    const decide = (approved, action) => async () => {
      if (action === "revise" && !note.value.trim())
        throw Error("Describe what should change.");
      await post("/runs/" + run.id + "/review", {
        stepKey: waitingStep.key,
        approved,
        note: note.value.trim(),
        ...(turn ? { reviewId: session.reviewId } : {}),
        ...(action ? { action } : {}),
      });
      await refresh();
    };
    view.fields.append(
      field("Feedback or approval note", note),
      actions(
        turn ? view.send("Revise this result", decide(false, "revise")) : null,
        view.send("Approve this result", decide(true), { primary: true }),
        view.send("Stop this run", decide(false)),
      ),
      muted(
        (turn ? "Revise returns another review. " : "") +
          "Stop rejects this checkpoint and ends this run.",
      ),
    );
    return view.root;
  });
}

function buildRoute(buildId, data, view) {
  return runUrl({
    build: buildId,
    engagement: data?.engagement?.id,
    run: data?.run?.id,
    stage: data?.attempt?.stage_index,
    view,
  });
}
function buildLinks(builds, data) {
  return h(
    "div",
    { class: "nx-run-deliverable-links" },
    builds.map((build, i) =>
      row(
        link(
          "Build " + (i + 1) + (build.parent_id ? " · revision" : ""),
          buildRoute(build.id, data),
        ),
        status(build.state),
        external("Open preview", build.result?.previewUrl),
        external("Source", build.result?.codeUrl),
      ),
    ),
  );
}

function renderGuidance(root, data, refresh) {
  const { run, historical } = data;
  changed(
    root,
    [
      run.id,
      historical,
      ["completed", "failed", "cancelled"].includes(run.status),
    ],
    () => {
      if (
        historical ||
        ["completed", "failed", "cancelled"].includes(run.status)
      )
        return [];
      const key = "guidance:" + run.id;
      const note = bindDraft(
          h("textarea", {
            rows: 3,
            maxLength: 6000,
            "aria-label": "Guidance for the agent",
          }),
          key,
        ),
        source = sourceChoice(key + ":source"),
        fields = h("fieldset"),
        result = h("p", { role: "status", class: "nx-muted nx-small" });
      const send = button("Add guidance", async () => {
        if (!note.value.trim()) throw Error("Enter your guidance first.");
        fields.disabled = true;
        try {
          await post("/runs/" + run.id + "/feedback", {
            content: note.value.trim(),
            source: source.value,
          });
          note.value = "";
          store.remove(key);
          result.textContent =
            "Saved for the next agent turn. An active coding job is not interrupted.";
          await refresh();
        } finally {
          fields.disabled = false;
        }
      });
      fields.append(
        field("Feedback from", source),
        field("Guidance", note),
        send,
      );
      return disclosure(
        "Add guidance while work continues",
        muted(
          "This is saved for the next reasoning turn. Use the question or review above when a direct response is required.",
        ),
        fields,
        result,
      );
    },
  );
}

function sourceKey(source) {
  return [
    source.kind,
    source.source.workflowStepId,
    source.source.sessionId || "",
    source.source.turn ?? "",
    source.skillVersionId || "",
  ].join(":");
}
function sourceJobs(source, jobs) {
  return jobs.filter(
    (job) =>
      job.workflowStepId === source.source.workflowStepId &&
      (source.kind === "step"
        ? !job.skillVersionId
        : job.skillVersionId === source.skillVersionId &&
          (job.sessionId ?? undefined) === source.source.sessionId &&
          (job.turn ?? undefined) === source.source.turn),
  );
}
function renderResults(root, data, stepId, refresh, ctx) {
  if (!root._results) {
    const final = h("section"),
      builds = h("section"),
      sources = h("section"),
      notice = h("div");
    root.append(final, builds, sources, notice);
    root._results = { final, builds, sources, notice, cards: new Map() };
  }
  const parts = root._results;
  const finalValue =
    data.attempt?.output ??
    (data.run.status === "completed" ? data.run.output : null);
  changed(parts.final, finalValue, () =>
    finalValue == null
      ? []
      : h(
          "div",
          { class: "nx-run-result" },
          h("h2", {}, data.engagement ? "Round result" : "Workflow result"),
          output(finalValue),
          jsonDetails(finalValue, "Result data"),
        ),
  );
  const builds = data.builds.filter(
    (build) => stepId === "all" || build.workflowStepId === stepId,
  );
  changed(
    parts.builds,
    builds.map((b) => [
      b.id,
      b.state,
      b.parent_id,
      b.result?.previewUrl,
      b.result?.codeUrl,
    ]),
    () =>
      builds.length
        ? h(
            "section",
            { class: "nx-card" },
            h("h2", {}, "Products & previews"),
            buildLinks(builds, data),
          )
        : [],
  );
  const sources = data.outputs.sources.filter(
    (source) => stepId === "all" || source.source.workflowStepId === stepId,
  );
  changed(
    parts.notice,
    [sources.length, data.run.status, finalValue != null],
    () =>
      sources.length || finalValue != null
        ? []
        : empty(
            ["completed", "failed", "cancelled"].includes(data.run.status)
              ? "No completed findings in this run"
              : "Results are being prepared",
            "Completed step and skill findings appear here. Questions and reviews appear above as soon as your input is needed.",
          ),
  );
  const activeKeys = new Set(sources.map(sourceKey));
  for (const [key, card] of parts.cards)
    if (!activeKeys.has(key)) {
      card.root.remove();
      parts.cards.delete(key);
    }
  for (const source of sources) {
    const key = sourceKey(source);
    let card = parts.cards.get(key);
    if (!card) {
      const heading =
        (source.kind === "skill" ? "Skill: " : "Step: ") + source.title;
      const body = h(
        "div",
        { class: "nx-run-result-body" },
        output(source.output),
        jsonDetails(source.output, "Source data"),
      );
      const root = disclosure(heading, body);
      root.className = "nx-card nx-run-source";
      root.open = stepId !== "all" && source.kind === "step";
      const format = h(
        "select",
        { "aria-label": "File format for " + source.title },
        [
          ["pdf", "PDF report"],
          ["xlsx", "Spreadsheet"],
          ["pptx", "Slide deck"],
          ["png", "Image"],
        ].map(([value, name]) => h("option", { value }, name)),
      );
      const fields = h("fieldset"),
        state = h("p", { role: "status", class: "nx-muted nx-small" }),
        jobs = h("div");
      card = { root, fields, state, jobs, jobViews: new Map(), source };
      const generate = button("Generate file", async () => {
        fields.disabled = true;
        card.generating = true;
        try {
          await post("/outputs/generate", {
            source: source.source,
            settings: {
              ...source.settings,
              artifacts: {
                ...source.settings.artifacts,
                mode: "always",
                formats: [format.value],
              },
            },
          });
          state.textContent = "File generation queued.";
          card.generating = false;
          card.queuedUntil = Date.now() + 15000;
          await refresh();
        } catch (error) {
          card.generating = false;
          fields.disabled = false;
          throw error;
        }
      });
      fields.append(actions(format, generate));
      root.append(h("h3", {}, "Files"), fields, state, jobs);
      parts.sources.append(root);
      parts.cards.set(key, card);
    }
    const jobs = sourceJobs(source, data.outputs.jobs);
    const activeJob = jobs.some((job) =>
      ["pending", "running"].includes(job.state),
    );
    if (activeJob) card.queuedUntil = 0;
    card.fields.disabled =
      data.historical ||
      card.generating ||
      activeJob ||
      (card.queuedUntil || 0) > Date.now();
    const keys = new Set(jobs.map((job) => job.id));
    for (const [id, element] of card.jobViews)
      if (!keys.has(id)) {
        element.remove();
        card.jobViews.delete(id);
      }
    for (const job of jobs) {
      let element = card.jobViews.get(job.id);
      if (!element) {
        element = h("div", { class: "nx-run-file-job" });
        card.jobViews.set(job.id, element);
        card.jobs.append(element);
      }
      changed(element, job, () => {
        const controls = h("fieldset");
        if (job.state === "failed" && !data.historical)
          controls.append(
            button("Retry file generation", async () => {
              controls.disabled = true;
              try {
                await post("/artifacts/" + job.id + "/retry");
                await refresh();
              } catch (error) {
                controls.disabled = false;
                throw error;
              }
            }),
          );
        return [
          row(
            status(job.state),
            h(
              "span",
              { class: "nx-small" },
              (job.settings?.artifacts?.formats || [])
                .map((f) => f.toUpperCase())
                .join(", "),
            ),
          ),
          job.error ? h("p", { class: "nx-error" }, job.error) : null,
          controls,
          ...(job.files || []).map((file) => artifactFile(file)),
        ];
      });
    }
  }
}

function artifactFile(file) {
  const url = "/artifacts/files/" + encodeURIComponent(file.id);
  const root = h(
    "div",
    { class: "nx-run-file" },
    link("Download " + file.filename, url + "?download=1"),
    h(
      "span",
      { class: "nx-muted nx-small" },
      " · " + Math.ceil(file.byteSize / 1024) + " KB",
    ),
  );
  if (["application/pdf", "image/png"].includes(file.mimeType)) {
    const preview = disclosure("Preview " + file.filename);
    preview.addEventListener("toggle", () => {
      if (!preview.open || preview.dataset.loaded) return;
      preview.dataset.loaded = "1";
      preview.append(
        h(file.mimeType === "image/png" ? "img" : "iframe", {
          src: url,
          title: file.filename,
          alt: file.filename,
          class: "nx-run-artifact-preview",
          loading: "lazy",
        }),
      );
    });
    root.append(preview);
  }
  return root;
}

function renderActivity(root, data, stepId) {
  if (!root._activity) {
    const builds = h("div"),
      turns = h("div"),
      feedback = h("div");
    root.append(builds, turns, feedback);
    root._activity = {
      builds,
      turns,
      feedback,
      entries: new Map(),
      buildViews: new Map(),
    };
  }
  const parts = root._activity;
  const builds = data.builds.filter(
    (build) => stepId === "all" || build.workflowStepId === stepId,
  );
  const buildIds = new Set(builds.map((build) => build.id));
  for (const [id, card] of parts.buildViews)
    if (!buildIds.has(id)) {
      card.root.remove();
      parts.buildViews.delete(id);
    }
  builds.forEach((build, index) => {
    let card = parts.buildViews.get(build.id);
    if (!card) {
      const root = h("article", { class: "nx-card" }),
        state = h("span"),
        message = muted(""),
        last = muted(""),
        update = h("p", { class: "nx-run-build-update" });
      root.append(
        row(h("h3", {}, "Build " + (index + 1)), state),
        message,
        update,
        last,
        link("Open build updates", buildRoute(build.id, data, "updates")),
      );
      parts.builds.append(root);
      card = { root, state, message, last, update };
      parts.buildViews.set(build.id, card);
    }
    changed(card.state, build.state, () => status(build.state));
    card.message.textContent =
      build.progress?.message || "Waiting for activity";
    card.last.textContent = build.progress?.lastEventAt
      ? "Last activity " + time(build.progress.lastEventAt)
      : "";
    const latest = (build.progress?.messages || [])
      .filter(
        (message) =>
          message.role === "assistant" &&
          typeof message.text === "string" &&
          message.text.trim(),
      )
      .at(-1);
    card.update.hidden = !latest;
    card.update.textContent = latest
      ? "OpenHands: " +
        latest.text.slice(0, 1000) +
        (latest.text.length > 1000 ? "…" : "")
      : "";
  });
  const titles = {
    select_skill: "Selected skill",
    fetch_knowledge: "Read knowledge",
    call_tool: "Tool action",
    complete_skill: "Completed skill",
    request_review: "Requested review",
    ask_human: "Asked a question",
    final: "Completed this step",
  };
  const sessions = data.details
    .filter((s) => stepId === "all" || s.workflowStepId === stepId)
    .sort(
      (a, b) =>
        data.definitions.findIndex((s) => s.id === a.workflowStepId) -
        data.definitions.findIndex((s) => s.id === b.workflowStepId),
    );
  const entries = sessions.flatMap((session) =>
    session.turns.map((turn) => ({
      session,
      turn,
      key: session.id + ":" + turn.turn,
    })),
  );
  if (!entries.length && !parts.empty) {
    parts.empty = empty(
      "Preparing the next action",
      "Recorded skills, tool actions, questions and decisions will appear here.",
    );
    parts.turns.append(parts.empty);
  }
  if (entries.length && parts.empty) {
    parts.empty.remove();
    parts.empty = null;
  }
  for (const { session, turn, key } of entries) {
    let element = parts.entries.get(key);
    if (!element) {
      element = h("article", { class: "nx-run-event" });
      parts.entries.set(key, element);
      parts.turns.append(element);
    }
    changed(element, turn, () => {
      const step = data.definitions.find(
        (s) => s.id === session.workflowStepId,
      );
      const target = [
        ...(session.snapshot?.catalog || []),
        ...(session.snapshot?.definition?.tools || []),
        ...(session.snapshot?.definition?.knowledge || []),
      ].find((item) => item.id === turn.decision.target);
      const result = turn.outcome?.result;
      return [
        h(
          "div",
          { class: "nx-muted nx-small" },
          step?.name,
          " · Turn ",
          turn.turn + 1,
        ),
        row(
          h(
            "h3",
            {},
            titles[turn.decision.action] || text(turn.decision.action),
          ),
          status(turn.outcome ? "completed" : "running"),
        ),
        h("p", {}, turn.decision.summary),
        target ? muted(target.name || target.handler) : null,
        turn.decision.action === "ask_human"
          ? h(
              "div",
              {},
              h("p", {}, parse(turn.decision.payload)?.question),
              result?.answer ? h("p", {}, "Reply: " + result.answer) : null,
            )
          : null,
        turn.decision.action === "request_review" && result
          ? muted(
              result.action === "revise"
                ? "Changes requested: " + result.note
                : result.approved
                  ? "Approved" + (result.note ? ": " + result.note : "")
                  : "Rejected",
            )
          : null,
        jsonDetails(
          {
            proposed: parse(turn.decision.payload),
            ...(turn.outcome ? { result } : {}),
          },
          "Action details",
        ),
      ];
    });
  }
  changed(parts.feedback, data.notes, () =>
    data.notes.length
      ? h(
          "section",
          { class: "nx-card" },
          h("h2", {}, "Saved guidance"),
          data.notes.map((note) =>
            h(
              "article",
              { class: "nx-run-note" },
              h(
                "strong",
                {},
                note.source === "customer" ? "Customer" : "Operator",
              ),
              h(
                "span",
                { class: "nx-small nx-muted" },
                " · " + time(note.created_at),
              ),
              h("p", {}, note.content),
            ),
          ),
        )
      : [],
  );
}

function renderHistory(root, data) {
  changed(
    root,
    [data.engagement?.attempts, data.relatedRuns, data.notes],
    () => {
      if (data.engagement)
        return [
          h("h2", {}, "Rounds & decisions"),
          ...data.engagement.attempts.map((attempt) =>
            h(
              "article",
              { class: "nx-card nx-run-history" },
              row(
                h(
                  "h3",
                  {},
                  data.engagement.stages[attempt.stage_index].name +
                    " · Round " +
                    attempt.revision,
                ),
                status(attempt.state),
              ),
              muted(
                attempt.decision_by
                  ? "Decision recorded from " +
                      (attempt.decision_by === "customer"
                        ? "Customer"
                        : "Operator")
                  : "No stage decision recorded",
              ),
              attempt.feedback ? h("p", {}, attempt.feedback) : null,
              attempt.approved_at
                ? muted("Approved " + time(attempt.approved_at))
                : null,
              link(
                attempt.run_id === data.run.id
                  ? "Viewing this round"
                  : "Open round",
                runUrl({
                  engagement: data.engagement.id,
                  run: attempt.run_id,
                  stage: attempt.stage_index,
                }),
              ),
            ),
          ),
        ];
      return [
        h("h2", {}, "Workflow run history"),
        ...(data.relatedRuns || []).map((run) =>
          h(
            "article",
            { class: "nx-card nx-run-index-row" },
            h(
              "div",
              {},
              link(
                run.id === data.run.id ? "Current run" : "Open run",
                runUrl({
                  run: run.id,
                  workflow: data.workflow?.id,
                }),
              ),
              muted(time(run.createdAt)),
            ),
            status(run.status),
          ),
        ),
      ];
    },
  );
}

function relativeDuration(value) {
  const stamp = Date.parse(value || "");
  if (!Number.isFinite(stamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  return seconds < 60
    ? seconds + "s"
    : seconds < 3600
      ? Math.floor(seconds / 60) + "m"
      : Math.floor(seconds / 3600) +
        "h " +
        Math.floor((seconds % 3600) / 60) +
        "m";
}

function publicChat() {
  const root = h("section", { class: "nx-card nx-run-chat" }),
    title = h("h2", {}, "OpenHands updates"),
    notice = muted(
      "Public updates from the coding agent. This view is read-only.",
    ),
    messages = h("div", {
      class: "nx-run-chat-log",
      role: "log",
      "aria-live": "polite",
      "aria-label": "OpenHands public updates",
    }),
    none = muted(
      "OpenHands has not posted a message yet. Tool activity appears below.",
    ),
    truncated = muted("Showing a limited view of the public conversation."),
    jump = button("Jump to latest", () => {
      following = true;
      messages.scrollTop = messages.scrollHeight;
      jump.hidden = true;
    });
  root.append(title, notice, truncated, none, messages, jump);
  const entries = new Map();
  let following = true,
    signature = "";
  jump.hidden = true;
  truncated.hidden = true;
  messages.addEventListener("scroll", () => {
    following =
      messages.scrollHeight - messages.clientHeight - messages.scrollTop < 40;
    jump.hidden = following || !entries.size;
  });
  return {
    root,
    update(progress) {
      const seen = new Set();
      const items = (
        Array.isArray(progress?.messages) ? progress.messages : []
      ).filter(
        (item) =>
          item.role === "assistant" &&
          typeof item.text === "string" &&
          item.text.trim() &&
          typeof item.id === "string" &&
          !seen.has(item.id) &&
          seen.add(item.id),
      );
      const next = JSON.stringify([items, !!progress?.messagesTruncated]);
      if (next === signature) return;
      signature = next;
      const top = messages.scrollTop,
        anchor = !following
          ? [...messages.children].find(
              (item) => item.offsetTop + item.offsetHeight > top,
            )
          : null,
        offset = anchor ? anchor.offsetTop - top : 0;
      none.hidden = !!items.length;
      messages.hidden = !items.length;
      truncated.hidden = !progress?.messagesTruncated;
      for (const [id, item] of entries)
        if (!seen.has(id)) {
          item.remove();
          entries.delete(id);
        }
      items.forEach((item, index) => {
        let element = entries.get(item.id);
        if (!element) {
          element = h("article", { class: "nx-run-chat-message" });
          entries.set(item.id, element);
        }
        changed(element, item, () => [
          row(
            h(
              "strong",
              {},
              "OpenHands" +
                (item.kind === "summary"
                  ? " · Summary"
                  : item.kind === "update"
                    ? " · Update"
                    : ""),
            ),
            h(
              "span",
              { class: "nx-muted nx-small" },
              item.at ? time(item.at) : "",
            ),
          ),
          h("p", {}, item.text),
        ]);
        if (messages.children[index] !== element)
          messages.insertBefore(element, messages.children[index] || null);
      });
      messages.scrollTop = following
        ? messages.scrollHeight
        : anchor?.parentElement === messages
          ? anchor.offsetTop - offset
          : top;
      jump.hidden = following || !items.length;
    },
  };
}

async function renderBuild(ctx, params) {
  const id = params.get("build");
  let chosenView = ["preview", "updates", "files", "versions"].includes(
    params.get("view"),
  )
    ? params.get("view")
    : null;
  const header = h("div"),
    navigation = h("div"),
    summary = h("section", { class: "nx-callout" }),
    controls = h("div"),
    content = h("section"),
    source = h("div");
  ctx.root.append(header, summary, controls, navigation, content, source);
  const state = loadState(ctx.root),
    chat = publicChat(),
    eventList = h("section", { class: "nx-card" }),
    preview = h("div"),
    files = h("div"),
    versions = h("div");
  const sections = {
    preview,
    updates: h("div", {}, chat.root, eventList),
    files,
    versions,
  };
  if (chosenView) content.append(sections[chosenView]);
  let current = null,
    parentCache = new Map(),
    runCache = null,
    workflowCache = null,
    resuming = false,
    expectedAttempt = null;
  const resumeKey = "resume:" + id;
  const refresh = guarded(ctx, async () => {
    try {
      const build = await api("/builds/" + id);
      if (!live(ctx)) return;
      current = build;
      if (!chosenView) {
        chosenView =
          build.state === "completed" && build.result?.previewUrl
            ? "preview"
            : "updates";
        content.append(sections[chosenView]);
        const address = new URL(location.href);
        address.searchParams.set("view", chosenView);
        history.replaceState(history.state, "", address);
      }
      if (build.run_id && !runCache)
        runCache = await api("/runs/" + build.run_id);
      if (runCache && !workflowCache && runCache.executionDefinition?.workflow?.id)
        workflowCache = await api(
          "/workflows/" + runCache.executionDefinition.workflow.id,
        );
      if (!live(ctx)) return;
      const actualAttempt = build.result?._retry?.attempt || 0;
      if (expectedAttempt !== null && actualAttempt >= expectedAttempt)
        expectedAttempt = null;
      const optimistic = resuming || expectedAttempt !== null;
      setContext({
        scope: "run",
        organizationId: workflowCache?.organizationId || build.organization_id,
        workflowId: workflowCache?.id,
        runId: build.run_id || undefined,
        buildId: id,
        kind: "build",
        id,
        label: "Build " + id.slice(0, 8),
        version: build.result?.commit,
      });
      changed(
        header,
        [build.state, build.parent_id, build.run_id, optimistic],
        () =>
          pageHead(
            "Build " + id.slice(0, 8),
            build.parent_id
              ? "Revision of " + build.parent_id.slice(0, 8)
              : "New build",
            [
              status(optimistic ? "pending" : build.state),
              build.run_id
                ? link(
                    "Back to workflow run",
                    runUrl({
                      engagement: params.get("engagement"),
                      stage: params.get("stage"),
                      run: build.run_id,
                      workflow: workflowCache?.id,
                    }),
                  )
                : link(
                    "Organization",
                    "/next/organizations?organization=" + build.organization_id,
                  ),
            ],
          ),
      );
      changed(
        summary,
        [
          build.progress?.phase,
          build.progress?.message,
          build.error,
          optimistic,
        ],
        () => [
          h(
            "strong",
            {},
            optimistic
              ? "Resuming the existing coding workspace"
              : text(build.progress?.phase || build.state),
          ),
          h(
            "p",
            {},
            optimistic
              ? "The saved workspace and conversation will continue."
              : build.progress?.message || "Waiting for activity",
          ),
          build.error && !optimistic
            ? h("p", { class: "nx-error" }, build.error)
            : null,
        ],
      );
      const elapsed = h(
        "p",
        { class: "nx-muted nx-small" },
        [
          ["pending", "running"].includes(build.state)
            ? "Elapsed " + relativeDuration(build.created_at)
            : "Created " + time(build.created_at),
          build.progress?.lastEventAt
            ? "Last activity " +
              relativeDuration(build.progress.lastEventAt) +
              " ago"
            : "",
          build.progress?.maxIterations
            ? "Coding limit " + build.progress.maxIterations + " turns"
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (summary._elapsed?.parentElement === summary)
        summary._elapsed.replaceWith(elapsed);
      else summary.append(elapsed);
      summary._elapsed = elapsed;
      changed(
        controls,
        [build.state, build.result?.previewUrl, actualAttempt, optimistic],
        () => {
          const fields = h("fieldset");
          if (build.state === "failed" || optimistic)
            fields.append(
              button(optimistic ? "Resuming…" : "Resume build", async () => {
                if (resuming || expectedAttempt !== null) return;
                fields.disabled = true;
                resuming = true;
                const requestId = store.get(resumeKey) || crypto.randomUUID();
                store.set(resumeKey, requestId);
                try {
                  const resumed = await post("/builds/" + id + "/resume", {
                    requestId,
                  });
                  expectedAttempt = resumed.attempt;
                  store.remove(resumeKey);
                  notify("Build queued to continue.");
                } catch (error) {
                  fields.disabled = false;
                  throw error;
                } finally {
                  resuming = false;
                  await refresh();
                }
              }),
            );
          if (build.state === "completed" && !build.result?.previewUrl)
            fields.append(
              button("Create preview", async () => {
                fields.disabled = true;
                try {
                  await post("/builds/" + id + "/preview");
                  await refresh();
                } catch (error) {
                  fields.disabled = false;
                  throw error;
                }
              }),
            );
          fields.disabled = optimistic;
          return fields;
        },
      );
      changed(navigation, chosenView, () =>
        tabs(
          [
            { key: "preview", label: "Preview" },
            { key: "updates", label: "Updates" },
            { key: "files", label: "Files" },
            { key: "versions", label: "Versions" },
          ],
          chosenView,
          (view) =>
            navigate(
              runUrl({
                build: id,
                view,
                engagement: params.get("engagement"),
                stage: params.get("stage"),
                run: params.get("run"),
              }),
            ),
        ),
      );
      if (chosenView === "updates") {
        chat.update(build.progress || {});
        changed(eventList, build.progress?.events || [], () => [
          h("h2", {}, "Tool activity"),
          ...(build.progress?.events || []).map((event) =>
            h(
              "article",
              { class: "nx-run-event" },
              h("p", {}, event.message),
              h(
                "span",
                { class: "nx-muted nx-small" },
                event.at ? time(event.at) : "",
              ),
            ),
          ),
          !(build.progress?.events || []).length
            ? muted("No tool activity recorded yet.")
            : null,
        ]);
      }
      if (chosenView === "preview") {
        const ownUrl =
            typeof build.result?.previewUrl === "string" &&
            build.result.previewUrl.trim()
              ? safeUrl(build.result.previewUrl)
              : null,
          parentUrl =
            typeof build.parent?.previewUrl === "string" &&
            build.parent.previewUrl.trim()
              ? safeUrl(build.parent.previewUrl)
              : null,
          url = ownUrl || parentUrl;
        changed(preview, [url, !!ownUrl], () =>
          url
            ? [
                !ownUrl
                  ? h(
                      "p",
                      { class: "nx-callout" },
                      "Previous working preview. This revision is not published yet.",
                    )
                  : null,
                actions(external("Open preview in a new tab", url)),
                h("iframe", {
                  class: "nx-run-product-preview",
                  src: url,
                  title: ownUrl ? "Build preview" : "Previous build preview",
                  sandbox: "allow-scripts allow-forms",
                  referrerpolicy: "no-referrer",
                }),
              ]
            : empty(
                "Preview not available yet",
                build.state === "completed"
                  ? "Use Create preview to publish the saved build."
                  : "The preview appears after coding completes and the build is published.",
              ),
        );
      }
      if (chosenView === "files") {
        const savedFiles = build.progress?.files?.length
          ? build.progress.files
          : (build.result?.files || []).map((path) => ({ path }));
        changed(files, [savedFiles, build.result?.commit], () => [
          h("h2", {}, "Generated files"),
          savedFiles.length
            ? h(
                "ul",
                { class: "nx-run-files" },
                savedFiles.map((file) =>
                  h(
                    "li",
                    {},
                    file.path,
                    Number.isFinite(file.size)
                      ? h(
                          "span",
                          { class: "nx-muted nx-small" },
                          " · " + Math.ceil(file.size / 1024) + " KB",
                        )
                      : null,
                  ),
                ),
              )
            : empty(
                "No files yet",
                "Files appear as the coding agent creates them.",
              ),
          jsonDetails(build.result, "Build result and recorded checks"),
        ]);
      }
      if (chosenView === "versions") {
        const lineage = [build];
        let parentId = build.parent_id;
        for (let count = 0; parentId && count < 20; count++) {
          if (lineage.some((item) => item.id === parentId)) break;
          const parent =
            parentCache.get(parentId) || (await api("/builds/" + parentId));
          parentCache.set(parentId, parent);
          lineage.push(parent);
          parentId = parent.parent_id;
        }
        if (!live(ctx)) return;
        changed(
          versions,
          lineage.map((item) => [
            item.id,
            item.parent_id,
            item.state,
            item.result?.commit,
            item.result?.previewUrl,
          ]),
          () => [
            h("h2", {}, "Build lineage"),
            ...lineage.map((item, index) =>
              h(
                "article",
                { class: "nx-card" },
                row(
                  h(
                    "h3",
                    {},
                    index
                      ? "Previous build " + item.id.slice(0, 8)
                      : "This build",
                  ),
                  status(item.state),
                ),
                muted(
                  item.parent_id
                    ? "Revision of " + item.parent_id.slice(0, 8)
                    : "Original build",
                ),
                actions(
                  link("Open build", runUrl({ build: item.id })),
                  external("Preview", item.result?.previewUrl),
                  external("Source at this commit", item.result?.codeUrl),
                ),
                item.result?.commit
                  ? h("code", { class: "nx-small" }, item.result.commit)
                  : null,
              ),
            ),
            parentId
              ? link(
                  "Older versions",
                  runUrl({ build: parentId, view: "versions" }),
                )
              : null,
          ],
        );
      }
      changed(
        source,
        [
          build.result?.codeUrl,
          build.parent_id,
          build.parent?.codeUrl,
          build.result?.lineage,
        ],
        () =>
          actions(
            external("Source in Forgejo", build.result?.codeUrl),
            build.parent_id
              ? link("Parent build", runUrl({ build: build.parent_id }))
              : null,
            external("Parent source", build.parent?.codeUrl),
          ),
      );
      state.ok();
    } catch (error) {
      if (live(ctx)) state.fail(error);
    }
  });
  await refresh();
  poll(refresh, 3000, ctx);
}
