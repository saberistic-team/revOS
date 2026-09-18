# Products, campaigns, and usage

The preview workspace exposes **Products**, **Campaigns**, and **Usage** under an organization. Product identity survives builds and revisions. Historical products retain their original root-build UUID, so old links continue to work.

## Product and campaign workflow

1. Create a product, set its purpose and owner, and choose Website or App with backend.
2. Create a campaign with an objective, success measure, stakeholders, and optional cost budget.
3. Propose requirements with acceptance criteria and evidence. A reviewer explicitly approves, requests changes, or rejects the displayed revision. Editing a decided requirement creates a new proposed revision; its earlier text and decision remain immutable.
4. Start a workflow chain using the schema-driven starting form. Campaign launch creates its engagement and stores the link in one transaction. Repeated launch requests reuse that engagement.
5. Use Hosting to configure a backend product, provision its preview/live databases, start or continue a build, and prepare deployments. The catalog publishes backend links only after a release is healthy.

The assistant receives the selected campaign's saved ID, product, and revision. The server rejects a stale campaign revision, an unrelated product, and cross-organization selections. Planned products work before their first build.

## Usage is accumulated, not billed

There are no invoice, payment, or collection actions. Optional commercial terms are saved configuration only.

Every usage event has an organization and may also identify its product, campaign, run, and build. The server checks that every supplied relationship belongs to that organization. Measurements are append-only. The tuple `(organization, provider, eventKey, attemptId)` identifies an operation; repeated delivery does not add usage, while a distinct paid retry needs a distinct attempt ID.

Costs are stored in integer millionths of the named currency. An organization rate is an amount per a stated quantity of units, with an effective date and source. For example, a real configured contract might price input tokens per million tokens. No provider prices are seeded or invented.

- **Unpriced:** no cost or applicable rate is known. This does not mean free.
- **Estimated:** a configured rate or OpenCost estimate supplied the cost.
- **Actual:** a provider-sourced actual cost was recorded or reconciled.

Historical event values remain unchanged when a new rate is added. Actual cost reconciliation is an additional record linked to the original event. Currencies are summarized separately. Budgets describe the chosen scope and month; a partially priced total is marked incomplete.

## Resource collection

The dispatcher runs only where `PLATFORM_DISPATCH_ENABLED=true`. Organization settings control each source and the collection interval.

### Forgejo

The collector measures the API-reported Git size for the organization's knowledge repository, historical shared product repository, individual backend product repositories, and deployment repositories. It retains snapshots and accrues GiB-hours from the previous observation to the next one. A gap longer than three configured intervals is excluded, rather than extrapolating through unknown time.

These measurements exclude LFS, packages, backups, and shared Forgejo infrastructure. A configured per-unit rate can estimate the measured storage cost. Repository access uses the existing server-side Forgejo connection.

### OpenCost

Set `OPENCOST_URL` to the trusted internal OpenCost allocation API and optionally `OPENCOST_TOKEN`. Enable OpenCost collection in the organization's Usage settings. `OPENCOST_CURRENCY` defaults to `USD` and must match that OpenCost installation.

The collector reads complete UTC hours and attributes only namespaces belonging to known product IDs: `product-<id>-preview` and `product-<id>-live`. It records allocated CPU core-hours, RAM GiB-hours, and persistent-volume GiB-hours. These describe allocated resources, including reserved capacity, rather than utilization alone. OpenCost list-price costs remain estimates until reconciled against a provider source.

Zero costs are treated as unpriced by default because they may indicate missing infrastructure pricing. Set `OPENCOST_TRUST_ZERO_COSTS=true` only when zero-valued prices in the configured OpenCost source are intentional.

Shared Temporal, database, and cluster costs require an explicit allocation policy or separately measured events. The collector does not invent a share for each customer. The implementation follows the [OpenCost allocation API](https://opencost.io/docs/integrations/api/).

## Recording product API use

In a product's Usage settings, create a backend key. It is shown once and is scoped to that product. Put it in the product's backend secret store; do not put it in client-side code or a repository. Rotating the key invalidates its predecessor.

Send `POST /product-usage/<product-id>/events` with `Authorization: Bearer <key>` and:

```json
{
  "eventKey": "unique-operation-id",
  "attemptId": "optional-paid-retry-id",
  "unit": "requests",
  "units": 1,
  "measuredAt": "2026-09-17T12:00:00.000Z"
}
```

The ingestion endpoint assigns organization, product, provider (`product-api`), and category (`api`) from the credential. Clients cannot override them or submit prices. Metadata is optional and bounded. The same operation and attempt must have the same payload on retry.

## Verification

- `tests/product-platform.test.ts`: monetary arithmetic, rate semantics, period boundaries, storage gaps, and OpenCost units/estimates.
- `tests/next-product-platform.test.ts`: navigation, assistant selection, unpriced display, product/campaign/requirement forms, and schema-driven chain launch.
- `tests/product-platform-db.test.ts`: complete migrations 0000–0012 in an isolated temporary schema, historical build migration, concurrency, tenant isolation, immutable reviews, deduplication, reconciliation, scoped credentials, and healthy deployment links.

The database test only runs when `TEST_PLATFORM_DATABASE_URL` is explicitly set. It creates and removes its own schema and never falls back to the application's default connection.
