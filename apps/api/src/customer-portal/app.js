(() => {
  const app = document.getElementById("app"),
    notice = document.getElementById("notice"),
    logout = document.getElementById("logout");
  let state,
    selected,
    dirty = false,
    noticeTimer;
  const h = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (["value", "disabled", "hidden", "required"].includes(k))
        n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const child of children.flat(Infinity))
      if (child !== null && child !== undefined)
        n.append(
          child instanceof Node
            ? child
            : document.createTextNode(String(child)),
        );
    return n;
  };
  const say = (text) => {
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.textContent = ""), 6500);
  };
  const csrf = () =>
    document.cookie
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("revos_customer_csrf="))
      ?.split("=")[1] || "";
  async function request(path, body) {
    const r = await fetch("/customer-api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-CSRF-Token": csrf() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "Please try again.");
    return data;
  }
  function action(label, fn, primary = false) {
    const b = h(
      "button",
      {
        type: "button",
        class: primary ? "primary" : "",
        onclick: async () => {
          if (b.disabled) return;
          b.disabled = true;
          try {
            await fn();
          } catch (e) {
            say(e.message);
          } finally {
            b.disabled = false;
          }
        },
      },
      label,
    );
    return b;
  }
  async function refresh() {
    state = await request("/me");
    logout.hidden = false;
    render();
  }
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  logout.addEventListener("click", async () => {
    if (dirty && !confirm("Leave without saving this answer?")) return;
    try {
      await request("/logout", {});
      dirty = false;
      location.reload();
    } catch (e) {
      say(e.message);
    }
  });
  function nomination() {
    const box = h("details", {}, h("summary", {}, "Nominate a participant"));
    const name = h("input", { placeholder: "Full name", required: true }),
      email = h("input", {
        type: "email",
        placeholder: "Email address",
        required: true,
      }),
      role = h("input", { placeholder: "Role or area of expertise" });
    const form = h(
      "form",
      {},
      h("label", {}, "Name", name),
      h("label", {}, "Email", email),
      h("label", {}, "Role", role),
    );
    const submit = h(
      "button",
      { type: "submit", class: "primary" },
      "Suggest participant",
    );
    form.append(
      h(
        "p",
        { class: "muted" },
        "Your contact will confirm their details and send an invitation.",
      ),
      submit,
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await request("/nominate", {
          name: name.value,
          email: email.value,
          role: role.value,
        });
        form.reset();
        say("Participant suggested for review.");
      } catch (err) {
        say(err.message);
      } finally {
        submit.disabled = false;
      }
    });
    box.append(form);
    return box;
  }
  function render() {
    app.replaceChildren(
      h("h1", {}, `Hello, ${state.person.name.split(" ")[0]}`),
      h(
        "p",
        { class: "muted" },
        `${state.organization} · Your answers help the team make the next decision.`,
      ),
    );
    const accepted = state.questions.filter(
      (q) => q.state === "accepted",
    ).length;
    app.append(
      h(
        "div",
        { class: "summary" },
        h("progress", {
          max: Math.max(1, state.questions.length),
          value: accepted,
        }),
        h(
          "span",
          {},
          `${accepted} of ${state.questions.length} answers accepted`,
        ),
      ),
    );
    if (state.onboarding) {
      const summary = h("details", {}, h("summary", {}, "Team onboarding"));
      summary.append(
        h(
          "div",
          { class: "people" },
          state.onboarding.progress.map((p) =>
            h(
              "div",
              { class: "person" },
              h("strong", {}, p.name),
              h("p", { class: "muted" }, `${p.accepted} / ${p.total} accepted`),
            ),
          ),
        ),
        nomination(),
      );
      app.append(summary);
    }
    if (!state.questions.length) {
      app.append(
        h(
          "section",
          { class: "panel empty" },
          h("h2", {}, "You’re all set for now"),
          h("p", {}, "Your contact will assign questions relevant to you."),
          action("Refresh", refresh),
        ),
      );
      return;
    }
    selected =
      state.questions.find((q) => q.id === selected)?.id ||
      state.questions.find(
        (q) => !["accepted", "submitted", "rejected"].includes(q.state),
      )?.id ||
      state.questions[0].id;
    const list = h("nav", { class: "list", "aria-label": "Your questions" }),
      detail = h("section", { class: "panel" });
    state.questions.forEach((q) =>
      list.append(
        h(
          "button",
          {
            type: "button",
            class: "question",
            "aria-current": q.id === selected ? "true" : "false",
            onclick: () => {
              if (
                dirty &&
                !confirm("Switch questions without saving your answer?")
              )
                return;
              dirty = false;
              selected = q.id;
              render();
            },
          },
          h("span", { class: `badge ${q.priority}` }, q.priority),
          h("strong", {}, q.title),
          h(
            "small",
            {},
            q.state === "clarification" ? "Clarification requested" : q.state,
          ),
        ),
      ),
    );
    app.append(h("div", { class: "layout" }, list, detail));
    showQuestion(
      detail,
      state.questions.find((q) => q.id === selected),
    );
  }
  function showQuestion(host, q) {
    host.append(
      h("span", { class: `badge ${q.state}` }, q.state),
      h("h2", {}, q.title),
    );
    if (q.detail) host.append(h("p", {}, q.detail));
    if (q.why)
      host.append(h("p", { class: "muted" }, "Why this matters: " + q.why));
    if (q.due_at)
      host.append(
        h(
          "p",
          { class: "muted" },
          "Requested by " + new Date(q.due_at).toLocaleDateString(),
        ),
      );
    const latestReview = state.reviews.find((r) => r.question_id === q.id);
    if (latestReview?.comment)
      host.append(
        h(
          "div",
          { class: "feedback" },
          h("strong", {}, "From your reviewer"),
          h("p", {}, latestReview.comment),
        ),
      );
    const answers = state.answers.filter((a) => a.question_id === q.id);
    if (answers.length) {
      const history = h(
        "details",
        {
          ...(q.state === "submitted" ||
          q.state === "accepted" ||
          q.state === "rejected"
            ? { open: "" }
            : {}),
        },
        h(
          "summary",
          {},
          q.state === "accepted" ? "Accepted answer" : "Previous answers",
        ),
      );
      answers.forEach((a) =>
        history.append(
          h(
            "p",
            { class: "muted" },
            `${a.respondent_name || "You"} · ${new Date(a.submitted_at).toLocaleString()}`,
          ),
          h("div", { class: "answer" }, a.content),
          h(
            "ul",
            {},
            a.evidence.map((e) =>
              h(
                "li",
                {},
                h(
                  "a",
                  { href: e.url, target: "_blank", rel: "noopener noreferrer" },
                  e.label,
                ),
              ),
            ),
          ),
        ),
      );
      host.append(history);
    }
    if (["submitted", "accepted", "rejected"].includes(q.state)) {
      host.append(
        h(
          "p",
          { class: "muted" },
          q.state === "submitted"
            ? "Your answer is with the reviewer. You can return here for follow-up questions."
            : q.state === "rejected"
              ? "This question was closed by your reviewer."
              : "Your answer was accepted for the organization’s knowledge.",
        ),
        action("Check for updates", refresh),
      );
      return;
    }
    const input = h("textarea", {
      id: "answer",
      placeholder:
        "Share what you know. It is fine to explain what is uncertain.",
      value: q.draft_revision === q.revision ? q.draft_content || "" : "",
      oninput: () => (dirty = true),
    });
    const evidence = h("textarea", {
      placeholder: "https://example.com/source",
      value: (q.draft_revision === q.revision ? q.draft_evidence || [] : [])
        .map((e) => e.url)
        .join("\n"),
      oninput: () => (dirty = true),
    });
    host.append(
      h("label", { for: "answer" }, "Your answer"),
      input,
      h(
        "details",
        { class: "evidence" },
        h("summary", {}, "Add evidence links"),
        evidence,
      ),
    );
    const payload = () => ({
      content: input.value,
      questionRevision: q.revision,
      evidence: evidence.value
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((url) => ({ url, label: url })),
    });
    host.append(
      h(
        "div",
        { class: "actions" },
        action(
          "Submit answer",
          async () => {
            await request(`/questions/${q.id}/answer`, payload());
            dirty = false;
            say("Answer submitted for review.");
            await refresh();
          },
          true,
        ),
        action("Save for later", async () => {
          await request(`/questions/${q.id}/draft`, payload());
          dirty = false;
          say("Draft saved.");
        }),
      ),
    );
    const delegate = h(
      "details",
      {},
      h("summary", {}, "Someone else should answer"),
    );
    const reason = h("textarea", {
      placeholder: "Who would know, or what help do you need?",
    });
    delegate.append(
      reason,
      action("Ask to reassign", async () => {
        await request(`/questions/${q.id}/delegate`, { comment: reason.value });
        reason.value = "";
        say("Your contact has received the request.");
      }),
    );
    host.append(delegate);
  }
  async function start() {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const token = params.get("invite");
      if (token) {
        history.replaceState(null, "", "/customer");
        await request("/redeem", { token });
      }
      await refresh();
    } catch (e) {
      app.replaceChildren(
        h(
          "section",
          { class: "panel empty" },
          h("h1", {}, "Your customer workspace"),
          h("p", { class: "error" }, e.message),
          h(
            "p",
            { class: "muted" },
            "Use the private invitation link from your contact. Each link can be used once.",
          ),
          action("Try again", refresh),
        ),
      );
    }
  }
  void start();
})();
