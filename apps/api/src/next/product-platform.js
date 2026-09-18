import {
  h,
  api,
  button,
  link,
  badge,
  tabs,
  empty,
  notify,
  navigate,
  setContext,
  time,
  schemaForm,
  guardUnsaved,
  jsonDetails,
} from "./core.js";

export function platformRoute(
  org,
  { product, campaign, tab, view = "products" } = {},
) {
  const q = new URLSearchParams({ organization: org, view });
  if (product) q.set("product", product);
  if (campaign) q.set("campaign", campaign);
  if (tab) q.set("tab", tab);
  return "/next/organizations?" + q;
}
export function formatCost(micros, currency = "USD") {
  if (micros === null || micros === undefined) return "Unpriced";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 4,
  }).format(Number(micros) / 1e6);
}
export function usageTotals(groups) {
  const currencies = {};
  for (const g of groups) {
    const value = (currencies[g.currency] ||= {
      costMicros: 0,
      unpriced: 0,
      estimated: 0,
      pricedEvents: 0,
    });
    value.costMicros += Number(g.cost_micros);
    value.unpriced += Number(g.unpriced_events);
    value.estimated += Number(g.estimated_events);
    value.pricedEvents += Number(g.events) - Number(g.unpriced_events);
  }
  return currencies;
}
const field = (label, control) =>
  h("label", { class: "pp-field" }, h("span", {}, label), control);
const text = (value = "", attrs = {}) => h("input", { value, ...attrs });
const area = (value = "", attrs = {}) =>
  h("textarea", { value, rows: 4, ...attrs });
const heading = (title, ...actions) =>
  h(
    "div",
    { class: "pp-heading" },
    h("h2", {}, title),
    h("div", { class: "pp-actions" }, ...actions),
  );
const card = (...content) =>
  h("section", { class: "nx-card pp-card" }, ...content);
const select = (items, value, placeholder = "None") =>
  h(
    "select",
    {},
    h("option", { value: "" }, placeholder),
    ...items.map((i) =>
      h("option", { value: i.id, selected: i.id === value }, i.name),
    ),
  );

export async function renderProductPlatform(
  host,
  { organization, url, ctx = {}, onContext } = {},
) {
  const org = organization.id,
    base = "/organizations/" + org + "/platform";
  const q = url.searchParams,
    productId = q.get("product"),
    campaignId = q.get("campaign"),
    view = q.get("view") || "products";
  let disposed = false;
  ctx.onCleanup?.(() => {
    disposed = true;
  });
  const route = (selection) => navigate(platformRoute(org, selection));
  const request = (path, body, method = "POST") =>
    api(base + path, { method, body, signal: ctx.signal });
  const refresh = async () => {
    if (!disposed) await render();
  };
  function editForm(title, controls, save, submitLabel = "Save") {
    const box = card(heading(title));
    const form = h("form", { class: "pp-form" }, ...controls);
    let dirty = false;
    form.addEventListener("input", () => (dirty = true));
    if (ctx.onCleanup) guardUnsaved(() => dirty && box.isConnected, ctx);
    const submit = h(
      "button",
      { type: "submit", class: "nx-button nx-primary" },
      submitLabel,
    );
    form.append(
      h(
        "div",
        { class: "pp-actions" },
        submit,
        button("Cancel", () => box.remove()),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!form.reportValidity() || submit.disabled) return;
      submit.disabled = true;
      try {
        await save();
        dirty = false;
        box.remove();
        await refresh();
      } catch (err) {
        notify(err.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    box.append(form);
    host.prepend(box);
    controls[0]?.querySelector("input,textarea,select")?.focus();
    return box;
  }
  async function productForm(product = null) {
    const people = await api(base + "/participants");
    const name = text(product?.name, { required: true, maxLength: 160 });
    const description = area(product?.description),
      owner = select(people, product?.owner_person_id);
    const repository = text(product?.repository_url, {
      placeholder: "https://forgejo.example/team/product",
    });
    const runtime = select(
      [
        { id: "static", name: "Website" },
        { id: "service", name: "App with backend" },
      ],
      product?.runtime_kind || "static",
      "Choose type",
    );
    editForm(
      product ? "Edit product" : "New product",
      [
        field("Name", name),
        field("Purpose", description),
        field("Owner", owner),
        field("Repository", repository),
        field("Product type", runtime),
      ],
      async () => {
        await request(
          "/products" + (product ? "/" + product.id : ""),
          {
            name: name.value,
            description: description.value,
            ownerPersonId: owner.value || null,
            repositoryUrl: repository.value,
            runtimeKind: runtime.value,
            revision: product?.revision,
          },
          product ? "PATCH" : "POST",
        );
      },
    );
  }
  async function campaignForm(product = null, campaign = null) {
    const [people, products] = await Promise.all([
      api(base + "/participants"),
      api(base + "/products"),
    ]);
    const name = text(campaign?.name, { required: true, maxLength: 160 }),
      objective = area(campaign?.objective, { required: true }),
      success = area(campaign?.success_measure);
    const owner = select(people, campaign?.owner_person_id),
      target = select(
        products,
        campaign?.product_id || product?.id,
        "Organization-wide",
      );
    const participants = h(
      "div",
      { class: "pp-options" },
      ...people.map((p) =>
        field(
          p.name + (p.role ? " · " + p.role : ""),
          h("input", {
            type: "checkbox",
            value: p.id,
            checked: campaign?.stakeholder_ids?.includes(p.id),
          }),
        ),
      ),
    );
    const budget = text(
      campaign?.budget_micros == null
        ? ""
        : Number(campaign.budget_micros) / 1e6,
      { type: "number", min: 0, step: "0.01", placeholder: "Optional" },
    );
    const currency = text(campaign?.currency || "USD", { maxLength: 3 });
    editForm(
      campaign ? "Edit campaign" : "New campaign",
      [
        field("Name", name),
        field("Objective", objective),
        field("Success measure", success),
        field("Product", target),
        field("Decision owner", owner),
        field("Stakeholders", participants),
        field("Cost budget", budget),
        field("Currency", currency),
      ],
      async () => {
        await request(
          "/campaigns" + (campaign ? "/" + campaign.id : ""),
          {
            name: name.value,
            objective: objective.value,
            successMeasure: success.value,
            productId: target.value || null,
            ownerPersonId: owner.value || null,
            stakeholderIds: [
              ...participants.querySelectorAll("input:checked"),
            ].map((n) => n.value),
            budgetMicros:
              budget.value === ""
                ? null
                : Math.round(Number(budget.value) * 1e6),
            currency: currency.value.toUpperCase(),
            revision: campaign?.revision,
          },
          campaign ? "PATCH" : "POST",
        );
      },
    );
  }
  function requirementForm(campaign, requirement = null) {
    const title = text(requirement?.title, { required: true }),
      description = area(requirement?.description, { required: true });
    const criteria = area(requirement?.acceptance_criteria?.join("\n"), {
      required: true,
      placeholder: "One acceptance criterion per line",
    });
    const evidence = area(
      requirement?.evidence?.map((e) => e.reference).join("\n"),
      { placeholder: "Document, answer or source references; one per line" },
    );
    const author = text("operator", { required: true });
    editForm(
      requirement ? "Revise requirement" : "Propose requirement",
      [
        field("Title", title),
        field("Requirement", description),
        field("Acceptance criteria", criteria),
        field("Evidence", evidence),
        field("Proposed by", author),
      ],
      async () => {
        const body = {
          title: title.value,
          description: description.value,
          acceptanceCriteria: criteria.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
          evidence: evidence.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((reference) => ({
              kind: /^https?:\/\//.test(reference) ? "url" : "note",
              reference,
              label: "",
            })),
          author: author.value,
          campaignId: campaign.id,
          revision: requirement?.current_revision,
        };
        await request(
          requirement
            ? "/requirements/" + requirement.id
            : "/campaigns/" + campaign.id + "/requirements",
          body,
          requirement ? "PATCH" : "POST",
        );
      },
    );
  }
  function reviewRequirement(requirement) {
    const actor = text("operator", { required: true }),
      feedback = area(""),
      decision = select(
        [
          { id: "approve", name: "Approve this revision" },
          { id: "request_changes", name: "Request changes" },
          { id: "reject", name: "Reject" },
        ],
        "approve",
      );
    editForm(
      "Review v" + requirement.current_revision + ": " + requirement.title,
      [
        field("Decision", decision),
        field("Reviewed by", actor),
        field("Feedback", feedback),
      ],
      () =>
        request("/requirements/" + requirement.id + "/decision", {
          revision: requirement.current_revision,
          action: decision.value,
          actor: actor.value,
          feedback: feedback.value,
        }),
    );
  }
  async function startForm(campaign) {
    const chains = await api("/engagement-templates");
    const picker = select(chains, "", "Select a workflow chain"),
      fields = h("div");
    let inputs = null,
      selectionEpoch = 0;
    picker.addEventListener("change", async () => {
      const selectedEpoch = ++selectionEpoch;
      inputs = null;
      fields.replaceChildren();
      const chain = chains.find((c) => c.id === picker.value);
      if (!chain?.stages?.[0]) return;
      try {
        const w = await api("/workflows/" + chain.stages[0].workflowId);
        if (selectedEpoch !== selectionEpoch || disposed) return;
        const schema =
          w.currentVersion?.inputSchema ||
          w.currentVersion?.input_schema ||
          w.version?.inputSchema ||
          w.inputSchema ||
          {};
        inputs = schemaForm(schema, {});
        fields.replaceChildren(inputs.element || inputs.node || inputs.form);
      } catch (e) {
        if (selectedEpoch !== selectionEpoch || disposed) return;
        fields.replaceChildren(h("p", {}, e.message));
      }
    });
    editForm(
      "Start " + campaign.name,
      [field("Workflow chain", picker), fields],
      async () => {
        if (!picker.value || !inputs)
          throw Error("Choose a workflow chain first");
        const input = inputs.read();
        const result = await request("/campaigns/" + campaign.id + "/start", {
          templateId: picker.value,
          input,
        });
        if (result.dispatchPending) notify(result.dispatchMessage);
        route({
          product: campaign.product_id,
          campaign: campaign.id,
          view: "campaigns",
        });
      },
    );
  }
  function campaignCards(campaigns, product) {
    return h(
      "div",
      { class: "pp-stack" },
      heading(
        "Campaigns",
        button("New campaign", () => campaignForm(product), {
          icon: "plus",
          primary: true,
        }),
      ),
      campaigns.length
        ? campaigns.map((c) =>
            card(
              h(
                "div",
                { class: "pp-heading" },
                link(
                  c.name,
                  platformRoute(org, {
                    product: c.product_id,
                    campaign: c.id,
                    view: "campaigns",
                  }),
                ),
                badge(c.engagement_state || c.state),
              ),
              h("p", {}, c.objective),
              h(
                "small",
                {},
                [
                  c.owner_name,
                  c.product_name,
                  c.pending_requirements
                    ? c.pending_requirements + " requirements to review"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
            ),
          )
        : empty(
            "No campaigns",
            "Create an initiative to gather requirements and deliver a product.",
          ),
    );
  }
  async function showCampaign(campaign) {
    const people = await api(base + "/participants");
    if (disposed) return;
    (onContext || setContext)({
      scope: "knowledge",
      organizationId: org,
      kind: "campaign",
      id: campaign.id,
      campaignId: campaign.id,
      productId: campaign.product_id || null,
      buildId: null,
      documentId: null,
      conceptId: null,
      version: campaign.revision,
      label: organization.name + " → " + campaign.name,
    });
    host.append(
      heading(
        campaign.name,
        button("Edit", () => campaignForm(null, campaign), { icon: "edit" }),
        campaign.engagement_id
          ? link(
              "Open engagement",
              "/next/run?engagement=" + campaign.engagement_id,
              { icon: "arrow" },
            )
          : button("Start workflow chain", () => startForm(campaign), {
              primary: true,
              icon: "play",
            }),
      ),
    );
    host.append(
      card(
        badge(campaign.state),
        h("p", {}, campaign.objective),
        campaign.success_measure
          ? h("p", {}, "Success: " + campaign.success_measure)
          : null,
        h(
          "div",
          { class: "pp-actions" },
          ...people
            .filter(
              (p) =>
                campaign.owner_person_id === p.id ||
                campaign.stakeholder_ids.includes(p.id),
            )
            .map((p) =>
              badge(
                p.name + (campaign.owner_person_id === p.id ? " · Owner" : ""),
              ),
            ),
        ),
      ),
    );
    host.append(
      heading(
        "Requirements",
        button("Propose requirement", () => requirementForm(campaign), {
          icon: "plus",
        }),
      ),
    );
    if (!campaign.requirements.length)
      host.append(
        empty(
          "No requirements yet",
          "Capture findings as requirements, then review each revision before building.",
        ),
      );
    for (const r of campaign.requirements) {
      const history = h("div");
      host.append(
        card(
          heading(r.title, badge(r.state), badge("v" + r.current_revision)),
          h("p", { class: "pp-prose" }, r.description),
          h("h4", {}, "Acceptance criteria"),
          h("ul", {}, ...r.acceptance_criteria.map((c) => h("li", {}, c))),
          r.evidence.length
            ? h(
                "details",
                {},
                h("summary", {}, "Evidence · " + r.evidence.length),
                ...r.evidence.map((e) =>
                  e.kind === "url"
                    ? h("p", {}, link(e.label || e.reference, e.reference))
                    : h("p", {}, e.label || e.reference),
                ),
              )
            : null,
          r.decision_by
            ? h(
                "small",
                {},
                "Reviewed by " +
                  r.decision_by +
                  (r.decision_feedback ? ": " + r.decision_feedback : ""),
              )
            : null,
          h(
            "div",
            { class: "pp-actions" },
            r.state === "proposed"
              ? button("Review", () => reviewRequirement(r), { primary: true })
              : null,
            button("Revise", () => requirementForm(campaign, r), {
              icon: "edit",
            }),
            button(
              "History",
              async () => {
                const versions = await api(
                  base + "/requirements/" + r.id + "/history",
                );
                history.replaceChildren(
                  ...versions.map((v) =>
                    card(
                      heading(
                        "v" + v.revision + " · " + v.title,
                        badge(v.action || "proposed"),
                      ),
                      h("p", {}, v.description),
                      h("small", {}, v.author + " · " + time(v.created_at)),
                      v.feedback ? h("p", {}, v.feedback) : null,
                    ),
                  ),
                );
              },
              { icon: "history" },
            ),
          ),
          history,
        ),
      );
    }
  }
  async function usagePanel(product = null) {
    const month = q.get("month") || new Date().toISOString().slice(0, 7);
    const [data, collection] = await Promise.all([
      api(
        base +
          "/usage?month=" +
          month +
          (product ? "&product=" + product.id : ""),
      ),
      api(base + "/usage/collection"),
    ]);
    const monthInput = text(month, {
      type: "month",
      "aria-label": "Usage month",
    });
    monthInput.addEventListener("change", () => {
      const next = new URL(location.href);
      next.searchParams.set("month", monthInput.value);
      navigate(next.pathname + next.search);
    });
    const panel = h(
      "div",
      { class: "pp-stack" },
      heading(
        "Usage",
        monthInput,
        button("Configure", () => usageConfig(data, product, collection), {
          icon: "settings",
        }),
      ),
      h(
        "p",
        { class: "nx-muted" },
        "Measured usage and internal cost. No billing or charges.",
      ),
    );
    const totals = usageTotals(data.groups);
    const metricCards = Object.entries(totals).map(([currency, total]) =>
      card(
        h("small", {}, "Measured cost · " + currency),
        h(
          "strong",
          {},
          total.pricedEvents
            ? formatCost(total.costMicros, currency)
            : "Unpriced",
        ),
        h(
          "small",
          {},
          total.unpriced
            ? total.unpriced + " events unpriced · total incomplete"
            : total.estimated
              ? "Includes estimates"
              : "Actual costs",
        ),
      ),
    );
    const budgetCards = data.budgets.map((b) =>
      card(
        h("small", {}, "Monthly budget"),
        h("strong", {}, formatCost(b.amount_micros, b.currency)),
        h(
          "small",
          {},
          "Remaining " +
            formatCost(
              Number(b.amount_micros) - (totals[b.currency]?.costMicros || 0),
              b.currency,
            ) +
            (totals[b.currency]?.unpriced ? " · incomplete" : ""),
        ),
      ),
    );
    panel.append(
      h("div", { class: "pp-metrics" }, ...metricCards, ...budgetCards),
    );
    if (!data.groups.length)
      panel.append(
        empty(
          "No usage recorded this month",
          "New instrumented activity will appear here. Historical usage is not estimated.",
        ),
      );
    else
      panel.append(
        h(
          "div",
          { class: "pp-table-wrap" },
          h(
            "table",
            { class: "pp-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                ...["Resource", "Provider", "Units", "Cost", "Coverage"].map(
                  (t) => h("th", {}, t),
                ),
              ),
            ),
            h(
              "tbody",
              {},
              ...data.groups.map((g) =>
                h(
                  "tr",
                  {},
                  h("td", {}, g.category.replaceAll("_", " ")),
                  h("td", {}, g.provider),
                  h("td", {}, Number(g.units).toLocaleString() + " " + g.unit),
                  h(
                    "td",
                    {},
                    g.unpriced_events === g.events
                      ? "Unpriced"
                      : formatCost(g.cost_micros, g.currency),
                  ),
                  h(
                    "td",
                    {},
                    g.unpriced_events
                      ? g.unpriced_events + " unpriced"
                      : g.estimated_events
                        ? "Estimated"
                        : "Actual",
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    panel.append(
      h(
        "small",
        {},
        "Unpriced usage is not free. Hosted tool call counts are observed calls, not billed sessions.",
      ),
    );
    const samples = collection.storageSamples.filter(
      (s) => !product || s.product_id === product.id,
    );
    if (samples.length)
      panel.append(
        card(
          heading("Repository storage"),
          ...samples.map((s) =>
            h(
              "div",
              { class: "pp-measurement" },
              h("span", {}, s.resource_key),
              h(
                "span",
                {},
                (Number(s.size_bytes) / 1024 / 1024).toFixed(2) + " MiB",
              ),
              h("small", {}, time(s.measured_at)),
            ),
          ),
          h(
            "small",
            {},
            "Git storage snapshots. Packages, backups and LFS need separate measurement.",
          ),
        ),
      );
    if (collection.configuration.last_error)
      panel.append(
        card(
          badge("Collection needs attention", "warning"),
          h("p", {}, collection.configuration.last_error),
        ),
      );
    panel.append(
      h(
        "details",
        {},
        h("summary", {}, "Recent measurements"),
        ...data.events.map((e) =>
          h(
            "div",
            { class: "pp-measurement" },
            h(
              "span",
              {},
              e.category +
                " · " +
                Number(e.units).toLocaleString() +
                " " +
                e.unit,
            ),
            h("span", {}, formatCost(e.effective_cost_micros, e.currency)),
            badge(e.effective_cost_status),
            h("small", {}, time(e.measured_at)),
          ),
        ),
      ),
    );
    return panel;
  }
  function usageConfig(data, product, collection) {
    const box = card(heading("Usage configuration"));
    const currency = text("USD", { maxLength: 3 }),
      budget = text(
        data.budgets[0] ? Number(data.budgets[0].amount_micros) / 1e6 : "",
        { type: "number", min: 0, step: ".01" },
      );
    box.append(
      h("h3", {}, "Monthly budget"),
      field("Amount", budget),
      field("Currency", currency),
      button("Save budget", async () => {
        if (!budget.value.trim()) throw Error("Enter a budget amount");
        await request("/usage/budgets", {
          month: data.month,
          productId: product?.id || null,
          amountMicros: Math.round(Number(budget.value) * 1e6),
          currency: currency.value.toUpperCase(),
        });
        notify("Budget saved");
        await refresh();
      }),
    );
    const provider = text("", { placeholder: "openai:gpt-4.1" }),
      category = select(
        [
          "llm_input",
          "llm_cached_input",
          "llm_output",
          "hosted_tools",
          "api",
          "compute",
          "storage",
          "network",
          "database",
          "temporal",
          "forgejo",
        ].map((id) => ({ id, name: id.replaceAll("_", " ") })),
        "llm_input",
      ),
      unit = text("tokens"),
      amount = text("", { type: "number", min: 0, step: ".000001" }),
      per = text("1000000", { type: "number", min: 1 }),
      effective = text(new Date().toISOString().slice(0, 16), {
        type: "datetime-local",
      }),
      source = text("", {
        placeholder: "Contract or provider price reference",
      });
    box.append(
      h("h3", {}, "Cost rate"),
      h(
        "p",
        {},
        "Add a versioned rate from your provider or contract. Applies to newly recorded usage; historical measurements remain unchanged.",
      ),
      ...[
        field("Provider", provider),
        field("Resource", category),
        field("Unit", unit),
        field("Cost", amount),
        field("Per units", per),
        field("Effective from", effective),
        field("Rate source", source),
      ],
      button("Add rate", async () => {
        if (!amount.value.trim())
          throw Error("Enter a provider cost; blank does not mean zero");
        await request("/usage/rates", {
          provider: provider.value,
          category: category.value,
          unit: unit.value,
          amountMicros: Math.round(Number(amount.value) * 1e6),
          perUnits: Number(per.value),
          currency: currency.value.toUpperCase(),
          effectiveAt: new Date(effective.value).toISOString(),
          source: source.value,
        });
        notify("Rate saved");
        await refresh();
      }),
    );
    box.append(
      h(
        "details",
        {},
        h("summary", {}, "Rate history · " + data.rates.length),
        ...data.rates.map((r) =>
          h(
            "p",
            {},
            r.provider +
              " · " +
              r.category +
              " · " +
              formatCost(r.amount_micros, r.currency) +
              " / " +
              r.per_units +
              " " +
              r.unit +
              " · " +
              time(r.effective_at),
          ),
        ),
      ),
    );
    const forgejo = h("input", {
        type: "checkbox",
        checked: collection.configuration.forgejo_enabled,
      }),
      opencost = h("input", {
        type: "checkbox",
        checked: collection.configuration.opencost_enabled,
      }),
      interval = text(collection.configuration.interval_minutes, {
        type: "number",
        min: 5,
        max: 1440,
      });
    box.append(
      h("h3", {}, "Resource collection"),
      h(
        "div",
        { class: "pp-actions" },
        badge(
          collection.capabilities.forgejoConfigured
            ? "Forgejo connected"
            : "Forgejo not configured",
        ),
        badge(
          collection.capabilities.openCostConfigured
            ? "OpenCost connected"
            : "OpenCost not configured",
        ),
      ),
      field("Collect repository storage", forgejo),
      field("Collect Kubernetes allocations from OpenCost", opencost),
      field("Collection interval · minutes", interval),
      button("Save collection settings", async () => {
        await request(
          "/usage/collection",
          {
            forgejoEnabled: forgejo.checked,
            openCostEnabled: opencost.checked,
            intervalMinutes: Number(interval.value),
          },
          "PUT",
        );
        notify("Collection settings saved");
        await refresh();
      }),
      button("Collect now", async () => {
        const result = await request("/usage/collect", {});
        if (result.error) throw Error(result.error);
        notify("Collection completed");
        await refresh();
      }),
    );
    if (product) {
      const keyView = h("div");
      box.append(
        h("h3", {}, "Product API usage"),
        h(
          "p",
          {},
          "A backend key can record API usage for this product only. Creating a new key invalidates the previous one.",
        ),
        button("Create or rotate backend key", async () => {
          const value = await request(
            "/products/" + product.id + "/usage-credential",
            {},
          );
          const secret = text(value.token, {
            readOnly: true,
            type: "password",
            "aria-label": "Usage ingestion key",
          });
          keyView.replaceChildren(
            field("One-time key", secret),
            button("Show key", () => {
              secret.type = secret.type === "password" ? "text" : "password";
            }),
            button("Copy key", () =>
              navigator.clipboard.writeText(value.token),
            ),
            h("p", {}, "POST " + value.endpoint),
            h(
              "small",
              {},
              "Use Authorization: Bearer <key>. Send eventKey, units and unit; retries with the same eventKey are deduplicated.",
            ),
          );
        }),
        keyView,
      );
    }
    box.append(button("Close", () => box.remove()));
    host.prepend(box);
  }
  async function hostingPanel(product) {
    const data = await api("/products/" + product.id + "/service-delivery");
    const config = data.configuration?.configuration;
    const panel = h(
      "div",
      { class: "pp-stack" },
      heading(
        "Hosting",
        button("Configure", () => hostingForm(product, data), {
          icon: "settings",
        }),
      ),
      card(
        h(
          "div",
          { class: "pp-actions" },
          badge(
            data.capabilities.ciConfigured
              ? "Build pipeline ready"
              : "Build pipeline not configured",
          ),
          badge(
            data.capabilities.kelosConfigured
              ? "Kelos available"
              : "Kelos not configured",
          ),
        ),
        h(
          "p",
          {},
          config
            ? "Backend services deploy from a tested image through GitOps. Each live release requires approval."
            : "Connect a build pipeline and GitOps environment to deploy an API, workers and persistent data.",
        ),
      ),
    );
    if (config) {
      const databases = await Promise.all(
        ["preview", "live"].map(async (environment) => ({
          environment,
          ...(await api(
            "/products/" +
              product.id +
              "/service-database?environment=" +
              environment,
          )),
        })),
      );
      panel.append(
        card(
          heading("Databases"),
          ...databases.map((database) =>
            h(
              "div",
              { class: "pp-measurement" },
              h("span", {}, database.environment),
              badge(database.state),
              database.state === "not_provisioned"
                ? button(
                    "Create " + database.environment + " database",
                    async () => {
                      await api(
                        "/products/" + product.id + "/service-database",
                        {
                          method: "POST",
                          body: { environment: database.environment },
                        },
                      );
                      notify("Database provisioning started");
                      await refresh();
                    },
                  )
                : button("Check readiness", refresh, { icon: "refresh" }),
              database.storage ? h("small", {}, database.storage) : null,
            ),
          ),
        ),
      );
      const brief = area("", {
        placeholder: "What should the agent build or revise?",
      });
      panel.append(
        card(
          heading("Build a revision"),
          field("Build instructions", brief),
          button(
            "Start build",
            async () => {
              if (!brief.value.trim()) throw Error("Describe the build first");
              await api("/products/" + product.id + "/service-builds", {
                method: "POST",
                body: {
                  brief: brief.value,
                  requestId: crypto.randomUUID(),
                  parentBuildId: product.releases.find(
                    (b) => b.state === "completed",
                  )?.id,
                },
              });
              notify("Build queued");
              await refresh();
            },
            { primary: true, icon: "code" },
          ),
        ),
      );
      for (const build of product.releases.filter(
        (b) =>
          b.state === "completed" && b.result?._config?.runtime === "service",
      ))
        panel.append(
          card(
            heading("Build " + build.id.slice(0, 8), badge(build.state)),
            h(
              "div",
              { class: "pp-actions" },
              ...["preview", "live"].map((environment) =>
                button("Prepare " + environment + " release", async () => {
                  await api("/products/" + product.id + "/releases", {
                    method: "POST",
                    body: {
                      buildId: build.id,
                      environment,
                      requestId: crypto.randomUUID(),
                    },
                  });
                  await refresh();
                }),
              ),
            ),
          ),
        );
      for (const build of product.releases.filter(
        (b) => b.state !== "completed",
      )) {
        const actions = [
          link(
            "Build activity",
            platformRoute(org, { product: product.id, tab: "versions" }),
            { icon: "history" },
          ),
        ];
        if (
          ["paused", "failed"].includes(build.state) &&
          build.result?._config?.runtime === "service"
        )
          actions.push(
            button(
              "Resume with more budget",
              () => resumeBuildForm(product, build, config),
              { primary: true, icon: "play" },
            ),
          );
        panel.append(
          card(
            heading("Build " + build.id.slice(0, 8), badge(build.state)),
            build.error ? h("p", {}, build.error) : null,
            h("div", { class: "pp-actions" }, ...actions),
          ),
        );
      }
    }
    panel.append(heading("Deployments"));
    if (!data.releases.length) panel.append(empty("No deployments yet"));
    for (const release of data.releases)
      panel.append(
        card(
          heading(
            release.environment + " · " + release.source_commit?.slice(0, 8),
            badge(release.state),
          ),
          release.image ? h("p", {}, release.image) : null,
          release.error ? h("p", {}, release.error) : null,
          h(
            "div",
            { class: "pp-actions" },
            release.state === "healthy" && release.url
              ? link("Open application", release.url, { icon: "external" })
              : null,
            release.state === "awaiting_approval"
              ? button(
                  "Approve deployment",
                  async () => {
                    await api(
                      "/service-delivery/releases/" + release.id + "/approve",
                      { method: "POST", body: { approved: true } },
                    );
                    await refresh();
                  },
                  { primary: true },
                )
              : null,
            release.state === "awaiting_approval"
              ? button("Decline deployment", () => {
                  const reason = area("", { required: true, maxLength: 4000 });
                  editForm(
                    "Decline " + release.environment + " deployment",
                    [field("Reason", reason)],
                    () =>
                      api(
                        "/service-delivery/releases/" + release.id + "/reject",
                        { method: "POST", body: { reason: reason.value } },
                      ),
                    "Decline deployment",
                  );
                })
              : null,
            button(
              "Check progress",
              async () => {
                await api(
                  "/service-delivery/releases/" + release.id + "/refresh",
                  { method: "POST", body: {} },
                );
                await refresh();
              },
              { icon: "refresh" },
            ),
          ),
        ),
      );
    return panel;
  }
  function resumeBuildForm(product, build, config) {
    const budget = config.budget || {},
      turns = text(Math.min(10000, (budget.totalTurns || 2000) * 2), {
        type: "number",
        min: 10,
        max: 10000,
      }),
      seconds = text(budget.maxSeconds || 21600, {
        type: "number",
        min: 60,
        max: 86400,
      }),
      cost = text(budget.maxCostUsd ?? "", {
        type: "number",
        min: 0,
        step: ".01",
      });
    editForm(
      "Resume build " + build.id.slice(0, 8),
      [
        h(
          "p",
          {},
          "Continue the saved conversation and files with a larger budget.",
        ),
        field("Total turn budget", turns),
        field("Time budget · seconds", seconds),
        field("Cost budget · USD, optional", cost),
      ],
      async () => {
        await api(
          "/products/" + product.id + "/service-builds/" + build.id + "/resume",
          {
            method: "POST",
            body: {
              requestId: crypto.randomUUID(),
              budget: {
                chunkTurns: budget.chunkTurns || 200,
                totalTurns: Number(turns.value),
                maxSeconds: Number(seconds.value),
                maxStalledChunks: budget.maxStalledChunks || 2,
                ...(cost.value ? { maxCostUsd: Number(cost.value) } : {}),
              },
            },
          },
        );
        notify("Build continuation queued");
      },
    );
  }
  function hostingForm(product, data) {
    const c = data.configuration?.configuration || {},
      b = c.budget || {};
    const hostName = text(c.previewHost || "", {
        required: true,
        placeholder: "preview.example.com",
      }),
      liveHost = text(c.liveHost || ""),
      port = text(c.port || 8080, { type: "number", min: 1, max: 65535 }),
      publicPort = text(
        c.publicPort ??
          (!data.configuration &&
          ["localhost", "127.0.0.1", "[::1]"].includes(
            new URL(location.href).hostname,
          )
            ? 3006
            : ""),
        { type: "number", min: 1, max: 65535, placeholder: "80 / 443" },
      ),
      ingressClass = text(c.ingressClass || "revos-products", {
        required: true,
      }),
      health = text(c.healthPath || "/health"),
      executor = select(
        [
          { id: "openhands", name: "OpenHands" },
          { id: "kelos", name: "Kelos" },
        ],
        c.executor || "openhands",
      ),
      provider = select(
        [
          { id: "argocd", name: "Argo CD" },
          { id: "external_gitops", name: "External GitOps" },
        ],
        c.provider || "argocd",
      );
    const tests = area((c.testCommand || ["npm", "test"]).join("\n")),
      migration = area((c.migrationCommand || []).join("\n")),
      database = text(c.database?.secret || ""),
      databaseKey = text(c.database?.key || "DATABASE_URL"),
      secretRefs = area(
        (c.secretRefs || []).map((s) => JSON.stringify(s)).join("\n"),
      );
    const chunk = text(b.chunkTurns || 200, { type: "number", min: 1 }),
      total = text(b.totalTurns || 2000, { type: "number", min: 1 }),
      seconds = text(b.maxSeconds || 21600, { type: "number", min: 60 }),
      stalled = text(b.maxStalledChunks || 2, { type: "number", min: 1 }),
      cost = text(b.maxCostUsd ?? "", { type: "number", min: 0, step: ".01" });
    editForm(
      "Hosting configuration",
      [
        field("Executor", executor),
        field("GitOps controller", provider),
        field("Preview hostname", hostName),
        field("Live hostname", liveHost),
        field("Service port", port),
        field("Public port · optional", publicPort),
        field("Ingress class", ingressClass),
        field("Health endpoint", health),
        field("Test command · one argument per line", tests),
        field("Migration command · one argument per line", migration),
        field("Database secret name", database),
        field("Database secret key", databaseKey),
        field(
          "Additional secret references · JSON object per line",
          secretRefs,
        ),
        field("Turns per checkpoint", chunk),
        field("Total turn budget", total),
        field("Time budget · seconds", seconds),
        field("Stalled checkpoints before pausing", stalled),
        field("Cost budget · USD, optional", cost),
      ],
      async () => {
        const split = (v) =>
          v
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        await api("/products/" + product.id + "/service-delivery", {
          method: "PUT",
          body: {
            revision: data.configuration?.revision || 0,
            configuration: {
              provider: provider.value,
              executor: executor.value,
              previewHost: hostName.value,
              ...(liveHost.value ? { liveHost: liveHost.value } : {}),
              port: Number(port.value),
              ...(String(publicPort.value).trim()
                ? { publicPort: Number(publicPort.value) }
                : {}),
              ingressClass: ingressClass.value,
              ...Object.fromEntries(
                [
                  "tlsSecretName",
                  "imagePullSecret",
                  "cpu",
                  "memory",
                  "replicas",
                ]
                  .filter((key) => c[key] !== undefined)
                  .map((key) => [key, c[key]]),
              ),
              healthPath: health.value,
              testCommand: split(tests.value),
              ...(migration.value.trim()
                ? { migrationCommand: split(migration.value) }
                : {}),
              ...(database.value
                ? {
                    database: {
                      secret: database.value,
                      key: databaseKey.value,
                    },
                  }
                : {}),
              secretRefs: split(secretRefs.value).map((v) => JSON.parse(v)),
              budget: {
                chunkTurns: Number(chunk.value),
                totalTurns: Number(total.value),
                maxSeconds: Number(seconds.value),
                maxStalledChunks: Number(stalled.value),
                ...(cost.value ? { maxCostUsd: Number(cost.value) } : {}),
              },
            },
          },
        });
      },
    );
  }
  async function render() {
    const [products, campaigns] = await Promise.all([
      api(base + "/products", { signal: ctx.signal }),
      api(base + "/campaigns", { signal: ctx.signal }),
    ]);
    if (disposed) return;
    host.replaceChildren();
    if (campaignId) {
      await showCampaign(await api(base + "/campaigns/" + campaignId));
      return;
    }
    if (view === "usage") {
      host.append(await usagePanel());
      return;
    }
    if (view === "campaigns") {
      host.append(campaignCards(campaigns));
      return;
    }
    if (!productId) {
      host.append(
        heading(
          "Products",
          button("New product", () => productForm(), {
            icon: "plus",
            primary: true,
          }),
        ),
      );
      if (!products.length) {
        host.append(
          empty("No products yet", "Define a product before its first build."),
        );
        return;
      }
      const rows = products.map((p) =>
        h(
          "tr",
          {},
          h(
            "td",
            {},
            link(
              p.name,
              platformRoute(org, { product: p.id, tab: "overview" }),
            ),
            h("small", {}, p.description.slice(0, 160)),
          ),
          h("td", {}, p.owner_name || "Unassigned"),
          h("td", {}, badge(p.latest_build?.state || p.state)),
          h(
            "td",
            {},
            p.campaign_count + " campaigns · " + p.build_count + " builds",
          ),
          h(
            "td",
            {},
            p.preview_url
              ? link("Open", p.preview_url, { icon: "external" })
              : null,
            p.live_url ? link("Live", p.live_url, { icon: "external" }) : null,
            !p.preview_url && !p.live_url ? "—" : null,
          ),
        ),
      );
      const table = h(
        "table",
        { class: "pp-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...["Product", "Owner", "Status", "Work", "Preview"].map((v) =>
              h("th", {}, v),
            ),
          ),
        ),
        h("tbody", {}, ...rows),
      );
      host.append(h("div", { class: "pp-table-wrap" }, table));
      return;
    }
    const product = await api(base + "/products/" + productId, {
      signal: ctx.signal,
    });
    if (disposed) return;
    const context = {
      scope: "knowledge",
      organizationId: org,
      kind: "product",
      id: product.id,
      productId: product.id,
      buildId: product.releases[0]?.id || null,
      label: organization.name + " → " + product.name,
      documentId: null,
      conceptId: null,
      version: null,
    };
    (onContext || setContext)(context);
    const tab = [
      "overview",
      "campaigns",
      "releases",
      "usage",
      "hosting",
    ].includes(q.get("tab"))
      ? q.get("tab")
      : "overview";
    host.append(
      heading(
        product.name,
        button("Edit", () => productForm(product), { icon: "edit" }),
      ),
      tabs(
        [
          ...["overview", "campaigns", "releases", "usage", "hosting"].map(
            (id) => ({ key: id, label: id[0].toUpperCase() + id.slice(1) }),
          ),
        ],
        tab,
        (id) => route({ product: product.id, tab: id }),
      ),
    );
    if (product.releases.length)
      host.append(
        h(
          "div",
          { class: "pp-actions pp-legacy-actions" },
          ...[
            { tab: "preview", label: "Preview", icon: "product" },
            { tab: "feedback", label: "Feedback", icon: "assistant" },
            { tab: "versions", label: "Build history", icon: "history" },
          ].map((item) =>
            link(
              item.label,
              platformRoute(org, { product: product.id, tab: item.tab }),
              { icon: item.icon },
            ),
          ),
        ),
      );
    if (tab === "campaigns")
      host.append(campaignCards(product.campaigns, product));
    else if (tab === "usage") host.append(await usagePanel(product));
    else if (tab === "hosting") host.append(await hostingPanel(product));
    else if (tab === "releases") {
      if (!product.releases.length)
        host.append(
          empty(
            "No builds yet",
            "Create a campaign or configure hosting to begin.",
          ),
        );
      for (const release of product.releases)
        host.append(
          card(
            heading("Build " + release.id.slice(0, 8), badge(release.state)),
            h("p", {}, release.brief.split("\n")[0]),
            h("small", {}, time(release.created_at)),
            h(
              "div",
              { class: "pp-actions" },
              release.result?.previewUrl
                ? link("Open preview", release.result.previewUrl, {
                    icon: "external",
                  })
                : null,
              release.run_id
                ? link("Open run", "/next/run?run=" + release.run_id)
                : null,
            ),
            release.error ? h("p", {}, release.error) : null,
            jsonDetails(release.result, "Build details"),
          ),
        );
    } else {
      const preview = product.releases.find(
        (r) => r.state === "completed" && r.result?.previewUrl,
      );
      const previewUrl = product.preview_url || preview?.result.previewUrl;
      host.append(
        card(
          h(
            "p",
            { class: "pp-prose" },
            product.description ||
              "Add a purpose and assign an owner to define this product.",
          ),
          h(
            "div",
            { class: "pp-actions" },
            badge(
              product.runtime_kind === "service"
                ? "App with backend"
                : "Website",
            ),
            previewUrl
              ? link("Open preview", previewUrl, {
                  icon: "external",
                })
              : null,
            product.live_url
              ? link("Open live", product.live_url, { icon: "external" })
              : null,
            product.repository_url
              ? link("Repository", product.repository_url, { icon: "code" })
              : null,
            button("New campaign", () => campaignForm(product), {
              icon: "plus",
            }),
          ),
        ),
        campaignCards(product.campaigns, product),
      );
    }
  }
  await render();
  return () => {
    disposed = true;
  };
}
