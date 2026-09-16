# Workflow builder

Open http://localhost:3000/builder, or choose **Workflows & library** from the run playground.

## Author a workflow

1. Choose an organization and create a workflow, or open an existing workflow and duplicate it.
2. Set its name, agent, goal, and instructions.
3. Define starting inputs and the final result with the field editor. Advanced JSON schemas support nested objects, arrays, and richer validation.
4. Add and reorder steps:
   - **Agent task**: the model chooses among exact agent skill versions. Set a step goal, input source, model, bounds, and step output contract.
   - **Fixed skill**: the selected agent skill must execute. It uses the same durable OpenAI reasoning loop, constrained to that one skill.
   - **Human approval**: pauses until someone approves or rejects in Runs. Approval returns `{ approved, note, value }`, with the step input in `value`.
5. Save and validate. Validation checks schemas, backward-only input bindings, skill ownership, tool and knowledge references, and execution limits. It cannot guarantee model success or compatibility of arbitrary JSON schemas across steps.
6. Enter test input and select **Test draft**. The run inspector opens with that test selected. For multiple agent steps, use the session selector to inspect each step. Fixed approval steps also expose their input and result.
7. Return to the builder and **Publish version** when ready. Publishing does not start a run.

New builder steps use agent skills and OpenAI only. Legacy sequential LLM/tool skills remain supported by their existing workflows but are not offered as new builder steps. Registered tool handlers still require an implemented Worker integration; the library cannot manufacture a working external integration from a name.

## Library

Create agent skills with instructions, input/output schemas, and allowed tools and knowledge. Updating a skill creates a new immutable version; existing workflow versions retain their pinned skill version. Select the new version in a workflow draft to adopt it. Existing skill names/descriptions are displayed read-only when creating a new version.

Add or edit reference knowledge. Content is snapshotted when execution definitions load, so already snapshotted runs retain their original content. A published workflow pins skill versions, but knowledge updates affect future runs. Knowledge is supplied to the model only after an explicit fetch action.

## Draft and version semantics

`workflow_draft` stores an editable definition, revision number, and last published revision. Saves use optimistic revision checks and reject stale writes with HTTP 409. Workflow locks serialize snapshots and publication. Drafts can be incomplete; validation, testing, and publishing require a complete valid definition.

A draft test creates an immutable WorkflowVersion and Run without moving `workflow.current_version_id`. Test versions appear in version history and consume version numbers. Publishing creates a fresh immutable version and changes the published pointer atomically. Old runs retain their version and execution snapshot. The selected agent ID is recorded in step configuration and used by published run creation.

Draft tests and normal runs share the existing durable pending-run dispatch queue. Retrying a test request creates another test; do not repeatedly click while a request is pending.

## API

- `GET /builder/catalog`: organization agents, versioned skills, tools, knowledge
- `GET|POST /builder/workflows`: list or create; creation can include `duplicateId`
- `GET|PUT /builder/workflows/:id`: read or save draft (`revision`, `definition`)
- `POST /builder/workflows/:id/validate`: validate a saved revision
- `POST /builder/workflows/:id/test`: run an immutable draft snapshot (`revision`, `input`)
- `POST /builder/workflows/:id/publish`: publish a saved revision
- `POST /builder/skills`: create a skill or append a version via `skillId`
- `POST /builder/knowledge`: create or update via `id`

These routes have the same local-only, unauthenticated scope as the existing playground. Secrets remain on the Worker.

## Verification

Run `pnpm typecheck`, `pnpm test`, and `pnpm test:integration` against the local stack. Builder integration tests cover saved drafts, conflicting revisions, test/publish separation, sealed versions, duplicate workflows, invalid bindings, skill version creation, schema validation, and organization-scoped knowledge permissions.

Validated locally on 2026-09-15: typecheck, 7 unit tests, and 9 integration tests passed. The live builder-created **Text briefing** workflow (`6b7eaa17-b988-40bb-8d49-cc81a39fcee5`) completed an agent task, a fixed agent skill, and human approval in Run `9bdfdd5b-da2c-45da-bb89-2b71f4c0d78a`, then published version 5. Earlier test snapshots remain inspectable, including contract failures. The SDK now limits its structured action choices to those permitted by the current session state. Fatal worker startup failures exit so Kubernetes can restart the process.

Both UI scripts parse successfully. Visual verification remains outstanding because Codex browser control could not verify its admin-enforced access policy; this is separate from the engine.

## OpenAI obituary research edition

**Obituary Property Lead Research — OpenAI** is a separately published copy of the original five-stage workflow. Each stage pins a new agent skill version and uses `gpt-4.1-mini`; the original workflow is unchanged. The property-search tool retains synthetic fixtures, and the final report requires review and disallows outreach. Run `d060e55a-ae20-4d64-a5f6-56ed1f76a89e` completed all five sessions with one recorded tool call. Workflow ID: `862d9d69-76f4-49ef-92de-5f461a647ebc`.

The Runs selector now includes every published workflow and refreshes when its tab regains focus. Legacy and offline workflows keep their configured execution modes; visibility does not convert them to OpenAI.

Agent task and fixed agent-skill settings also include **Allow the model to ask humans questions**, independently of approval. When enabled, the model can pause for clarification and use the reply in later reasoning. Runs displays a reply composer and the conversation transcript. The **Human conversation — OpenAI** example asks for a topic, then its intended audience, before writing a brief. Start it with `{}` to try the exchange.
