# Concepts

## Organization

- **Definition:** Company/customer boundary.
- **Purpose:** Groups configuration and requested work.
- **Example:** Moses Demo Organization.
- **Relationships:** Owns Agents, Workflows, Tasks, Knowledge and optional organization Skills.

## Agent

- **Definition:** An operating role and its instructions.
- **Purpose:** Supplies organization-specific execution context.
- **Example:** Real Estate Lead Researcher.
- **Relationships:** Belongs to Organization; Task selects Agent; Run snapshots its instructions.

## Workflow

- **Definition:** Stable identity for a business process.
- **Purpose:** Names and publishes the current process version.
- **Example:** Obituary Property Lead Research.
- **Relationships:** Belongs to Organization; points to current WorkflowVersion; is requested by Task.

## WorkflowVersion

- **Definition:** Append-only goal, SOP and input/output schemas.
- **Purpose:** Keeps historical executions reproducible at the instruction level.
- **Example:** Version 1 of the sample SOP.
- **Relationships:** Belongs to Workflow; owns WorkflowSteps; Run pins its ID.

## WorkflowStep

- **Definition:** An ordered step within an exact version.
- **Purpose:** Defines sequence, skill binding and input source.
- **Example:** find_property at position 2.
- **Relationships:** Belongs to WorkflowVersion; optionally references SkillVersion; RunStep records execution.

## Skill

- **Definition:** Stable reusable capability identity.
- **Purpose:** Allows a capability to be versioned and reused.
- **Example:** Extract Obituary.
- **Relationships:** Optionally belongs to Organization (null means system/global); owns SkillVersions.

## SkillVersion

- **Definition:** Append-only instructions, execution type, schemas and configuration.
- **Purpose:** Pins exact capability behavior.
- **Example:** extract_obituary v1 using llm/mock.
- **Relationships:** Belongs to Skill; referenced by WorkflowStep; optionally binds Tool by configuration.toolId.

## Tool

- **Definition:** Metadata for an executable integration.
- **Purpose:** Maps a database-selected capability to registered code.
- **Example:** property.search.
- **Relationships:** SkillVersion binds its ID; Tool.handler resolves through ToolRegistry; Run snapshots metadata.

## Knowledge

- **Definition:** Separate text/Markdown knowledge and metadata.
- **Purpose:** Adds context without embedding it in workflow instructions.
- **Example:** Demo evidence policy.
- **Relationships:** Belongs to Organization; copied into execution definition; no vector retrieval.

## Task

- **Definition:** A request for business work.
- **Purpose:** Captures requester-side input and status.
- **Example:** Research this synthetic text.
- **Relationships:** Belongs to Organization and selects Agent/Workflow; has Runs.

## Run

- **Definition:** One durable execution attempt.
- **Purpose:** Tracks status/output and pinned definition.
- **Example:** run:550e8400-e29b-41d4-a716-446655440000.
- **Relationships:** References Task and WorkflowVersion; maps to a Temporal execution; has RunSteps and Corrections.

## RunStep

- **Definition:** Business-readable state for an executed step.
- **Purpose:** Shows input/output, timestamps and errors.
- **Example:** find_property completed with synthetic results.
- **Relationships:** Unique for Run plus WorkflowStep; can be referenced by Correction.

## Correction

- **Definition:** A stored human correction.
- **Purpose:** Preserves original/corrected values and explanation for future improvements.
- **Example:** Mark a candidate match as incorrect.
- **Relationships:** References Run and optional RunStep; storage only, no self-improvement loop.
