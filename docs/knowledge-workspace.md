# Organization knowledge and assistant

Open `/knowledge` from the shared navigation, a run, or a workflow in Library.

## Knowledge lifecycle

- Import saved completed **step and skill** outputs from a run. This does not rerun research.
- Each organization has a private Forgejo repository, `revos/knowledge-<organization UUID>`.
- Each record is a readable `knowledge/<document UUID>.md` file with provenance metadata.
- Imported research is labeled **researched**, not customer-confirmed. Notes and model corrections are unverified until the user confirms them.
- Capture text, Markdown, or JSON notes, or ask the assistant to propose a correction.
- Review before/after content in **Changes**. Applying a knowledge change commits it to Forgejo and updates the searchable Library knowledge index.
- Optimistic revision and Forgejo file-SHA checks reject stale edits. Repeated imports and retried commits reuse the original change rather than duplicating it.
- **Sync external repository edits** imports supported knowledge files changed in Forgejo and marks the edits unverified.
- Existing workflow runs and artifacts retain their original evidence. Newly approved knowledge is available for future skill retrieval; grant its knowledge ID or the organization knowledge search tool to the appropriate skill.

Workflow builder has **Add completed run findings to organization knowledge**. On successful completion, a separate Temporal child workflow imports the saved results; the main run does not wait for that import. Its progress appears in Knowledge.

## Assistant

The right-hand assistant explains selected knowledge, conducts a section-by-section walkthrough, captures corrections, and proposes workflows or skill versions. Choose a workflow to edit an existing draft, or leave it empty to build a new one. Conversations and operations persist in Postgres; model calls, imports, and approved changes execute in Temporal activities.

The OpenAI Agents SDK produces structured proposals. They pass the same organization, schema, tool-permission, and skill validation as Library. A bounded repair pass can correct invalid draft contracts. Model output never directly executes code or publishes workflows. Review and apply proposals explicitly. Workflow changes produce editable drafts; publish or test them through Library. Skill changes create immutable new versions; existing workflow pins are unchanged.

Documents outside the selected record are provided as excerpts. Select a record for a full explanation or correction. Context and response sizes are bounded; large documents may require a smaller capture. The assistant is not a background monitor and does not automatically refresh old reports.

## Views and inputs

- **Report:** readable knowledge, evidence labels, source run, repository link, revision history, and skill dependencies.
- **Mind map:** category overview, expandable record branches, and explicit record links. Relationships are not inferred as facts.
- **Capture:** new notes, full-document corrections, and local `.txt`, `.md`, or `.json` upload.
- **Changes:** review, approve, reject, and failed-change status.
- **Repository:** recent commits and external-edit synchronization.
- **Listen:** browser speech synthesis for the selected report or an assistant response, with Stop controls.
- **Dictate:** browser speech recognition when available; requires the user's microphone permission. Unsupported browsers retain text input and device keyboard dictation. This is not a full-duplex realtime voice agent.

## Workflow tools

`knowledge.search` searches the current run organization's knowledge and returns evidence, revision and provenance. `knowledge.propose` creates a reviewable unverified correction or note. Organization scope is derived from the durable reasoning session, never from model-supplied organization IDs. Both run through the existing Temporal tool activity and require skill tool permissions. Neither tool can commit without review.

## Local infrastructure

Apply `infrastructure/kubernetes/local/forgejo.yaml`, then run `python3 scripts/setup-forgejo.py`.
This creates a persistent Forgejo installation, initializes a local service account, stores generated credentials in Kubernetes secrets, and connects API and worker. It never prints credentials.

- `forgejo-secrets`: `FORGEJO_URL`, `FORGEJO_PUBLIC_URL`, `FORGEJO_OWNER`, `FORGEJO_TOKEN`.
- `forgejo-local-login`: local Forgejo UI username/password, available to the cluster administrator.
- Forgejo UI: forward service `forgejo`, local port **3001** to service port **3000**.
- Assistant: uses worker `OPENAI_API_KEY`; optional `OPENAI_ASSISTANT_MODEL`, default `gpt-4.1`.
- Apply database migrations before using the updated API/worker.

The application remains a local single-user demo with organization scoping, not an authenticated multi-tenant production service. Keep the API local. Forgejo repositories are private. Public deployment requires application authentication/authorization, HTTPS, secret management and backups for both Postgres and the Forgejo volume.

## Verification

- `node --import tsx --test tests/*.test.ts`: unit tests.
- `node scripts/verify-knowledge-workflows.cjs`: isolated Temporal orchestration checks. Set `REPLAY_WORKFLOW_ID` to also replay an existing history.
- `python3 scripts/verify-workspace.py --live-assistant`: creates a synthetic test organization and repository, tests corrections, conflicts and the live assistant. The flag calls OpenAI on synthetic fixtures and incurs usage. Fixture organization IDs are recorded under `/tmp/workspace-test-orgs` for cleanup.

### Assistant request budget

The workspace assistant counts input with the GPT-4.1 `o200k_base` tokenizer before sending a request. Input plus instructions is capped at 16,000 tokens and output at 8,000, leaving headroom under the current 30,000 TPM account limit for structured-output framing and provider estimates. Library skills normally use a compact catalog; naming a skill explicitly loads its full edit context. Older conversation and unrelated records are removed first when necessary. The current user message and selected workflow are never truncated. Truncated knowledge is marked as an excerpt and cannot be used to replace the full document. Repair requests use the same budget check. This bounds individual requests; concurrent account usage can still cause temporary rate limits.

### Agent-generated organization mind map

The Mind map view is synthesized by an OpenAI agent from every saved organization knowledge record. It is no longer a predefined category tree. Themes, concepts, and labeled relationships come from the content; each concept and relationship links to supporting records, and inferred connections are labeled.

The API detects knowledge snapshot changes every five seconds, waits ten seconds for edits to settle, and waits for active imports/corrections/syncs to complete. It queues one durable Temporal map job per organization snapshot. The snapshot includes all document content; long records are split into token-bounded parts without truncation. The agent incrementally integrates batches into a concise overview. Calls are spaced to respect the current 30k TPM budget. Initial builds and updates can take several minutes, depending on knowledge volume.

Completed batches are checkpointed. Retries resume from the next unfinished batch. A previously completed map stays visible with a stale indicator while a replacement is generated. Edits during generation trigger another snapshot afterward. Failed builds retain the previous map and expose Retry; unchanged snapshots are not regenerated repeatedly. The organization boundary applies to every query and citation validation. Source links show provenance in the existing report view. This is a derived overview: it never edits or confirms the underlying knowledge.

Maps and build snapshots are stored in workspace jobs; Forgejo continues to store the source knowledge. Browser polling displays progress and completed updates automatically. External Forgejo changes enter this process after repository sync.

## Assistants by section

- **Run** has a chat panel for preparing published-workflow inputs, inspecting the selected run and its step output excerpts, diagnosing errors, and proposing new executions. A proposal starts only after **Approve and start**.
- **Library** has a chat panel for building saved workflow drafts and skills, and explaining available tools. Proposals show their complete definition before **Apply draft**. They do not publish or execute automatically. Save editor changes before discussing them with the assistant.
- **Knowledge** retains the report-side assistant for explaining organization knowledge, finding gaps, capturing notes and collecting corrections. It cannot start runs or author library definitions.

Conversations are stored by organization and section (`workspace_thread.scope`). Existing conversations remain in Knowledge. Each assistant receives section-specific context and capabilities; the worker rejects proposal kinds outside its scope even if the model returns them. Run inspection checks organization ownership. Selecting another organization changes the assistant workspace. Run and Library panels have independent message scrolling and preserve the reading position when replies arrive.
