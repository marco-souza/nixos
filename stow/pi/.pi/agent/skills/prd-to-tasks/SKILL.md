---
name: prd-to-tasks
description: >
  Convert a Product Requirements Document (PRD) into a structured tasks.json file
  with tasks, dependencies, priorities, and estimated effort.
  Use when a PRD exists and the user wants to break it down into implementable tasks.
  Do NOT use when there is no PRD or when the user wants to skip planning.
---

# PRD to Tasks

Break down a PRD into a `tasks.json` that drives implementation.

## When to Use

- After PRD is approved
- Before delegating to `implement-tasks`

## When NOT to Use

- No PRD exists (use `grill-with-docs` first)
- Trivially small task (use `implement` directly)

## Prerequisites

- A PRD exists (created by `grill-with-docs` or manually)
- `task-pipeline` CLI available at `$HOME/.pi/agent/scripts/task-pipeline/`

## tasks.json Format

```jsonc
{
  "$schema": "tasks/v1",
  "metadata": {
    "project": "Feature name",
    "prd": "PRD-feature.md",
    "created": "YYYY-MM-DD",
  },
  "phases": {
    "1-foundation": {
      "label": "Phase 1: Foundation",
      "description": "Setup and shared utilities",
      "tasks": ["T001", "T002"],
    },
    "2-core": {
      "label": "Phase 2: Core",
      "description": "Must-have features (P0)",
      "tasks": ["T003", "T004"],
    },
    "3-polish": {
      "label": "Phase 3: Polish",
      "description": "Edge cases, tests, hardening",
      "tasks": ["T005"],
    },
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Set up project structure",
      "description": "Create directories and config files",
      "phase": "1-foundation",
      "priority": "critical",
      "estimatedHours": 2,
      "dependencies": [],
      "acceptanceCriteria": [
        "Directory structure created",
        "Config files in place",
      ],
    },
  ],
}
```

### Task Fields

| Field                | Required | Description                         |
| -------------------- | -------- | ----------------------------------- |
| `id`                 | Yes      | Unique ID (T001, T002...)           |
| `title`              | Yes      | Verb phrase ("Implement X")         |
| `description`        | Yes      | What and approach                   |
| `phase`              | Yes      | Must match a phase key              |
| `priority`           | Yes      | `critical`, `high`, `medium`, `low` |
| `estimatedHours`     | Yes      | Conservative estimate               |
| `dependencies`       | Yes      | IDs of prerequisite tasks           |
| `acceptanceCriteria` | Yes      | Verifiable pass/fail conditions     |

## Workflow

1. **Read the PRD** - Extract user stories and requirements
2. **Group into phases** - Foundation → Core → Polish
3. **Create tasks** - One cohesive unit per task (2-8h)
4. **Wire dependencies** - Keep minimal, no cycles
5. **Validate** using the task-pipeline CLI:

```bash
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" validate tasks.json --summary
```

This checks: valid JSON, missing dependencies, circular dependencies, phase
keys, unique IDs, and shows the topological execution order.

**If validation fails**, the CLI prints a specific error. Fix the issue before
proceeding.

## Output

Write `tasks.json` to the project root.
