# People, campaigns, hosted products, and usage

The new experience is in **http://localhost:3004/next/organizations**. Existing pages and running workflow histories remain available.

## Collaborate with people

1. Select an organization, then **People**. Add a primary contact and other participants. Inferred contacts remain proposals until confirmed; the agent must not invent email addresses.
2. Assign a question to a confirmed person, choose its priority, and optionally link it to a product or campaign.
3. Send an invitation from People. Locally, all invitation mail is captured by **Mailpit at http://localhost:8025**. No mail is relayed to the internet.
4. Open the invitation in the customer portal at localhost:3005. The recipient sees only questions assigned to them. The primary contact also sees team progress and can nominate participants.
5. Review submitted answers. Accept, request clarification, reassign, hand off to the primary contact, or reject. Answers and review history are versioned; stale pages cannot overwrite newer answers.
6. Accepted answers are published to the organization repository with attribution and their product link. Repository outages can be retried without requesting the answer again.

A named participant question pauses the Temporal reasoning loop until its answer is accepted or rejected. The next reasoning turn receives bounded, attributed reviewed evidence. The original assignment event stays immutable. The existing operator question and approval controls continue to work.

The Library receives **Identify key players**, **Collect stakeholder input**, and **Build and release customer product** skills plus the **Collaborative Customer Delivery** workflow chain. Its four stages cover discovery, research, proposal, and product. The seed clones the published source stages and retains their existing steps, review gates, and output settings; it never overwrites an old workflow or an execution snapshot. Repeated seeding reuses the published definitions.

## Turn findings into products

A product has its own identity before the first build. It keeps ownership, campaigns, requirements, build history, repository, previews, and usage together.

A campaign records the desired outcome, success measure, stakeholders, and optional budget. Requirements have acceptance criteria and evidence, with separate reviews for each revision. Launching the campaign creates one engagement from the chosen workflow chain. Retried launches reuse that engagement.

The Organizations assistant can propose people, assigned questions, products, campaigns, and requirements. Applying a proposal saves that record. Sending invitations, reviewing answers, starting campaigns, and approving deployments remain explicit controls.

## Host a backend

For a service product, configure **Hosting** before starting a build: runtime port, health endpoint, tests, database/secret references, and coding budget. OpenHands runs as a coding job directly or through Kelos. Long jobs preserve their conversation and workspace across turn chunks; limits pause work with its saved state available to resume.

Source lives in Forgejo. A release pins its source commit and tested container image digest. Forgejo CI builds/tests/reports the image; an operator approves deployment; GitOps applies the desired state to Kubernetes. A release is marked healthy only when its exact deployment and image pass the configured health check. Preview and live releases use separate namespaces.

Keep credentials in Kubernetes Secrets and Forgejo Actions secrets. Git repositories contain secret references, never plaintext database passwords or platform API keys.

## Accrue usage without billing

Usage is attributed to organization and, when available, product, campaign, run, and build:

- Provider-reported input, cached-input, and output tokens. Reasoning tokens are already part of output and are not counted twice.
- Observed hosted tool calls, explicitly distinguished from provider-billed sessions.
- Coding usage reported by the SDK and Temporal activity attempts.
- Forgejo storage samples and elapsed GiB-hours between valid samples.
- Optional OpenCost allocation import for product namespaces.
- Product backend API events submitted with a separate, revocable product-scoped credential.

**Usage** lets you configure rates, currencies, budgets, and future fee terms. Missing prices display as **Unpriced**. Configured rates produce estimates; provider-reconciled actual costs remain distinguishable. Installation and recurring fee configuration does not generate ledger usage or charges. There are no invoices, payments, or automatic charging in this release.

No historical token costs are inferred from old conversations. Tracking starts when the updated workers handle work. Shared infrastructure costs need an explicit allocation policy before attributing them to customers.

## Local operation

### Current deployment status

The operator preview, isolated customer portal, Mailpit, and separate platform worker are deployed. The collaborative delivery chain is published. A synthetic invitation was received in Mailpit, redeemed once, answered, reviewed, and published to Forgejo. A real Temporal wait resumed only after the answer was accepted. Existing product histories and preview links remain available.

Product delivery code and infrastructure definitions are prepared, and the ArgoCD and Kelos controllers are installed. Installing the Forgejo CI runner and its deployment credentials still requires the pending explicit approval for Docker Desktop access and Kubernetes deployment permissions. Until that installation and an end-to-end release test are complete, automatic CI-to-GitOps delivery is not verified. OpenCost resource collection also requires a configured OpenCost service; missing costs remain unpriced.

A synthetic backend and PostgreSQL database passed health checks, container tests, repeatable migrations, and a rolling update to a second immutable image. Saved data, the database Secret, and its persistent volume survived the update. A dedicated local ingress serves the synthetic product at `http://backend-fixture.localhost:3006`; its namespace permissions are confined to that fixture. This validates the product runtime independently of the pending CI installation. New product namespaces still need enrollment during delivery provisioning.

Kelos coding execution is enabled independently through a dedicated platform worker account. A real Kelos Task exercised the OpenHands adapter, persisted its conversation and workspace, and paused at an exhausted checkpoint budget with zero model tokens. A no-network SDK check confirms the configured GPT-6 model selects the Responses API with medium reasoning. This verifies startup and checkpoint handling; it is not a completed model-generated product or a CI deployment test.

- Operator preview: localhost:3004/next
- Existing app: localhost:3000
- Customer invitation portal: localhost:3005/customer
- Mailpit inbox: localhost:8025
- Forgejo: localhost:3001
- OpenHands canvas: localhost:3003
- Temporal: localhost:8080
- Synthetic backend: backend-fixture.localhost:3006

`deploy-platform-preview.py` adds a separate `worker-platform` queue and customer portal, then rolls the compatible HTTP backend with an available pod throughout. The old worker stays on its original queue for existing executions. Database migrations 0010–0012 are additive and backfill stable product IDs from existing build lineages.

Invitation encryption keys are generated into a local Kubernetes Secret and retained across redeployments. Customer sessions are hashed, expiring, revocable, protected by CSRF checks, and served by a deployment whose routes exclude internal APIs. The operator application remains intended for the trusted local environment; internet hosting requires operator authentication, HTTPS, a public portal address, and an intentionally configured mail service.

Handwritten SQL migrations for the new domains are authoritative. Do not use generated schema diffs to drop their tables; add explicit migrations when changing them.
