import { h, api, button, badge, empty, notify, time } from "./core.js";

const labels = {
  open: "Awaiting answer",
  submitted: "Ready to review",
  clarification: "Clarification requested",
  accepted: "Accepted",
  rejected: "Closed",
};
const field = (label, input) =>
  h("label", { class: "nx-people-field" }, h("span", {}, label), input);
const option = (value, label) => h("option", { value }, label);
/** A campaign's product is authoritative; clearing the campaign unlocks the product choice. */
export function questionLinks(products, campaigns, campaignId, productId) {
  const campaign = campaigns.find((c) => c.id === campaignId);
  const selectedProductId = campaign?.product_id || productId || null;
  return {
    campaignId: campaign?.id || null,
    productId: products.some((p) => p.id === selectedProductId)
      ? selectedProductId
      : null,
    productLocked: !!campaign?.product_id,
  };
}
export async function renderPeople(org, host) {
  const organizationId = typeof org === "string" ? org : org.id;
  let state,
    view = "people",
    selected = null,
    disposed = false;
  const base = "/participation/" + organizationId;
  const refresh = async () => {
    state = await api(base);
    if (!disposed) render();
  };
  const run = async (path, body, method = "POST") => {
    const result = await api(base + path, { method, body });
    await refresh();
    return result;
  };
  function personForm(person) {
    const name = h("input", {
        value: person?.name || "",
        required: true,
        placeholder: "Full name",
      }),
      email = h("input", {
        type: "email",
        value: person?.email || "",
        required: true,
        placeholder: "name@company.com",
      }),
      role = h("input", { value: person?.role || "", placeholder: "Role" }),
      expertise = h("input", {
        value: (person?.expertise || []).join(", "),
        placeholder: "Sales, operations, finance",
      }),
      primary = h("input", {
        type: "checkbox",
        checked: person?.primary_contact || false,
      });
    const form = h(
      "form",
      { class: "nx-people-form" },
      field("Name", name),
      field("Email", email),
      field("Role", role),
      field("Expertise", expertise),
      h("label", { class: "nx-people-checkbox" }, primary, "Primary contact"),
    );
    const submit = h(
      "button",
      { type: "submit", class: "nx-button nx-primary" },
      person?.state === "proposed"
        ? "Confirm participant"
        : person
          ? "Save person"
          : "Add person",
    );
    form.append(
      h(
        "div",
        { class: "nx-people-actions" },
        submit,
        button("Cancel", () => {
          selected = null;
          render();
        }),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api(base + "/people" + (person ? "/" + person.id : ""), {
          method: person ? "PUT" : "POST",
          body: {
            name: name.value,
            email: email.value,
            role: role.value,
            expertise: expertise.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
            primaryContact: primary.checked,
            source: "operator",
            evidence: person?.evidence || "",
          },
        });
        selected = null;
        await refresh();
        notify("Participant saved");
      } catch (err) {
        notify(err.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }
  function questionForm() {
    const name = h("input", {
        required: true,
        maxLength: 300,
        placeholder: "What decision do we need help with?",
      }),
      detail = h("textarea", {
        rows: 4,
        placeholder: "Include enough context to answer confidently.",
      }),
      why = h("textarea", {
        rows: 2,
        placeholder: "How the answer will inform the work.",
      }),
      person = h(
        "select",
        {},
        option("", "Choose a participant"),
        state.people
          .filter((p) => p.state === "active")
          .map((p) => option(p.id, p.name + " · " + p.role)),
      ),
      priority = h(
        "select",
        {},
        ["normal", "high", "urgent", "low"].map((v) =>
          option(v, v[0].toUpperCase() + v.slice(1)),
        ),
      ),
      due = h("input", { type: "date" }),
      product = h(
        "select",
        {},
        option("", "Organization-wide"),
        (state.products || []).map((p) => option(p.id, p.name)),
      ),
      campaign = h(
        "select",
        {},
        option("", "No campaign"),
        (state.campaigns || []).map((c) => option(c.id, c.name)),
      ),
      linkHint = h(
        "small",
        { class: "nx-muted", id: "nx-question-link-hint" },
        "Optionally connect this answer to a product or campaign.",
      );
    product.setAttribute("aria-describedby", "nx-question-link-hint");
    campaign.addEventListener("change", () => {
      const links = questionLinks(
        state.products || [],
        state.campaigns || [],
        campaign.value,
        product.value,
      );
      product.value = links.productId || "";
      product.disabled = links.productLocked;
      linkHint.textContent = links.productLocked
        ? "This product is set by the selected campaign."
        : "Optionally connect this answer to a product or campaign.";
    });
    person.required = true;
    const form = h(
      "form",
      { class: "nx-people-form" },
      field("Question", name),
      field("Assigned to", person),
      field("Campaign (optional)", campaign),
      field("Product (optional)", product),
      linkHint,
      field("Context", detail),
      field("Why this matters", why),
      field("Priority", priority),
      field("Requested by", due),
    );
    const submit = h(
      "button",
      { type: "submit", class: "nx-button nx-primary" },
      "Assign question",
    );
    form.append(
      h(
        "div",
        { class: "nx-people-actions" },
        submit,
        button("Cancel", () => {
          selected = null;
          render();
        }),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { campaignId, productId } = questionLinks(
          state.products || [],
          state.campaigns || [],
          campaign.value,
          product.value,
        );
        await api(base + "/questions", {
          method: "POST",
          body: {
            title: name.value,
            detail: detail.value,
            why: why.value,
            assignedPersonId: person.value,
            campaignId,
            productId,
            priority: priority.value,
            dueAt: due.value
              ? new Date(due.value + "T23:59:59").toISOString()
              : null,
          },
        });
        selected = null;
        await refresh();
        notify("Question assigned");
      } catch (err) {
        notify(err.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }
  function reviewQuestion(q) {
    const box = h("section", { class: "nx-people-detail" }),
      answers = state.answers.filter((a) => a.question_id === q.id),
      reviews = state.reviews.filter((r) => r.question_id === q.id);
    box.append(
      button(
        "All questions",
        () => {
          selected = null;
          render();
        },
        { icon: "back" },
      ),
      h("h2", {}, q.title),
      h(
        "div",
        { class: "nx-people-actions" },
        badge(labels[q.state] || q.state),
        badge(q.priority),
        h("span", { class: "nx-muted" }, q.assignee_name),
      ),
      q.product_name || q.campaign_name
        ? h(
            "div",
            { class: "nx-people-actions" },
            q.campaign_name ? badge("Campaign: " + q.campaign_name) : null,
            q.product_name ? badge("Product: " + q.product_name) : null,
          )
        : null,
      q.detail ? h("p", {}, q.detail) : null,
      q.why ? h("p", { class: "nx-muted" }, q.why) : null,
    );
    if (!answers.length)
      box.append(
        empty(
          "Waiting for an answer",
          "The assigned participant can answer through their invitation link.",
        ),
      );
    answers.forEach((a) =>
      box.append(
        h(
          "article",
          { class: "nx-people-answer" },
          h(
            "div",
            { class: "nx-people-actions" },
            h("strong", {}, a.respondent_name),
            h("small", { class: "nx-muted" }, time(a.submitted_at)),
            a.id === q.latest_answer_id ? badge("Latest") : null,
          ),
          h("div", { class: "nx-people-content" }, a.content),
          a.evidence.length
            ? h(
                "ul",
                {},
                a.evidence.map((e) =>
                  h(
                    "li",
                    {},
                    h(
                      "a",
                      {
                        href: e.url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      e.label,
                    ),
                  ),
                ),
              )
            : null,
        ),
      ),
    );
    if (q.state === "accepted") {
      box.append(
        h(
          "p",
          { class: "nx-muted" },
          q.knowledge_state === "applied"
            ? "Added to organization knowledge."
            : "Knowledge update: " + q.knowledge_state,
        ),
        q.knowledge_error
          ? h("p", { class: "nx-error" }, q.knowledge_error)
          : null,
        q.knowledge_state === "failed"
          ? button("Retry knowledge update", () =>
              run("/questions/" + q.id + "/retry-sync", {}),
            )
          : null,
      );
    }
    if (!["accepted", "rejected"].includes(q.state)) {
      const comment = h("textarea", {
          rows: 3,
          placeholder: "Feedback for the participant or primary contact",
        }),
        assignee = h(
          "select",
          {},
          option("", "Choose participant"),
          state.people
            .filter((p) => p.state === "active")
            .map((p) => option(p.id, p.name)),
        );
      const decide = async (action) => {
        await run("/questions/" + q.id + "/review", {
          action,
          answerId: q.latest_answer_id || undefined,
          expectedRevision: q.revision,
          comment: comment.value,
          personId:
            action === "reassign" ? assignee.value || undefined : undefined,
          reviewer: "Operator",
        });
        notify(action === "accept" ? "Answer accepted" : "Review saved");
      };
      box.append(
        field("Review feedback", comment),
        h(
          "div",
          { class: "nx-people-actions" },
          q.state === "submitted"
            ? button("Accept answer", () => decide("accept"), {
                primary: true,
                icon: "check",
              })
            : null,
          q.state === "submitted"
            ? button("Request clarification", () => decide("clarify"))
            : null,
          button("Hand to primary contact", () => decide("handoff")),
          button("Close question", () => decide("reject")),
        ),
        h(
          "details",
          {},
          h("summary", {}, "Reassign question"),
          field("Participant", assignee),
          button("Reassign", () => decide("reassign")),
        ),
      );
    }
    if (reviews.length)
      box.append(
        h(
          "details",
          {},
          h("summary", {}, "Review history"),
          reviews.map((r) =>
            h(
              "div",
              { class: "nx-people-review" },
              badge(r.action),
              h(
                "small",
                { class: "nx-muted" },
                r.actor + " · " + time(r.created_at),
              ),
              h("p", {}, r.comment),
            ),
          ),
        ),
      );
    return box;
  }
  function render() {
    host.replaceChildren(
      h(
        "div",
        { class: "nx-people-heading" },
        h(
          "div",
          {},
          h("h2", {}, "People & questions"),
          h(
            "p",
            { class: "nx-muted" },
            "Bring the right people into each decision.",
          ),
        ),
        button("Refresh", refresh, { icon: "refresh" }),
      ),
    );
    const waiting = state.questions.filter(
      (q) => q.state === "submitted",
    ).length;
    host.append(
      h(
        "div",
        {
          class: "nx-people-actions",
          role: "tablist",
          "aria-label": "Participation",
        },
        button(
          `People · ${state.people.length}`,
          () => {
            view = "people";
            selected = null;
            render();
          },
          {
            role: "tab",
            "aria-selected": view === "people",
            primary: view === "people",
          },
        ),
        button(
          `Questions · ${state.questions.length}${waiting ? " · " + waiting + " to review" : ""}`,
          () => {
            view = "questions";
            selected = null;
            render();
          },
          {
            role: "tab",
            "aria-selected": view === "questions",
            primary: view === "questions",
          },
        ),
      ),
    );
    if (view === "people") {
      if (selected === "add-person") {
        host.append(personForm());
        return;
      }
      const editing = state.people.find((p) => p.id === selected);
      if (editing) {
        host.append(personForm(editing));
        return;
      }
      host.append(
        h(
          "div",
          { class: "nx-people-actions" },
          button(
            "Add person",
            () => {
              selected = "add-person";
              render();
            },
            { primary: true, icon: "plus" },
          ),
          h(
            "small",
            { class: "nx-muted" },
            state.mailMode === "local"
              ? "Invitations go to the local email inbox."
              : state.mailMode === "smtp"
                ? "Invitations are sent through your configured email service."
                : "Copy invitation links; email delivery is not configured.",
          ),
        ),
      );
      const grid = h("div", { class: "nx-people-grid" });
      for (const p of state.people) {
        const counts = state.questions.filter(
            (q) => q.assigned_person_id === p.id,
          ),
          delivery = state.deliveries.find((d) => d.person_id === p.id),
          latestInvite = state.invitations.find((i) => i.person_id === p.id),
          card = h(
            "article",
            { class: "nx-people-card" },
            h(
              "div",
              { class: "nx-people-actions" },
              h("h3", {}, p.name),
              p.primary_contact ? badge("Primary contact") : null,
              p.state === "proposed" ? badge("Needs confirmation") : null,
            ),
            h("p", { class: "nx-muted" }, p.role || "Participant"),
            h("p", {}, p.email),
            p.expertise.length
              ? h(
                  "div",
                  { class: "nx-people-actions" },
                  p.expertise.map((v) => badge(v)),
                )
              : null,
            h(
              "p",
              { class: "nx-muted" },
              `${counts.filter((q) => q.state === "accepted").length} / ${counts.length} answers accepted`,
            ),
          );
        if (p.state === "proposed")
          card.append(
            p.evidence ? h("p", { class: "nx-muted" }, p.evidence) : null,
            button(
              "Review person",
              () => {
                selected = p.id;
                render();
              },
              { primary: true },
            ),
          );
        else
          card.append(
            h(
              "div",
              { class: "nx-people-actions" },
              button("Copy invite link", async () => {
                const invitation = await api(
                  base + "/people/" + p.id + "/invite",
                  { method: "POST", body: {} },
                );
                try {
                  await navigator.clipboard.writeText(invitation.url);
                  notify("Private invitation copied. Expires in seven days.");
                } catch {
                  const input = h("input", {
                    value: invitation.url,
                    readOnly: true,
                    "aria-label": "Private invitation link",
                  });
                  card.append(input);
                  input.select();
                  return;
                }
                await refresh();
              }),
              state.mailMode !== "disabled"
                ? button(
                    state.mailMode === "local"
                      ? "Send to local inbox"
                      : "Send invitation",
                    async () => {
                      await run("/people/" + p.id + "/send-invite", {});
                      notify(
                        state.mailMode === "local"
                          ? "Invitation queued for local inbox"
                          : "Invitation queued",
                      );
                    },
                    { icon: "send" },
                  )
                : null,
              button(
                "Edit",
                () => {
                  selected = p.id;
                  render();
                },
                { icon: "edit" },
              ),
            ),
            h(
              "details",
              {},
              h("summary", {}, "Access"),
              h(
                "p",
                { class: "nx-muted" },
                latestInvite?.redeemed_at
                  ? "Invitation redeemed"
                  : latestInvite?.revoked_at
                    ? "Invitation revoked"
                    : latestInvite
                      ? "Invitation ready"
                      : "No invitation yet",
              ),
              delivery
                ? h(
                    "p",
                    { class: "nx-muted" },
                    `Email: ${delivery.state}${delivery.error ? " · " + delivery.error : ""}`,
                  )
                : null,
              button("Revoke customer access", async () => {
                await run("/people/" + p.id + "/revoke", {});
                notify("Invitation links and sessions revoked.");
              }),
            ),
          );
        grid.append(card);
      }
      host.append(
        state.people.length
          ? grid
          : empty(
              "No participants yet",
              "Add the primary contact, then invite the people who can answer the important questions.",
            ),
      );
    } else {
      if (selected === "add-question") {
        host.append(questionForm());
        return;
      }
      const q = state.questions.find((q) => q.id === selected);
      if (q) {
        host.append(reviewQuestion(q));
        return;
      }
      host.append(
        h(
          "div",
          { class: "nx-people-actions" },
          button(
            "Assign question",
            () => {
              selected = "add-question";
              render();
            },
            {
              primary: true,
              icon: "plus",
              disabled: !state.people.some((p) => p.state === "active"),
            },
          ),
        ),
      );
      const list = h("div", { class: "nx-people-question-list" });
      for (const q of state.questions)
        list.append(
          h(
            "button",
            {
              type: "button",
              class: "nx-people-question",
              onclick: () => {
                selected = q.id;
                render();
              },
            },
            h(
              "div",
              {},
              h("strong", {}, q.title),
              h(
                "small",
                { class: "nx-muted" },
                q.assignee_name +
                  (q.due_at
                    ? " · Due " + new Date(q.due_at).toLocaleDateString()
                    : ""),
              ),
            ),
            h(
              "div",
              { class: "nx-people-actions" },
              badge(q.priority),
              badge(labels[q.state] || q.state),
            ),
          ),
        );
      host.append(
        state.questions.length
          ? list
          : empty(
              "No questions assigned",
              "Choose a person and ask one focused question. Their answer will come back here for review.",
            ),
      );
    }
  }
  await refresh();
  return () => {
    disposed = true;
  };
}
