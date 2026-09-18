# Agent Engine

A durable execution platform for turning business SOPs into reusable,
database-configured agent workflows.

Business-specific configuration lives in PostgreSQL.

Durable execution lives in Temporal.

Application workloads run on Kubernetes.

## OpenAI playground and durable agent sessions

The [Agent Sessions guide](docs/agent-sessions.md) covers the playground at **http://localhost:3000**, model-selected skills, explicit knowledge retrieval, and durable per-turn/tool execution. Temporal UI remains at port 8080.

After starting the stack, run `pnpm db:migrate` and `pnpm db:seed:agent`. Put your key in the Git-ignored `.env.openai.local` file, run `pnpm secrets:openai`, then open the playground. Its model reasoning is live; the included property tool returns clearly labeled synthetic data.

## Workflow authoring

Open **http://localhost:3000/builder** to create drafts, define inputs and outputs, arrange agent tasks/fixed skills/approval steps, manage skills and knowledge, test snapshots, and publish immutable versions. See the [Workflow Builder guide](docs/workflow-builder.md).

## Prerequisites

- Docker running (Linux containers; arm64 and amd64 supported by the selected images)
- kubectl and an active **local** Kubernetes context (Docker Desktop, kind, or minikube)
- A default StorageClass with at least 2 GiB available; about 4 GiB free cluster RAM
- Skaffold 2.17+ (configuration v4beta13; verified with 2.24)
- Helm 3+ for future production Temporal deployments; not needed by the local manifests
- Node.js 22 LTS and pnpm 10.30.3 (`corepack enable` uses the pinned package manager)

All application services and databases run in Kubernetes. Host Node/pnpm only run development commands.
No API keys are needed. No actual people or properties are researched.

## Running

From this repository directory:

```bash
pnpm install --frozen-lockfile
kubectl config current-context
skaffold dev
```

Wait for the deployments to stabilize and ports to be forwarded. In a second terminal, from this directory:

```bash
pnpm db:migrate
pnpm db:seed
pnpm demo
```

The API can become ready before application migrations: readiness checks connectivity. Brief missing-table messages from the pending-run dispatcher stop once migrations finish.

Skaffold builds both images, deploys the `agent-engine-local` namespace, streams logs, watches source files, and rebuilds/redeploys automatically. The `local` profile is automatically selected for `dev`; `skaffold dev -p local` is equivalent. `skaffold run` performs one deployment; it does not establish the development port forwards.

| Service | Local endpoint |
|---|---|
| API | http://localhost:3000 |
| Temporal UI | http://localhost:8080 |
| Application PostgreSQL | 127.0.0.1:15432 |
| Temporal frontend (test/debug) | localhost:7233 |

Port 15432 avoids clashing with common existing PostgreSQL installations. If a requested port is already occupied, Skaffold may select another port: read its output and set `DATABASE_URL`, `API_URL`, or `TEMPORAL_ADDRESS` accordingly. Do not connect migrations to an unrelated database.

The demo prints Task/Run/Temporal IDs, five completed steps, and a structured report with `synthetic: true`, `reviewRequired: true`, and `outreachAllowed: false`. The mock model returns the stored fixtures; it does not extract arbitrary real inputs.

Open Temporal UI, choose namespace `default`, and select the printed `run:<uuid>` execution.

### Run initialization inside Kubernetes instead

The API image contains compiled scripts and Drizzle migration files:

```bash
kubectl -n agent-engine-local exec deployment/api -- node dist/scripts/migrate.js
kubectl -n agent-engine-local exec deployment/api -- node dist/scripts/seed.js
kubectl -n agent-engine-local exec deployment/api -- node dist/scripts/run-example.js
```

For debugging without Skaffold port forwarding:

```bash
kubectl -n agent-engine-local port-forward service/api 3000:3000
kubectl -n agent-engine-local port-forward service/postgres 15432:5432
kubectl -n agent-engine-local port-forward service/temporal-frontend 7233:7233
kubectl -n agent-engine-local port-forward service/temporal-ui 8080:8080
```

Each port-forward occupies its own terminal. Stop it before starting `skaffold dev`.

## Commands and tests

```bash
pnpm typecheck
pnpm build
pnpm test
# With the deployment and port forwards running:
pnpm test:integration
# After editing the Drizzle schema, review and commit the generated migration:
pnpm db:generate
```

Unit tests cover handler resolution, generic model fixtures, validation, and input bindings. Integration tests use real PostgreSQL and Temporal: seed relationships/idempotency, immutable versions, synthetic execution, a completely unrelated onboarding workflow, v2 publication, human-review signals, and failure state. Tests add clearly synthetic workflows to the local database.

Migrations include SQL triggers. Never use `drizzle-kit push` to replace the migration history or edit already-applied migrations. New workflow/skill instructions require new version rows. Insert ordered steps before publishing `currentVersionId`. Seed is transactional and leaves an existing v1 unchanged.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Process liveness |
| GET | `/ready` | PostgreSQL and Temporal connectivity |
| GET | `/workflows` | List workflows |
| GET | `/workflows/:id` | Current version and ordered steps |
| POST | `/workflows/:id/runs` | Body: `{"input": {...}, "agentId": "optional UUID"}` |
| GET | `/runs/:id` | State, pinned definition, output, ordered RunSteps |
| POST | `/runs/:id/review` | Body: `{"stepKey":"approve","approved":true,"note":"..."}` |

The optional agentId is required when an organization has multiple agents. Starting a run returns HTTP 202 with a persisted pending Run; a dispatcher retries interrupted Temporal starts using the unique `run:<uuid>` ID. API request resubmission creates a new Task; HTTP idempotency keys are not implemented.

This is a local unauthenticated development API. It has no production tenant access-control layer.

## Configuration

See `.env.example`. Defaults match Skaffold port forwarding. The file is a reference; scripts read process environment variables, not an automatically loaded `.env` file.

- `DATABASE_URL`: only application database connection setting
- `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`
- `TEMPORAL_TLS=true` and `TEMPORAL_API_KEY`: optional Temporal Cloud configuration
- `MODEL_PROVIDER=mock` (default) or `openai`
- `OPENAI_API_KEY`, `OPENAI_MODEL`: optional provider credentials/model
- `API_URL`: host demo/test API endpoint

Without an API key, the provider falls back to deterministic mock fixtures. An unknown provider name fails startup. The optional OpenAI adapter is isolated from orchestration and validates returned JSON against the database schema. No paid provider calls are part of the acceptance test.

Local secrets contain deliberately public development credentials. Real credentials belong in externally managed Secrets. PostgreSQL stores application data in `agent_engine`; Temporal uses `temporal_persistence` and `temporal_visibility`, with a separate user.

## Stop and clean-start validation

Stopping `skaffold dev` normally cleans up its deployment. **Its local resources include the PVC and namespace; treat this as disposable development data.** Use `skaffold dev --cleanup=false` if you need to preserve the deployment and PVC between sessions. PostgreSQL data survives ordinary pod restarts/redeployments while the PVC remains.

To reproduce an empty-database acceptance test, stop the previous development session, then remove only this project's disposable namespace:

```bash
kubectl delete namespace agent-engine-local --wait=true
skaffold dev
# Second terminal, after readiness and port forwarding:
pnpm db:migrate
pnpm db:seed
pnpm demo
pnpm test:integration
```

Deleting the namespace deliberately discards its development data. Do not run the local overlay against a production context.

## Architecture and next steps

- [Architecture](docs/architecture.md)
- [Concepts](docs/concepts.md)
- [Day 1 validation and Week 1 direction](docs/day-1.md)

`infrastructure/kubernetes/base` contains reusable API/Worker manifests. `local` adds PostgreSQL, the official Temporal auto-setup image, UI, local configuration and secrets. `production` is a placeholder referencing only the app base. Production will provide managed PostgreSQL, Temporal Cloud or a managed self-hosted Temporal installation, ingress, secrets, and observability. No production deployment is configured today.

### OpenAI web research and customer discovery

The worker registers `openai.web_research`, backed by the Agents SDK's hosted
`webSearchTool`. Enable its catalog entry with `POST /builder/tools/enable`
(`{"slug":"openai-web-research"}`), then grant it to individual skill versions.
The API never receives the OpenAI key. The worker uses `OPENAI_API_KEY` and the
optional `OPENAI_RESEARCH_MODEL` (default `gpt-4.1-mini`). Each research request is
one durable Temporal tool activity. OpenAI manages searches inside that request;
individual hosted searches are not separate Temporal activities. Public search
metadata, cited passages, source links, and retrieval time are persisted. A retry
before the result is checkpointed can incur another provider charge.

`config/customer-opportunity-discovery.json` contains the reusable business
configuration and clearly synthetic first input. From an empty catalog,
`pnpm exec tsx scripts/create-customer-discovery.ts` authors the organization,
agent, 13 skills, two knowledge items, and 12-step draft through the builder API,
validates it, and starts a test. It does not approve or publish. The final human
review passes the approved brief through unchanged (`outputMode: "input"`).
After inspection and human approval, publish with the saved `revision` and
`testedRunId`; the API promotes that exact successfully tested snapshot as
Version 1. An unfinished or outdated test cannot be promoted through this path.

The promotion integration test must run against an isolated database whose URL
contains `discovery_verify`; it does not seed the live catalog.

Skills can declare `requiredKnowledgeIds` and `requiredToolIds` as subsets of
their allowed resources. The planner cannot complete such a skill until the
knowledge is fetched and required tools have completed during that skill's
selection. This is checked again by the activity policy. The discovery draft
uses these requirements for its research stages and nonempty, field-specific
stage schemas. It uses `gpt-4.1` for planning; the bounded hosted research helper
uses the independently configured research model. Invalid model decisions are
validated before checkpointing so activity retries can request a fresh result.

### Reasoning timeouts and checkpoint recovery

Each model generation has a 180-second deadline. Schema corrections receive a
fresh deadline, with at most three generations per reasoning activity. Temporal
allows ten minutes for that activity and keeps the existing two-minute budget
for ordinary tool and bookkeeping activities. Cancellation still propagates to
the model; model timeouts now identify the deadline and generation number.

For a failed `reason` activity with no uncommitted tool action, inspect recovery:

```sh
pnpm exec tsx scripts/resume-failed-reasoning.ts RUN_ID
```

Add `--apply` to reset Temporal to the failed reasoning checkpoint and reopen
only that run's failed session/step. The command requires both the app run and
Temporal execution to be failed, checks the failed turn against stored decisions,
and refuses recovery if later business activities exist. Completed decisions,
research results, inputs, and workflow versions remain unchanged. The original
Temporal executions retain their failure histories. A recovery record containing
execution IDs and hashes of completed outputs is saved under `/tmp`.

The decision payload budget scales with `maxOutputTokens` (eight bytes per token,
minimum 16 KB, maximum 64 KB, and never above `maxContextBytes`). This allows
longer structured final briefs without repeatedly forcing them below 16 KB.

After a worker replacement, an administrator may add `--restart-running` to
recover a stale running reasoning activity. This requires exactly one pending
`reason` activity and rechecks the stored turn count under a session lock. It
refuses to restart pending tool actions or reasoning that has already advanced.
Resetting an in-flight model request may incur another provider charge.

## Step presentations and downloadable artifacts

Each workflow step and skill version has **Presentation & artifacts** settings in Library.
Choose a report, cards, table, or ordered diagram for readable results. Artifact generation
can be manual, automatic for selected formats, or let the model choose among allowed
PDF, XLSX, PPTX, and PNG formats. The existing saved JSON remains the source of truth.

In Run, select a step and use **Result**, **Artifacts**, or **Execution**. Completed skill
outputs and files appear beneath their parent step. PDF and PNG have inline previews;
all files can be downloaded. Existing runs can generate artifacts from saved outputs.

Artifacts use the OpenAI Agents SDK hosted Code Interpreter in a separate Temporal
activity and child workflow. Set `OPENAI_API_KEY` on the worker; optionally set
`OPENAI_ARTIFACT_MODEL` (default `gpt-4.1`). Generating artifacts sends that saved output
to OpenAI and incurs model/tool usage. Each requested automatic file format is generated
separately for completeness. Research does not run again when an artifact is retried.
Artifact jobs are cached by source and settings, bounded to 15 MB/file and 30 MB/batch,
and persisted in Postgres before download. Completed runs may still have artifact jobs
running. Failed jobs expose a retry button. Generated layouts should be reviewed before
external sharing.

The Customer Opportunity Discovery configuration enables deliverables for its skills
and a final PDF/slide brief. `scripts/update-discovery-outputs.ts <workflow-id> --publish`
updates an existing workflow through the authoring API; older runs retain their pinned
skill/workflow versions. Apply database migrations before starting the updated API/worker.

## Organization knowledge and workflow assistant

Use **Knowledge** to explore saved research, review corrections, browse the private Forgejo repository, and ask the assistant to explain findings or propose workflow and skill changes. See [Knowledge workspace](docs/knowledge-workspace.md) for setup, voice support, durable execution, and verification.

### OpenHands canvas and workflow builds

OpenHands workflow builds use `openai/gpt-6-astra` with medium reasoning. The
worker's `OPENHANDS_MODEL` environment variable controls new builds; existing
workflow reasoning models are unchanged. Build the isolated executor image with:

```sh
docker build -f apps/openhands/Dockerfile -t agent-engine-openhands:1.49.1-chat .
```

The separate OpenHands web canvas runs as the `openhands-web` Kubernetes
Deployment with persistent settings/conversations. On this Docker Desktop kind
cluster, initialize it with `python3 scripts/setup-openhands-web.py`, then expose
it with `sh scripts/forward-local-service.sh openhands-web 3003 3000`.
Open http://localhost:3003.
The service stays running while Docker Desktop/Kubernetes is running; restart
the forwarder after a terminal restart; it reconnects after pod restarts.
For Forgejo use `sh scripts/forward-local-service.sh forgejo 3001 3000`.

The setup creates a `revos-docker-socket` relay container with automatic restart.
It relays a Unix socket into a dedicated subdirectory of the existing
`desktop-worker` node volume. No TCP Docker API is exposed and no cluster
recreation is needed. This intentionally grants the OpenHands service broad
local Docker control. It is a local-only setup, not a production deployment.
GUI coding sandboxes are Docker containers; workflow builds remain bounded
Kubernetes Jobs. GUI conversations and workflow build sessions are separate.
The initial model key comes from `openai-secrets`; settings are preserved on
subsequent setup runs. Forgejo login is stored in `forgejo-local-login`.

Workflow builds produce static browser tools, save source to private customer
Forgejo repositories, and publish previews at http://localhost:3002. They do not
deploy arbitrary backend services. Stage approvals and customer engagement
chaining remain controlled by Temporal.

The Run page shows an **OpenHands builds** panel with the build phase, elapsed
time, latest activity, recent tool events, and generated filenames. **OpenHands chat**
shows public action summaries, assistant messages, and the final response. Chat
updates with the run, follows new messages when you are at the bottom, and keeps
your place when you scroll back. It preserves expanded chat/activity/file lists.
The API reads bounded, allowlisted messages and event metadata from the build
volume, including already running builds, without
exposing SDK reasoning, raw commands, prompts, or tool output. New executor images
also write atomic progress snapshots and a heartbeat. Messages are deduplicated,
credentials are redacted, and a notice identifies truncated history. Coding-turn limit failures
are explained explicitly; build progress does not imply a verified preview.

Coding attempts allow 200 turns by default, configurable with the worker's
`OPENHANDS_MAX_ITERATIONS` (1–1,000). Each Kubernetes Job has a two-hour deadline.
Long conversations use the SDK's context condenser. Build instructions request
focused checks with concise output and a completion checklist; unavailable browser
validation must be reported as a limitation. **Resume build** continues a
failed build from its saved conversation and files, archives the previous attempt's
progress, and uses a new durable execution. Repeated requests are idempotent and old
attempts cannot overwrite the new attempt. Resuming does not approve a workflow
review or restart its research steps.

Review revisions refresh current build status before each new reasoning decision.
Earlier tool results remain historical records. If a review already has a completed
build, the engine rejects a fresh `start_build`; the agent can inspect the existing
result or call `revise_build` with that build ID and the requested changes.
Revisions pin the parent's Forgejo commit, seed its committed files, and branch
from that commit. They use a new coding conversation and preview while preserving
the previous version. The Run page shows the parent build and its preview/source
links. Human approval is still required after the revised material is presented.

#### Forgejo access from the OpenHands canvas

Build `revos-openhands-canvas:1.27.0-forgejo1` with
`docker build -f apps/openhands-canvas/Dockerfile -t revos-openhands-canvas:1.27.0-forgejo1 .`,
then run `python3 scripts/connect-openhands-forgejo.py`. This creates a dedicated
`openhands-canvas` Forgejo token with `write:repository,read:user` permissions for
the local `revos` account and stores it in Kubernetes secret `openhands-forgejo`.
The canvas passes it to new coding sandboxes; it is never baked into the image.
This intentionally allows access to all repositories owned by `revos`.

Start a **new conversation** after setup. The agent can use `forgejo repos`,
`forgejo clone revos/REPOSITORY`, normal Git branch/commit/push commands, and
`forgejo pr REPOSITORY --head BRANCH --title TITLE --body-file FILE`.
The Git credential helper releases the token only for the exact local Forgejo
endpoint. Browser links remain http://localhost:3001; sandbox Git commands use
http://host.docker.internal:3001, so keep the Forgejo forwarder running.
The setup also enables the native Forgejo provider in persistent OpenHands settings.
The local web deployment sets `ALLOW_INSECURE_GIT_ACCESS=true` because this
Forgejo instance uses HTTP. Use HTTPS and remove that exception for remote deployments.
Refresh OpenHands, select a repository and branch under **Open Repository**, then
launch a new conversation. Existing conversations keep their original repository
association. New conversations are instructed to use branches for review.
Forgejo knowledge-file edits do not automatically update the engine database or
its mindmap; that synchronization is separate from this Git connection.

### Organizations and products

The former Knowledge tab is now **Organizations** (existing `/knowledge` links
and conversations still work). Select a customer and open Products to inspect
build versions, source commits, and inline previews. The organization assistant
can propose new static products or revisions; applying a proposal queues an
idempotent Temporal build and publishes its completed preview. Previous versions
remain available. A pending/failed build retains the last working preview.

Capture feedback with a selected product to store one canonical knowledge record
visible in both the organization and product. Approved notes/corrections are
committed to the organization’s Forgejo knowledge repository with product
provenance. Feedback capture does not silently change code; apply a product
revision proposal to implement it. Product access and parent builds are checked
against the selected organization. Stale revision proposals are rejected.

#### GPT-6 Astra API compatibility

The canvas uses `openai/gpt-6-astra` with medium reasoning. SDK 1.27 does not
recognize GPT-6 in its Responses API registry, so `model_canonical_name` is set
to `openai/gpt-5.5` as a capability compatibility profile. This selects Responses
and reasoning support; the model sent to OpenAI remains GPT-6 Astra. Remove the
profile override when the SDK recognizes GPT-6 directly.
