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
