(() => {
  const root = document.getElementById("engagement-workspace"),
    mode = root.dataset.mode;
  let selected = new URLSearchParams(location.search).get("engagement") || "",
    data = null,
    signature = "",
    busy = false,
    templates = [];
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  async function api(p, b) {
    const r = await fetch(
      p,
      b === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(b),
          },
    );
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Request failed");
    return d;
  }
  const notice = el("p");
  notice.className = "eg-notice";
  function button(text, fn) {
    const n = el("button", text);
    n.type = "button";
    n.onclick = async () => {
      n.disabled = true;
      notice.textContent = "";
      try {
        await fn();
      } catch (e) {
        notice.textContent = e.message;
      } finally {
        n.disabled = false;
      }
    };
    return n;
  }
  function select(items) {
    const n = el("select");
    for (const [id, label] of items) {
      const o = el("option", label);
      o.value = id;
      n.append(o);
    }
    return n;
  }
  function link(text, url) {
    const a = el("a", text);
    a.href = url;
    return a;
  }
  const title = el(
      "h2",
      mode === "library" ? "Workflow chains" : "Customer engagements",
    ),
    intro = el(
      "p",
      mode === "library"
        ? "Connect published workflows. Each stage requires approval before the next starts. Existing engagements retain their pinned versions."
        : "Understand → Research → Proposal → Product. Review each stage, request revisions, and approve the handoff.",
    );
  root.append(title, intro, notice);
  const controls = el("div");
  controls.className = "eg-row";
  root.append(controls);
  const body = el("div");
  root.append(body);
  async function initialize() {
    templates = await api("/engagement-templates");
    if (mode === "library") {
      const cat = await api("/builder/catalog"),
        ws = await api("/workflows");
      const tsel = select([
        ["", "New chain"],
        ...templates.map((t) => [t.id, t.name]),
      ]);
      tsel.setAttribute("aria-label", "Workflow chain");
      controls.append(el("label", "Workflow chain"), tsel, button("+ New chain", () => {
        tsel.value = "";
        render();
      }));
      const render = () => {
        body.replaceChildren();
        const t = templates.find((t) => t.id === tsel.value),
          name = el("input");
        name.value = t?.name || "";
        name.placeholder = "Chain name";
        name.setAttribute("aria-label", "Chain name");
        const org = select(cat.organizations.map((o) => [o.id, o.name]));
        org.value =
          t?.organization_id ||
          cat.organizations.find((o) => o.kind === "platform")?.id ||
          "";
        body.append(name, org);
        let stages = (
          t?.stages || [
            { name: "Understand", workflowId: "" },
            { name: "Research", workflowId: "" },
            { name: "Proposal", workflowId: "" },
            { name: "Product", workflowId: "" },
          ]
        ).map((s) => ({ ...s }));
        const list = el("div");
        body.append(list);
        function draw() {
          list.replaceChildren();
          stages.forEach((s, i) => {
            const row = el("div");
            row.className = "eg-row";
            const label = el("input");
            label.value = s.name;
            label.setAttribute("aria-label", `Stage ${i + 1} name`);
            label.oninput = () => (s.name = label.value);
            const pick = select([
              ["", "Select published workflow"],
              ...ws
                .filter(
                  (w) =>
                    w.currentVersionId &&
                    (w.organizationId === org.value ||
                      cat.organizations.find((o) => o.id === w.organizationId)
                        ?.kind === "platform"),
                )
                .map((w) => [w.id, w.name]),
            ]);
            pick.value = s.workflowId;
            pick.setAttribute("aria-label", `Stage ${i + 1} workflow`);
            pick.onchange = () => (s.workflowId = pick.value);
            row.append(
              el("span", String(i + 1)),
              label,
              pick,
              button("Remove", () => {
                stages.splice(i, 1);
                draw();
              }),
            );
            list.append(row);
          });
        }
        draw();
        org.onchange = draw;
        body.append(
          button("Add stage", () => {
            stages.push({ name: "New stage", workflowId: "" });
            draw();
          }),
          button("Save chain", async () => {
            const saved = await api("/engagement-templates", {
              id: t?.id,
              revision: t?.revision,
              organizationId: org.value,
              name: name.value,
              stages,
            });
            templates = await api("/engagement-templates");
            tsel.replaceChildren(...select([["", "New chain"], ...templates.map((item) => [item.id, item.name])]).children);
            tsel.value = saved.id;
            render();
            notice.textContent = "Chain saved. Select another chain or create a new one. Available in Run.";
          }),
        );
      };
      tsel.onchange = render;
      render();
      return;
    }
    const choose = select([["", "Choose engagement"]]);
    choose.setAttribute("aria-label", "Customer engagement");
    const refreshList = async () => {
      const list = await api("/engagements");
      const prev = selected;
      choose.replaceChildren(
        ...select([
          ["", "Choose engagement"],
          ...list.map((e) => [e.id, e.name + " · " + e.state]),
        ]).children,
      );
      choose.value = prev;
    };
    await refreshList();
    choose.onchange = () => {
      selected = choose.value;
      signature = "";
      const u = new URL(location.href);
      if (selected) u.searchParams.set("engagement", selected);
      else u.searchParams.delete("engagement");
      u.searchParams.set("mode", "engagements");
      u.searchParams.delete("run");u.searchParams.delete("workflow");
      location.assign(u.toString());
    };
    controls.append(
      choose,
      button("Refresh", async () => {
        await refreshList();
        await refresh();
      }),
    );
    const create = el("dialog");
    create.className = "eg-start-dialog";
    const form = el("form"), name = el("input");
    name.required = true;
    name.setAttribute("aria-label", "Engagement name");
    const template = select(templates.map((t) => [t.id, t.name]));
    template.setAttribute("aria-label", "Workflow chain");
    const fields = el("div"), overview = el("p"), formStatus = el("p");
    formStatus.setAttribute("role", "status");
    let readInput = () => ({}), loading = false, formGeneration = 0;
    function label(text, control) {
      const n = el("label", text);
      control.id = "eg-" + crypto.randomUUID();
      n.htmlFor = control.id;
      const wrap = el("div"); wrap.className = "eg-field";
      wrap.append(n, control); return wrap;
    }
    function field(schema, key, required, initial) {
      const type = Array.isArray(schema.type) ? schema.type.find(t => t !== "null") : schema.type;
      const title = schema.title || key.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
      if (type === "object" && schema.properties) {
        const box = el("fieldset"); box.append(el("legend", title));
        const readers = Object.entries(schema.properties).map(([k,v]) => {
          const f = field(v,k,(schema.required || []).includes(k),initial?.[k]);box.append(f.node);return [k,f.read];
        });
        return {node:box,read:()=>Object.fromEntries(readers.map(([k,r])=>[k,r()]).filter(([,v])=>v!==undefined))};
      }
      let control;
      if (schema.enum) {
        control = select([["", "Choose…"], ...schema.enum.map((v,i)=>[String(i),String(v)])]);
        const idx=schema.enum.indexOf(initial ?? schema.default);control.value=idx<0?"":String(idx);
      } else {
        control = el(type === "array" || type === "object" || /notes|problem|description|brief/.test(key) ? "textarea" : "input");
        if (type === "boolean") control.type="checkbox";
        else if (type === "number" || type === "integer") {control.type="number";control.step=type==="integer"?"1":"any";}
        else if (schema.format === "email") control.type="email";
        const value=initial ?? schema.default;
        if(type === "boolean") control.checked=value ?? false;
        else if(value!==undefined) control.value=typeof value === "object"?JSON.stringify(value,null,2):String(value);
        if(schema.minimum!==undefined)control.min=schema.minimum;
        if(schema.maximum!==undefined)control.max=schema.maximum;
        if(schema.minLength!==undefined)control.minLength=schema.minLength;
        if(schema.maxLength!==undefined)control.maxLength=schema.maxLength;
        if(schema.pattern)control.pattern=schema.pattern;
      }
      control.required=required && type!=="boolean";
      const node=label(title+(required?" *":""),control);
      if(schema.description)node.append(el("small",schema.description));
      if(type === "array")node.append(el("small",schema.items?.type === "string" ? "One item per line." : "Enter a JSON array."));
      if(type === "object")node.append(el("small","Enter a JSON object."));
      return {node,read:()=>{
        if(schema.enum)return control.value===""?undefined:schema.enum[Number(control.value)];
        if(type==="boolean")return control.checked;
        if(control.value.trim()==="")return undefined;
        if(type==="number"||type==="integer")return Number(control.value);
        if(type==="array"&&schema.items?.type==="string")return control.value.split("\n").map(v=>v.trim()).filter(Boolean);
        if(type==="array"||type==="object") {try{return JSON.parse(control.value);}catch{throw Error(title+" must contain valid JSON.");}}
        return control.value;
      }};
    }
    async function loadForm() {
      const generation=++formGeneration;loading=true;startButton.disabled=true;
      fields.replaceChildren();formStatus.textContent="Loading starting questions…";
      try {
        const chain=templates.find(t=>t.id===template.value);
        if(!chain?.stages?.length)throw Error("Choose a chain with a published starting workflow.");
        const workflow=await api("/workflows/"+chain.stages[0].workflowId);
        if(generation!==formGeneration)return;
        if(!workflow.version)throw Error("Publish the starting workflow first.");
        overview.textContent=chain.stages.map(s=>s.name).join(" → ");
        const schema=workflow.version.inputSchema || {type:"object"};
        const readers=Object.entries(schema.properties || {}).filter(([key])=>key!=="engagement").map(([key,value])=>{
          const f=field(value,key,(schema.required||[]).includes(key));fields.append(f.node);return [key,f.read];
        });
        readInput=()=>Object.fromEntries(readers.map(([key,read])=>[key,read()]).filter(([,value])=>value!==undefined));
        formStatus.textContent=readers.length ? "* Required. Questions come from the first published workflow." : "This workflow has no defined starting questions.";
        startButton.disabled=false;
      } catch(e){formStatus.textContent=e.message;}
      finally {if(generation===formGeneration)loading=false;}
    }
    const customer = select([
      ["", "Detect customer from inputs"],
      ...(await api("/customers")).map((o) => [o.id, o.name]),
    ]);
    customer.setAttribute("aria-label", "Engagement customer");
    const startButton=button("Start engagement",async()=>{
      if(loading || !form.reportValidity())return;
      try {
        const e=await api("/engagements",{templateId:template.value,name:name.value,input:readInput(),customerOrganizationId:customer.value||undefined});
        selected=e.id;signature="";create.close();location.assign("/?mode=engagements&engagement="+e.id);
      } catch(e) {formStatus.textContent=e.message;}
    });
    startButton.disabled=true;
    form.onsubmit=e=>{e.preventDefault();if(!startButton.disabled)startButton.click();};
    form.append(el("h2","Start an engagement"),label("Engagement name *",name),label("Workflow chain",template),overview,label("Customer organization",customer),fields,formStatus,el("p","Starting begins the first workflow and model calls. You approve each stage before the next starts."),startButton,button("Cancel",()=>create.close()));
    template.onchange=loadForm;
    create.append(form);root.append(create);
    controls.append(button("Start a new engagement",()=>{create.showModal();void loadForm();}));
    await refresh();
    setInterval(refresh, 3000);
  }
  async function refresh() {
    if (mode !== "run" || busy) return;
    busy = true;
    try {
      if (!selected) {
        body.replaceChildren();
        return;
      }
      const e = await api("/engagements/" + selected);
      data = e;
      window.showEngagementContext?.(e);
      const activeAttempt =
        e.attempts.filter((a) => a.stage_index === e.stage_index).at(-1) ||
        e.attempts.at(-1);
      const builds = activeAttempt
        ? await api("/runs/" + activeAttempt.run_id + "/builds")
        : [];
      const sig = JSON.stringify({ e, builds });
      if (sig === signature) return;
      signature = sig;
      body.replaceChildren();
      const stages = el("div");
      stages.className = "eg-stages";
      e.stages.forEach((s, i) => {
        const n = el("div", `${i + 1}. ${s.name}`);
        n.className =
          "eg-stage" +
          (i === e.stage_index ? " current" : "") +
          (i < e.stage_index ? " approved" : "");
        const attempt = e.attempts.filter(a => a.stage_index === i).at(-1);
        if (attempt) {
          n.append(el("div", attempt.run_status), link("View stage execution", `/?mode=engagements&workflow=${s.workflowId}&run=${attempt.run_id}&engagement=${e.id}`));
        } else n.append(el("div", "Not started"));
        stages.append(n);
      });
      body.append(el("h3", e.name), stages, el("p", "Engagement status: " + e.state.replaceAll("_", " ")));
      if (e.error) body.append(el("p", e.error));
      const a =
        e.attempts.filter((a) => a.stage_index === e.stage_index).at(-1) ||
        e.attempts.at(-1);
      if (!a) return;
      body.append(
        el("h3", `Current stage: ${e.stages[a.stage_index].name} · Attempt ${a.revision}`),
        link(
          "View current stage execution →",
          `/?workflow=${e.stages[a.stage_index].workflowId}&run=${a.run_id}&engagement=${e.id}`,
        ),
      );
      const output = el("details");
      output.append(el("summary", "Review this stage result"));
      const result = el("div");
      result.className = "eg-output";
      if (a.output !== null && a.output !== undefined) {
        if (window.OutputView)
          result.append(window.OutputView.render(a.output, "report"));
        else result.append(el("pre", JSON.stringify(a.output, null, 2)));
      } else
        result.textContent =
          "This stage is still executing. Open its run to answer questions.";
      output.append(result);
      body.append(output);
      const source = select([
        ["operator", "Operator feedback"],
        ["customer", "Customer statement / approval"],
      ]);
      source.setAttribute("aria-label", "Feedback source");
      const feedback = el("textarea");
      feedback.placeholder = "Questions, corrections, or requested changes…";
      feedback.setAttribute("aria-label", "Stage feedback");
      const draftKey = "engagement-feedback:" + e.id + ":" + a.id;
      source.value = sessionStorage.getItem(draftKey + ":source") || "operator";
      source.onchange = () =>
        sessionStorage.setItem(draftKey + ":source", source.value);
      feedback.value = sessionStorage.getItem(draftKey) || "";
      feedback.oninput = () => sessionStorage.setItem(draftKey, feedback.value);
      body.append(source, feedback);
      async function decide(action) {
        await api(`/engagements/${e.id}/decision`, {
          attemptId: a.id,
          action,
          feedback: feedback.value,
          source: source.value,
        });
        sessionStorage.removeItem(draftKey);
        signature = "";
        await refresh();
      }
      const actions = el("div");
      actions.className = "eg-row";
      actions.append(
        button("Send feedback to agent", async () => {
          await api(`/runs/${a.run_id}/feedback`, {
            content: feedback.value,
            source: source.value,
          });
          feedback.value = "";
          sessionStorage.removeItem(draftKey);
          notice.textContent =
            "Feedback saved. The agent reads it at its next reasoning turn. For completed stages, choose Request changes.";
        }),
      );
      if (e.state === "paused")
        actions.append(button("Resume", () => decide("resume")));
      else if (e.state !== "completed") {
        actions.append(button("Pause progression", () => decide("pause")));
        if (["awaiting_approval", "failed"].includes(a.state))
          actions.append(button("Request changes", () => decide("revise")));
        if (a.state === "awaiting_approval")
          actions.append(
            button(
              e.stage_index === e.stages.length - 1
                ? "Approve final version"
                : "Approve and start next stage",
              () => decide("approve"),
            ),
          );
      }
      body.append(actions);

      for (const b of builds) {
        const row = el("p", `OpenHands build · ${b.state} `);
        if (b.error) row.append(el("span", b.error));
        if (b.result?.codeUrl) {
          const l = link("Source code", b.result.codeUrl);
          l.target = "_blank";
          l.rel = "noopener";
          row.append(l);
        }
        if (b.result?.previewUrl) {
          const l = link(" · Open preview", b.result.previewUrl);
          l.target = "_blank";
          l.rel = "noopener";
          row.append(l);
        } else if (b.state === "completed")
          row.append(
            button("Create preview", async () => {
              await api("/builds/" + b.id + "/preview", {});
              signature = "";
              await refresh();
            }),
          );
        body.append(row);
      }
      const history = el("details");
      history.append(el("summary", "Stage and revision history"));
      for (const x of e.attempts)
        history.append(
          el(
            "p",
            `${e.stages[x.stage_index].name} · attempt ${x.revision} · ${x.state}${x.decision_by ? " · " + x.decision_by : ""}${x.feedback ? " · " + x.feedback : ""}`,
          ),
          link(
            "View run",
            `/?workflow=${e.stages[x.stage_index].workflowId}&run=${x.run_id}&engagement=${e.id}`,
          ),
        );
      body.append(history);
    } catch (err) {
      notice.textContent = err.message;
    } finally {
      busy = false;
    }
  }
  initialize().catch((e) => (notice.textContent = e.message));
})();
