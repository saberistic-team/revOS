# Focused workspace preview

The redesigned interface is served under `/next`. For local testing it runs in its own `api-next` deployment at **http://localhost:3004/next**. The existing app remains at http://localhost:3000.

## Workspaces

- **Inbox:** questions, stage reviews, and proposed changes across organizations.
- **Run:** engagements and independent workflow runs, dedicated starting forms, coherent stage/round selection, results, activity, history, exact review targets, and focused OpenHands build pages.
- **Organizations:** customer directory, knowledge/report/map, corrections, products with previews and revision history, engagements, and repository settings.
- **Library:** workflows with one selected step editor, chains, grouped skill versions, references, tools, tests, and explicit publication review.
- **Assistant:** a collapsible contextual dock; drafts and conversations follow their selected object. Send shows pending submission immediately and follows the selected conversation's running state. Proposed changes stay reviewable before application. Build chatter is a separate read-only view.

Open tabs check for interface updates and offer a Refresh button when a newer version is available. Refresh is never automatic; assistant drafts stay in the tab's session storage, and unsaved editor changes retain the usual navigation warning.

## Isolation

The preview uses the same saved data and execution engine. **Actions in the preview are real:** starting work, applying changes, approving reviews, and editing library objects use existing application commands.

`DISABLE_BACKGROUND_DISPATCH=true` disables the preview API's recurring dispatchers. The current API continues to dispatch queued work. Explicit actions can still start their requested workflows. No existing API, worker, Temporal execution, or coding job needs to restart for the preview deployment.

Migration `0009_product_metadata.sql` adds an independent product identity table. It does not rewrite workflow definitions, previous runs, or existing knowledge. Product edits check a revision number so concurrent edits cannot silently overwrite each other.

## Local deployment

Build a fresh, uniquely tagged preview image, then run:

```sh
python3 scripts/deploy-next-preview.py agent-engine-api:<preview-tag>
sh scripts/forward-local-service.sh api-next 3004 3000
```

The script copies the current API's environment references and mounted build volume to a separately named deployment. It runs recorded database migrations before starting the preview. It never updates `deployment/api` or `deployment/worker`.

Removing `api-next` and its service removes the preview only; the optional metadata table can remain. Keep the old UI available until a separate cutover is requested.

## Validation

Focused offline tests cover context ownership/version checks, exact review/question/attempt IDs, stale replies, draft preservation, schema-based launching, publication revision checks, preview stability, public build updates, and product lineage. Existing assistant, organization, engagement and build suites remain applicable.

`scripts/verify-next-preview.cjs` validates saved selection contracts inside the preview container without model calls. Its metadata concurrency check is rolled back. Browser checks use existing records without submitting customer decisions or launching builds.

Browser narration uses built-in speech synthesis; dictation availability depends on the browser. Assistant chain and reference editing remain in their conventional editors because their proposal commands are not part of the existing engine contract.
