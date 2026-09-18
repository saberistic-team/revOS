# Backend products and delivery

This path is additive. Existing static previews, workers, builds and repositories
continue to use their current protocol. A product becomes a backend service when
its Hosting settings are saved. New builds inherit that product's configuration.

## Delivery flow

1. OpenHands or the Kelos custom OpenHands image uses the product's immutable
   parent source commit and persistent build workspace. It writes a Dockerfile,
   service.json, application code, tests and optional migration command.
2. Forgejo stores source on `build-<build-id>`. A release pins that source commit
   and snapshots hosting settings; later setting edits do not change a release.
3. `openhands.prepare_release` creates `release-<release-id>` and a Forgejo Actions
   workflow. CI checks out the exact commit, builds, tests with no network, pushes
   an image, then reports the digest with a product-scoped callback credential.
4. A human approves or declines the tested release in Product → Hosting.
5. Approval writes digest-pinned manifests to private `delivery-<product-id>`.
   ArgoCD applies that exact Git commit to the product/environment namespace.
   A migration failure blocks application rollout. External GitOps is selectable,
   but remains `syncing` until an external controller actually applies it.
6. Only an exact healthy deployment receives a verified preview/live link.
   Workflow steps calling prepare_release wait durably for this result. Declines,
   CI timeout and deployment timeout fail with an actionable reason.

Preview and live use separate namespaces and databases. Database provisioning
creates a secret and PVC once and preserves both across retries and releases.
Credentials are never written to Forgejo, model context, application logs or API
responses. Production backups, multi-zone availability and user authentication
remain deployment/product requirements; the local database is a development
Postgres instance with a retained PVC.

## Local prerequisites and setup

Versions verified during implementation: ArgoCD 3.5.3, cert-manager 1.21.2,
Kelos 0.56.0, Forgejo runner 13.1.0, OpenHands SDK/tools 1.49.1.

The setup script is intentionally separate from app startup. It creates delivery
credentials, RBAC and a Forgejo runner with Docker Desktop socket access. This
runner executes repository CI with host Docker privileges. Run it only after
explicit approval for that scope; do not treat application startup as approval.

```sh
docker build -f apps/openhands/Dockerfile -t agent-engine-openhands:platform-budget-v2 .
docker build -f apps/openhands/Dockerfile.kelos -t agent-engine-openhands-kelos:platform-budget-v3 .
docker build -f infrastructure/kubernetes/product-runtime/Dockerfile.runner -t revos-product-runner:13.1.0 .
# Supply the isolated platform service account, not the original worker's account.
python3 scripts/setup-product-delivery.py --engine-service-account engine-platform-worker
```

Prerequisites: official ArgoCD and Kelos controllers/CRDs, cert-manager,
`forgejo-secrets`, `openai-secrets`, `build-data` PVC, and the existing approved
Docker socket relay at `/var/lib/revos-docker/docker.sock` on `desktop-worker`.
Create the new API/worker service account separately and give its original build
permissions separately. The script does not change any deployment or original
worker. Its `delivery-platform-secret` is an envFrom source for only the new
platform API and worker. API-next must mount its service account token for
database and ArgoCD operations. The public customer portal must not mount it.

For the local registry:

```sh
docker run -d --name revos-product-registry --restart unless-stopped \
  -p 127.0.0.1:5050:5000 -v revos-product-registry:/var/lib/registry registry:3
```

The CI workflow explicitly pulls the pushed digest. This registers the immutable
reference in Docker Desktop's image mirror; a tag alone was insufficient in this
cluster. Remote clusters should use an authenticated registry reachable by their
nodes and configure imagePullSecret as needed. Never change an immutable release
to a mutable image tag to work around registry problems.

Configure an actual ingress controller and matching `ingressClass`; previewHost
and liveHost must resolve to it. Saving a hostname does not create DNS or TLS.

## Coding budgets and continuation

A chunk is not a new conversation. The same OpenHands conversation UUID, state,
workspace and source lineage persist across chunks and manual continuation.
Defaults: 200 allocated turns per chunk, 2,000 total allocated turns, six active
hours, two unchanged source checkpoints. A maximum SDK-estimated cost can also
be set. SDK input/output tokens enter the organization's usage ledger; its cost
estimate is not represented as an actual vendor invoice.

The engine reserves a chunk before running it so crashes cannot reuse a budget.
A chunk-cap event can continue automatically. Time, total turn, cost, stalled
progress or agent confirmation stops produce a paused build with a saved
checkpoint. Resume may extend budgets and uses the same workspace/conversation.
Completion still requires the coding agent to finish and required files/tests to
pass. A paused result is never presented as a completed service.

Kelos is a genuine selectable Task provider using `kelos.dev/v1alpha2`, with a
custom `/kelos_entrypoint.sh` OpenHands image and the existing build PVC. It does
not invoke a fresh Codex conversation or use a dummy deployment. The adapter does
not support Kelos Sessions; revOS owns checkpoint persistence and budgets.

## Synthetic fixture

`fixture/` is a small HTTP service using PostgreSQL. `/health` checks the database;
GET/POST `/items` persists requirements. `python migrate.py` creates the table
under an advisory lock, and can run repeatedly without losing data. Its container
runs non-root on port8080. Use it only for a synthetic organization's local test.
The fixture intentionally has no authentication; it is not a customer product.

Primary references:
- https://github.com/kelos-dev/kelos
- https://github.com/kelos-dev/kelos/blob/main/docs/agent-image-interface.md
- https://forgejo.org/docs/latest/admin/actions/registration/
- https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/

### Runtime-only validation observed on 2026-09-17

Synthetic organization: Platform Demo (`a78a95d8-c6f4-4a84-9eaa-a383981145f9`).
Product: Backend Delivery Fixture (`fd704145-edb4-4cd9-a833-270d716b2c8d`).
Namespace: `product-fd704145-edb4-4cd9-a833-270d716b2c8d-preview`.

The actual Kubernetes app and PostgreSQL StatefulSet became Ready. HTTP `/health`
returned 200, POST/GET `/items` stored and read one synthetic requirement. The
migration ran again successfully, and the fixture's two container tests passed.
The app then rolled to a second digest-pinned image; its migration ran again,
health returned 200, the same item remained, and both database Secret and PVC
UIDs were unchanged. The first digest was
`sha256:38528d0f4e7af54dc0c06896effb32d6c56a89cd751a84045bfea556341a2624`;
the second was
`sha256:2f5023be0f3d86577940a50137115e625fcc5fde99dd7c2a78d38ef92335e88e`.
Both are local `localhost:5050/revos/fixture` images.

This validates the runtime, migrations and retained storage. It does **not**
validate CI→ArgoCD delivery. The runner and scoped delivery credential/RBAC setup
were not installed because their explicit approval is pending. ArgoCD,
cert-manager and Kelos controllers are installed and healthy, but the delivery
connection is not configured. A separate Traefik 3.7.13 ingress controller now routes only this synthetic
product namespace, through a loopback-only reconnecting forward on port 3006.
The readable preview is http://backend-fixture.localhost:3006/ and /health
returns 200 without a Host header override. Its database item remained after a
third immutable-image rollout that added the readable page. This third image is
`sha256:109df139dbe16bcec2070226d7eff26982e3b958a0a47c45763c25ede38ba0e0`.
The fixture was not marked as a verified CI release or live customer product.

To render a repeatable test manifest, write an identity JSON file containing your
synthetic `organizationId` and `productId`, build/push/pull your fixture image, then
pass its verified immutable digest:

```sh
node --import tsx scripts/verify-backend-runtime.ts \
  --input fixture-identity.json \
  --image 'localhost:5050/revos/fixture@sha256:YOUR_VERIFIED_DIGEST' \
  --output fixture-runtime.json
```

This command only renders manifests. Provision the fixture namespace, database
secret and resources separately; use `postgres.example.yaml` as the database
shape, with generated credentials kept exclusively in a Kubernetes Secret.
Applying the runtime runs migration as an init container, which waits/retries
until the database is ready. Check `kubectl rollout status deployment/app` and
query `/health` and `/items` from inside that namespace, or use a loopback-only
port-forward. Production releases use the approved CI/GitOps path instead.


### Local preview routing

`setup-product-ingress.py --namespace PRODUCT_NAMESPACE` installs the pinned
Traefik chart 41.6.0 with automatic broad RBAC disabled. Custom permissions allow
read-only IngressClass/node discovery and access to services, endpoints, ingress
rules and secrets in **that named synthetic namespace only**. It cannot modify
workloads or secrets or read the original engine/customer namespaces. No public
LoadBalancer or external listener is created.

```sh
python3 scripts/setup-product-ingress.py --namespace product-YOUR_PRODUCT_UUID-preview
sh scripts/forward-product-ingress.sh 3006
```

Set Hosting ingressClass to `revos-products`, publicPort to 3006 and previewHost
to a `.localhost` name matching the product Ingress. A local `.localhost` browser
name reaches loopback; no manual Host header is necessary. Opening/saving Hosting
settings preserves previously configured TLS, image-pull and resource settings.
The current deployment routes the fixture only; other namespaces require explicit
routing enrollment. The separate CI/delivery approval does not happen implicitly
when this local preview controller is installed.


### Independent Kelos execution verified on 2026-09-17

Kelos coding execution is now enabled independently of the still-pending CI and
GitOps permission setup. Run `python3 scripts/setup-kelos-platform.py` to reproduce
its namespace-scoped configuration. The script creates `engine-platform-worker`,
binds the existing build Role through a new binding, and grants only Kelos Task
get/list/create in `agent-engine-local`. Coding pods use `product-builder` with no
service-account token. The original worker and all API permissions stay unchanged;
API and API-next receive only the non-secret availability ConfigMap. The customer
portal receives none of that configuration. Future `deploy-platform-preview.py`
runs preserve the dedicated worker account and these settings.

Corrected image tags are `agent-engine-openhands:platform-budget-v2` and
`agent-engine-openhands-kelos:platform-budget-v3`. A real SDK test caught that the
SDK1.49.1 Conversation factory does not accept `max_budget_per_run`; the supported
LocalConversation property is now set immediately after construction. The Kelos
entrypoint also normalizes HOME/PATH to the task's actual UID1000, avoiding an
inaccessible default image-user home when checking optional terminal tools.

The actual Temporal→Kelos→OpenHands→PVC→engine smoke task
`build-95e7f884-1a3c-47e9-a66b-ee916caf7dd4` succeeded. The engine correctly marked
the build paused at its pre-exhausted checkpoint, with a persisted SDK conversation,
unchanged workspace sentinel and zero input/output tokens. This validates startup,
mounting, status integration and pause behavior; it does not claim a paid coding
run or a 200-turn continuation was exercised. Two earlier failed synthetic tasks
remain in the fixture history documenting the startup issues that this test found.

Reproduce the bounded zero-model test inside the configured platform worker:

```sh
kubectl --context docker-desktop -n agent-engine-local exec -i   deployment/worker-platform -- node - SYNTHETIC_ORG_UUID SYNTHETIC_PRODUCT_UUID   < scripts/verify-kelos-no-model.cjs
```

The script requires a synthetic product named Backend Delivery Fixture. It sets a
10-turn test budget and pre-exhausts the checkpoint before starting the real SDK,
so no provider request occurs. The actual SDK regression can run with Docker
networking disabled using `apps/openhands/test_sdk_contract.py`; it checks real
Conversation construction, UID environment handling, and `gpt-6-astra` automatic
Responses API routing with medium reasoning. SDK source also confirms the limit
event codes, pause/status enums and cumulative cost-limit semantics used by the
continuation loop. CI remains unconfigured pending its separate explicit approval.
