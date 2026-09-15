# Day 1 — Agent Engine Foundation

## Status

Built and verified against a freshly recreated local Kubernetes namespace on 2026-09-15. The backend acceptance checks passed. Browser-based Temporal UI verification remains blocked by the desktop browser tool's unavailable admin-policy check; no bypass was attempted.

## Recorded validation

- Docker Desktop Kubernetes v1.36.1, Skaffold v2.24.0, arm64 Linux application containers.
- All five deployments ready: API, Worker, PostgreSQL, Temporal, Temporal UI; zero pod restarts after the final fresh startup.
- Both Docker images compiled successfully; TypeScript type checking passed.
- Three unit tests passed and five integration tests passed (zero failures/skips).
- Empty-database Drizzle migration and transactional seed succeeded. Repeated seed calls left five correctly linked steps.
- Demo Task: `66968690-2027-4089-ab54-bf03e4963ff0`.
- Demo Run: `2d39f504-ad83-42d0-9fe2-b7e5c2fd85b7`.
- Temporal Workflow ID: `run:2d39f504-ad83-42d0-9fe2-b7e5c2fd85b7`.
- Direct PostgreSQL verification: status `completed`, WorkflowVersion `1`, five completed RunSteps.
- Integration tests independently checked Temporal's returned execution result against PostgreSQL output, rejected version/snapshot mutations, ran an unrelated onboarding workflow, published v2 while preserving the v1 Run, resumed human review, and persisted a useful schema-failure error after bounded retries.
- Source scan of `packages/engine`, `packages/shared`, and `packages/temporal` found no obituary/property/deceased business terms.
- Temporal UI deployment/readiness passed, but the UI was **not visually inspected**. Open [Temporal UI](http://localhost:8080), namespace `default`, and select the demo Workflow ID above to complete that acceptance item.

Demo output includes `synthetic: true`, `reviewRequired: true`, `outreachAllowed: false`, source provenance, zero real-world confidence, and explicit identity/ownership uncertainty.

## Deliverables

- pnpm TypeScript monorepo with separate API and Worker images/deployments.
- Thirteen Drizzle product models plus an internal workflow publication seal.
- Reproducible migrations with database-enforced version and Run identity immutability.
- Idempotent synthetic seed: Organization, Agent, Workflow v1, five Skills/SkillVersions/Steps, Tool and Knowledge.
- One generic `AgentRunWorkflow`, generic Activities, schema validation and explicit input bindings.
- ModelProvider interface, deterministic database-driven mock provider, optional isolated OpenAI provider.
- Code ToolRegistry and an isolated synthetic property adapter.
- Durable human-review signal handling and Correction storage.
- Kubernetes base/local/production separation, persistent local PostgreSQL, official Temporal auto-setup/UI images, Skaffold build/watch/port forwarding.
- README, Mermaid architecture diagrams, concept definitions and focused tests.

## Acceptance procedure

The project namespace and PVC were deleted, then the README sequence was followed:

```bash
pnpm install --frozen-lockfile
skaffold dev --cleanup=false
# Wait for "Deployments stabilized" and all four port-forward messages.
pnpm db:migrate
pnpm db:seed
pnpm demo
pnpm test:integration
```

`--cleanup=false` preserves the verified local environment when the development process stops. It does not change deployment/build behavior. The namespace and PVC are disposable; the README documents the destructive reset explicitly.

## Architecture decisions

- PostgreSQL stores business definitions and state; Temporal stores execution history.
- Version rows are immutable from creation. Steps are sealed on publication/use; old versions remain sealed.
- A one-time execution snapshot includes mutable Agent/Knowledge/Tool metadata, so changes do not redirect an in-progress run.
- Skill/Tool schemas are validated in Activities; Workflow code only orchestrates.
- A persisted pending Run plus a small API dispatcher closes the database-commit/Temporal-start gap.
- Local PostgreSQL uses separate application and Temporal roles/databases. Production may replace it with a managed database through DATABASE_URL.
- Local Temporal uses a single official auto-setup process, not an HA deployment; production can use Temporal Cloud through TLS/API-key configuration.
- Mock responses are DB fixtures. No obituary-specific branching exists in the engine, shared, or Temporal packages.

## Known limitations

- The desktop browser policy check prevented opening Temporal UI for visual inspection. The UI deployment/readiness and Temporal execution API are separate checks; they must not be described as a completed visual check.
- No live LLM request was made. The optional OpenAI path has not been validated with paid credentials. Mock mode returns fixed database fixtures and is not a general-purpose extractor.
- Local unauthenticated API only; no production authorization, ingress, cloud infrastructure, or HA.
- Workflow execution supports only sequential skill and human_review steps. The final step supplies the Run output. Payloads are intended to stay small; large-artifact storage and history growth limits are future work.
- Tool code and provider environment are not versioned binaries. Future worker versioning and provider pinning are needed for historical replay across deployments.
- Activities can be retried; real external writes need idempotency. Abrupt Temporal termination and prolonged database outages can require business-state reconciliation.
- HTTP submission idempotency, automated workflow authoring, retrieval, self-improvement and outreach are not implemented.
- PostgreSQL persists through pod restarts while its PVC exists. Deleting the local namespace/PVC or allowing Skaffold cleanup deletes the disposable local data.

## Recommended Day 2

Implement a small validated authoring/publishing service for new workflow and skill versions. Add explicit publication validation of bindings and schemas, with a second maintained business configuration. Keep orchestration generic.

## Remaining Week 1 direction (not implemented)

- Day 3: review/correction API ergonomics and an explicit audit model.
- Day 4: one real read-only tool adapter, with timeouts, provenance and retry/idempotency contracts.
- Day 5: workflow replay/versioning strategy, payload limits and recovery tests; document operational failure handling.

These are recommendations only. No Day 2 work was started.
