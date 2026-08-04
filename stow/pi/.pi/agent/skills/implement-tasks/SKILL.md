---
name: implement-tasks
description: >
  Read a tasks.json file, resolve dependencies, and implement each task
  in the correct order using the task-pipeline CLI.
  Use when a tasks.json exists and needs execution.
  Do NOT use when there is no tasks.json (use implement instead).
---

# Implement Tasks

Execute a `tasks.json` plan one task at a time, respecting dependencies.

## When to Use

- A `tasks.json` exists
- The user says "implement the tasks" or "execute the plan"

## When NOT to Use

- No `tasks.json` → Use `prd-to-tasks` first
- Single-file change → Use `implement` directly

## Prerequisites

- `task-pipeline` CLI available at `$HOME/.pi/agent/scripts/task-pipeline/`
- `tmux` installed
- `pi` CLI available on PATH

## Workflow

### 1. Validate the Task Graph

```bash
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" validate tasks.json --summary
```

This checks: valid JSON, missing dependencies, circular dependencies, phase
keys, unique IDs. With `--summary` it also prints phase breakdown and critical path.

**If validation fails**, stop and report the issues. Do NOT proceed until fixed.

### 2. Determine Execution Order

Use topological sort to group tasks into parallel waves:

```bash
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" validate tasks.json --waves
```

| Wave | Tasks | Deps |
|------|-------|------|
| 1 | T001, T002 | (none) |
| 2 | T003, T004 | T001 |
| 3 | T005 | T002, T003 |

### 3. Generate Prompt Files

```bash
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" prompts tasks.json
```

This generates `tasks/TASK-XXXX-prompt` files — self-contained prompts that
each subagent receives as input.

### 4. Spawn tmux Subagents (NEVER implement directly)

**This skill is a pure orchestrator — it never writes code itself.** Every
task is delegated to an isolated tmux session running `pi`:

```bash
# Spawn next ready wave (auto-detects pending tasks)
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" spawn

# Spawn specific tasks
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" spawn T001 T003

# Preview what would spawn
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" spawn --dry-run
```

#### Async Wave-by-Wave Pattern

```bash
# 1. Spawn first wave (returns immediately)
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" spawn

# 2. Check status — poll until wave completes
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" status --compact

# 3. When current wave is done, spawn the next wave
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" spawn

# 4. Repeat steps 2-3 until all tasks are done
```

#### Monitoring

```bash
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" status           # full table
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" status --compact  # one-liner
bun "$HOME/.pi/agent/scripts/task-pipeline/src/cli.ts" status --pending  # pending only

# Peek at a specific task's live output
tmux capture-pane -t task-T005 -p | tail -20
```

### 5. Verify Completion

After each task, verify against acceptance criteria:

```
✅ T001: Set up project structure
  - ✓ Directory structure matches conventions
  - ✓ Type definitions compile
```

### 6. Handle Failures

If a task cannot be completed:

1. **Diagnose** — Is it a code bug, missing info, design flaw?
2. **If fixable:** Fix and re-verify
3. **If blocked:** Use `grill-with-docs` to ask the user
4. **If dependency was wrong:** Fix the dependency first, then retry

### 7. Report Progress

```
Phase 1: ✅ T001 setup, T002 config
Phase 2: 🔄 T003 in progress...
```

### 8. Final Report

When all tasks complete:

```
All [N] tasks complete. Acceptance criteria verified.
```

## Key Rules

- **Don't skip dependencies** — implement in order
- **Verify acceptance criteria** — ensure each is met before moving on
- **Report blockers** — if a task can't proceed, explain why
- **Never implement directly** — always delegate to tmux subagents
