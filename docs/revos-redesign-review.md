# revOS redesign review

September 17, 2026

## Recommendation

Build revOS around **customer engagements and their deliverables**. Keep the existing Temporal/agent division of responsibility, but give the product a stronger model for versions, reviews, knowledge, and products.

The organizing structure should be:

**Organization → Engagement → Stage → Deliverable → Human decision**

Workflow runs, steps, skills, tool calls, and provider events remain available as execution details. A user opening revOS should first understand **what we are trying to achieve, what we learned or built, and what needs their input**.

The complete reusable implementation prompt is [revOS rebuild prompt](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/docs/revos-rebuild-prompt.md). It stands alone and includes the original discovery business requirements, four-stage journey, architecture, UX, integrations, migration, and acceptance tests.

## Review scope and confidence

This review combines the supplied conversation, both original pasted requirements, and a source-level architectural review of the API/UI, authoring, agent loop, Temporal activities/workflows, data model, knowledge, artifacts, products, assistants, deployment configuration, and test coverage. Three parallel reviews covered execution, UX, and infrastructure.

This is an architectural and requirements review, not a claim that every line has been formally verified. No live workflow was approved, rerun, or changed, no customer data was migrated, and no model/build/deployment smoke test was performed for this review. Existing test files were inspected as evidence of intended coverage; their presence does not prove the current stack passes them. Historical documentation sometimes conflicts with current source.

## What is already valuable

- The generic engine separates executable capability code from business definitions.
- Workflow and skill versions are pinned for execution.
- The OpenAI Agents SDK produces bounded action decisions; Temporal performs durable orchestration.
- Human questions, reviews, revisions, customer matching, knowledge corrections, and stage handoffs already exist.
- Skill/step results can produce retained files and organization knowledge.
- Forgejo knowledge repositories, generated mind maps, and OpenHands static builds provide useful working foundations.
- Run, Library, and Organizations are a sensible top-level navigation structure.

These are worth preserving. A redesign should replace unclear contracts and duplicated state management, rather than discard the entire engine.

## Highest-priority changes

| Priority | Finding in the prototype | Proposed replacement |
| --- | --- | --- |
| 1 | Review meaning differs between a fixed human step, agent review, and engagement gate. The displayed payload is not a canonical immutable deliverable. | One review model tied to exact deliverable versions and artifact hashes; explicit step revision, stage rerun, pause, and stop. |
| 1 | The Run UI layers engagement and workflow state together. | A dedicated engagement workspace with stage rail, deliverables, decisions, and a separate execution inspector. |
| 1 | Assistant context primarily passes workflow/run identifiers and does not capture every selectable object. | A typed, visible context envelope covering organization, chain, engagement, stage, step, skill, document, product, and revision. |
| 1 | Context repeatedly contains full inputs, history, and completed outputs. Some transactions enclose slow external calls. | Token-aware context assembly with retained evidence references; short operation claims and idempotent/reconciled external work. |
| 2 | Products are inferred from build parentage and brief text. | First-class Product, Version, Build, Deployment, Preview, and Feedback records. |
| 2 | Knowledge has overlapping database/Git representations and explicit synchronization operations. | One accepted revision model, durable Git synchronization, reviewed external edits, derived retrieval/map projections. |
| 2 | Outputs are often generic formatting of arbitrary keys. | Typed business deliverables with semantic presentation, source links, and independently generated exports. |
| 2 | Chain templates have basic workflow selections and implicit handoffs. | Versioned chains with a real intake form, ordered stages, typed mappings, required deliverables, and review policies. |
| 2 | Engagement progression primarily polls database state. | Temporal parent/child execution with durable commands and explicit stage transitions; polling retained for recovery/external systems. |
| 3 | OpenHands canvas, workflow builds, networking, and model configuration differ. | One coding-service contract and tested provider profiles; verified Kubernetes sandbox backend and deployment ownership. |
| Required before remote exposure | Local org filtering, private repositories, and restricted build jobs do not constitute production tenant security. | Authenticated access, server-side authorization, scoped credentials, sandbox enforcement, preview isolation, backups, and safe rollout. |

### Why the review model comes first

Current revision handling successfully prevents an agent from finishing while a requested revision is pending. But agent revisions continue the current step, fixed checkpoints can still fail on rejection, and engagement revisions create a new run. These are different operations with different costs and effects.

The interface should say, for example:

> You are reviewing Opportunity Brief revision 3. Approving it starts Research using this version. Requesting changes reruns the Understand stage with your feedback and returns here for another review.

The approved object must stay immutable. A later model response cannot silently become the “approved” output. Revisions also need their own visible allowance, because the current agent loop uses the original session turn budget for every review cycle.

## Tools and capability inventory

The following names are registered in the current worker. Additional capabilities exist outside that registry.

| Current tool | Actual role | Rebuild implication |
| --- | --- | --- |
| `property.search` | Synthetic property search fixture. | Keep for deterministic tests; do not present as a live lead source. |
| `openai.web_research` | Hosted OpenAI web research with evidence/citations. | Preserve; attach usage, source dates, evidence identity, and a durable operation boundary. |
| `knowledge.search` | Customer-scoped knowledge lookup. | Enforce authenticated ownership and distinguish current accepted records from historical evidence. |
| `knowledge.propose` | Proposes knowledge notes/corrections. | Share the same change/review services as the UI and repository importer. |
| `openhands.start_build` | Begins a bounded coding build. | Create a product/version first and associate the coding operation with it. |
| `openhands.revise_build` | Creates a revision from prior work and feedback. | Bind feedback, requirements, source base, and intended version explicitly. |
| `openhands.inspect_build` | Inspects build state/results. | Separate coding, build, and deployment state. |
| `openhands.create_preview` | Coordinates a static preview. | Persist deployment evidence, artifact digest, URL, health, and authorization. |

Other implemented action/service families include skill selection/completion, knowledge fetching, `ask_human`, review waiting, artifact generation, organization resolution, knowledge import/correction/reconciliation, mind-map generation, assistant proposals, and engagement coordination. They should be discoverable in the product without pretending they all have identical execution semantics.

In particular:

- A skill teaches an agent how to perform a task; a tool is an executable capability.
- Asking a human is a durable interaction capability that a skill may use.
- The SDK does not inherently “make a PDF”; the configured renderer or hosted Code Interpreter does the file work.
- OpenHands generates code; revOS must verify builds and coordinate preview publication.
- Git access does not itself synchronize knowledge or publish a new product version.

## Source evidence

These are representative implementation anchors supporting the findings, not an exhaustive file listing:

| Area | Source |
| --- | --- |
| SDK planner with no executable tools and one decision per call | [openai-agent.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/openai-agent.ts:159) |
| Durable action loop and shared session turn limit | [agent-loop.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/temporal/src/workflows/agent-loop.ts:51) |
| Session persistence, review application, and transactional execution | [sessions.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/temporal/src/activities/sessions.ts:44) |
| Engagement polling and stage business logic | [engagement workflow](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/temporal/src/workflows/engagement.ts:12), [engagement service](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/engagement.ts) |
| Current assistant context payload | [section-assistant.js](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/apps/api/src/section-assistant.js:275) |
| Generic output renderer | [output-view.js](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/apps/api/src/output-view.js) |
| Product identity derived from root build | [organization-products.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/organization-products.ts:19) |
| Local-only preview acceptance | [knowledge.js](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/apps/api/src/knowledge.js:776) |
| Knowledge service, reconciliation, and map synthesis | [workspace-service.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/workspace-service.ts), [knowledge-reconciliation.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/knowledge-reconciliation.ts), [mindmap.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/mindmap.ts) |
| Registered worker tools | [worker index](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/apps/worker/src/index.ts) |
| Artifact provider and retained output handling | [artifact-generator.ts](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/packages/engine/src/artifact-generator.ts) |
| Kubernetes workflow builds versus canvas Docker access/model workaround | [build.py](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/apps/openhands/build.py), [openhands-web.yaml](/Users/saber/.codex/.chatgpt-projects/g-p-6aa97271aa648191b6944b5e3c9885c2/agent-engine/infrastructure/kubernetes/local/openhands-web.yaml:54) |

## Explicit design choices in the new prompt

### Retain the hybrid agent architecture

The main assistant can start and manage work through application commands. Within that work, agents select the next allowed action. Temporal owns the durable wait/retry/progression. This avoids choosing between an assistant that cannot act and a single autonomous loop that bypasses workflow policy.

Use parent/child workflows for engagement stages where their lifecycles belong together. Activities still require idempotency: a provider operation may succeed before the worker loses its acknowledgment. Temporal documents both child workflow ownership and this retry boundary. [Child workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows), [Activity idempotency](https://docs.temporal.io/activity-definition).

### Make accepted knowledge ownership unambiguous

My recommended choice is PostgreSQL for accepted semantic revisions and review state, with Forgejo as the versioned, portable, editable repository representation. External Git edits re-enter the same acceptance process. This is a proposed architecture decision, not a claim that the original user required PostgreSQL to be the knowledge authority.

The important property is one accepted revision model and reliable synchronization. A repository commit, a model inference, and a customer-confirmed fact are different things.

### Keep generated outputs grounded

Use semantic result views first, with optional downloadable files and presentation sites. Hosted web research should expose clickable citations; OpenAI explicitly requires visible, clickable inline citations when its web results are shown to users. [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).

Retain generated files independently of the provider sandbox. Code Interpreter containers are ephemeral, so provider file references alone are not durable artifacts. [OpenAI Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter).

### Unify coding through a provider boundary

The current canvas deployment is in Kubernetes, but its coding sandboxes use Docker through host access. Workflow builds are separate Kubernetes Jobs. That migration is not finished. The OpenHands SDK documents a remote-workspace boundary; a supported Kubernetes backend, persistent storage, licensing, and canvas integration still need explicit verification for the chosen version. [OpenHands RemoteWorkspace](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.workspace).

The new product should own product identity, build verification, source lineage, preview deployment, and feedback regardless of the coding provider's internals.

## Coverage map for the reusable prompt

| Conversation requirement | Prompt sections |
| --- | --- |
| Generic engine, immutable definitions, durable model-selected skill/tool execution | 2, 6, 15–18 |
| Clear Run/Library/Organizations navigation, separate tools/chains tabs, compact skills selection | 4–6 |
| Original discovery economics, 12 steps, 13 skills, complete output brief | 7 |
| Understand → Research → Proposal → Product and approval chaining | 5–8, 16 |
| Human questions, feedback rounds, actual material before approval | 8 |
| Readable step/skill results, artifacts, presentation sites and interactive tools | 9, 13 |
| Organization matching, customer-specific Forgejo knowledge, corrections | 10 |
| Agent-generated updated mind map, guided explanation, audio and input capture | 11 |
| Real sourced leads and customer qualification | 12 |
| Product list, previews, source, OpenHands canvas, revision feedback | 13 |
| Assistants in all three sections with selected-object awareness | 14 |
| Hosted research, tool visibility, model compatibility, TPM/context/timeouts | 16–18 |
| Kubernetes, service links, Git/preview networking, reliable startup | 4, 13, 20 |
| Preserve existing Discovery, NYC Luxury/SG Home Design data and history | 23 |
| Honest current capability inventory and incomplete integrations | 24 |
| Implementation order and observable definition of done | 21–22, 25 |

## Where I would start

Build one complete path first: **start an engagement → answer a question → inspect a readable brief → request changes → review revision 2 → approve the next stage**.

That path forces the foundational contracts and UX to work together. Then add knowledge synchronization, richer artifacts, and product building to the same model. Preserve the existing application and histories during this work; a redesigned architecture does not require a destructive big-bang replacement.
