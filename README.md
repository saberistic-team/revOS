# Agent Engine

A durable execution platform for turning business SOPs into reusable,
database-configured agent workflows.

Business-specific configuration lives in PostgreSQL.

Durable execution lives in Temporal.

Application workloads run on Kubernetes.

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
