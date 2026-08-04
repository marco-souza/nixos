# task-pipeline

A **production-grade Bun CLI** for managing DAG-based task execution with the [pi](https://pi.ai) agent.

Provides validation, status tracking, prompt generation, and tmux-based wave spawning for `tasks.json` plans.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [validate](#validate)
  - [status](#status)
  - [prompts](#prompts)
  - [spawn](#spawn)
- [Data Model](#data-model)
- [Library API](#library-api)
- [Integration with Pi Skills](#integration-with-pi-skills)
- [Logging & Debugging](#logging--debugging)
- [Error Handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Installation

### Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| [Bun](https://bun.sh) | >= 1.0 | Runtime & package manager |
| [tmux](https://github.com/tmux/tmux) | >= 3.0 | Session management for `spawn` |
| [pi](https://pi.ai) | latest | Task execution in spawned agents |

### Install via Bun

```bash
# From the project root
cd /path/to/task-pipeline
bun install
```

### Global Access (Optional)

Link the CLI globally so `task-pipeline` is available everywhere:

```bash
# Option 1: Add to PATH manually
export PATH="/path/to/task-pipeline/src:$PATH"

# Option 2: Use npm link (creates global symlink)
cd /path/to/task-pipeline
bun link
```

Verify installation:

```bash
task-pipeline --version
# Output: 1.0.0
```

## Quick Start

```bash
cd /path/to/your/project   # where tasks.json lives

# Validate your task plan
task-pipeline validate --topo

# Check execution status
task-pipeline status --compact

# Generate prompt files
task-pipeline prompts

# Spawn all tasks in parallel waves
task-pipeline spawn --all
```

## Commands

### `validate`

Validate a `tasks.json` file against the PRD-to-Tasks schema. Checks for required fields, unique IDs, valid dependencies, phase consistency, agent assignments, and circular dependencies.

```bash
task-pipeline validate [path] [options]
```

#### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--quiet` | `-q` | Exit code only, no output |
| `--summary` | | Show phase & agent breakdown |
| `--topo` | | Print topological execution order |
| `--waves` | | Print parallel execution waves |
| `--json` | | Machine-readable JSON output |
| `--help` | `-h` | Show help |

#### Examples

```bash
# Basic validation
task-pipeline validate tasks.json

# Validate with topological order
task-pipeline validate --topo

# Machine-readable output
task-pipeline validate --json

# Quiet mode (use in scripts)
task-pipeline validate --quiet && echo "Valid" || echo "Invalid"
```

#### Validation Checks

The validator performs 9 checks in order:

1. **Required fields** — All tasks have `id`, `title`, `description`, `phase`, `priority`, `estimatedHours`, `dependencies`, `agent`, `moeExperts`, `acceptanceCriteria`
2. **Unique IDs** — No duplicate task identifiers
3. **Valid phases** — All tasks reference existing phase keys
4. **Valid dependencies** — All dependency IDs reference existing tasks
5. **No cycles** — DAG has no circular dependencies (Kahn's algorithm)
6. **Phase consistency** — Phase task lists match actual assignments
7. **Agent consistency** — Agent assignments match task.agent fields
8. **Valid priorities** — All priorities are `critical`, `high`, `medium`, or `low`
9. **Metadata consistency** — `totalTasks` and `totalEstimatedHours` match actual values

---

### `status`

Show task execution status by reading `.done` and `.out` marker files from the `tasks/` directory.

```bash
task-pipeline status [options]
```

#### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--compact` | `-c` | One-line summary only |
| `--json` | `-j` | Machine-readable JSON output |
| `--pending` | | Only pending tasks (not started) |
| `--ready` | | Only tasks ready to spawn (alias for `--pending`) |
| `--running` | | Only running tasks |
| `--done` | | Only completed tasks |
| `--blocked` | | Only blocked tasks |
| `--help` | `-h` | Show help |

#### Status Types

| Status | Icon | Meaning |
|--------|------|---------|
| `done` | ✅ | Task completed (`{id}.done` marker exists) |
| `running` | 🔄 | Task in progress (`{id}.out` marker exists) |
| `pending` | ⏳ | Ready to execute (all dependencies met) |
| `blocked` | 🚫 | Waiting on incomplete dependencies |

#### Examples

```bash
# Full status table
task-pipeline status

# Compact one-liner
task-pipeline status --compact
# Output: 3/10 done | 30% | running: 2 | pending: 3 | blocked: 2

# Filter to only pending tasks
task-pipeline status --pending

# JSON output for scripting
task-pipeline status --json | jq '.stats.totalHours'
```

#### Mutual Exclusion

Filter flags (`--pending`, `--running`, `--done`, `--blocked`, `--ready`) are mutually exclusive. Using multiple filters produces an error.

---

### `prompts`

Generate self-contained prompt files from `tasks.json`, one per task in topological order. Each prompt includes task context, dependencies, and acceptance criteria.

```bash
task-pipeline prompts [path] [options]
```

#### Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview without writing files |
| `--no-validate` | Skip validation step |
| `--prd <path>` | Path to PRD.md for extra context |
| `--help` | `-h` Show help |

#### Output Format

Each prompt file is written to `tasks/{TASK_ID}-prompt` with this structure:

```
WORKDIR: /path/to/project
TASK_ID: T001
TASK_TITLE: Implement feature X
AGENT: default
PHASE: 1-implementation
PRIORITY: high
ESTIMATED: 4h

DESCRIPTION:
Task description...

DEPENDENCIES (completed before this task):
- T000: Previous task — Description...

EXPERT PERSPECTIVES TO CONSIDER:
- Expert 1
- Expert 2

WHAT YOU MUST DO:
1. Discover relevant source files...
2. Implement the changes...
...

ACCEPTANCE CRITERIA:
- Criterion 1
- Criterion 2

AFTER COMPLETION:
Write "T001_DONE" to tasks/T001.done
```

#### Examples

```bash
# Generate prompts (validates first by default)
task-pipeline prompts

# Preview without writing
task-pipeline prompts --dry-run

# Include PRD context
task-pipeline prompts --prd docs/PRD.md

# Skip validation (faster)
task-pipeline prompts --no-validate
```

---

### `spawn`

Spawn tmux sub-agents that execute tasks using the pi CLI. Respects the DAG and supports wave-based parallel execution.

```bash
task-pipeline spawn [task-ids...] [options]
```

#### Options

| Flag | Description |
|------|-------------|
| `--all` | Spawn all waves sequentially |
| `--dry-run` | Show what would spawn without executing |
| `--session-prefix <name>` | Custom tmux session prefix (default: `task`) |
| `--help` | `-h` Show help |

#### Modes

**Default (no arguments):**
```bash
task-pipeline spawn
```
Scans for the next ready wave — tasks whose dependencies are all complete — and spawns them in parallel.

**Specific tasks:**
```bash
task-pipeline spawn T001 T003
```
Spawns only the specified task IDs, ignoring dependency order.

**All waves:**
```bash
task-pipeline spawn --all
```
Spawns all remaining waves sequentially, waiting for each wave to complete before starting the next.

#### Tmux Session Naming

Sessions are named `{prefix}-{TASK_ID}`:

```bash
# Default prefix
task-pipeline spawn T001
# Session: task-T001

# Custom prefix
task-pipeline spawn --session-prefix proj T001
# Session: proj-T001
```

#### Auto-Generation

If no prompt files exist in `tasks/`, `spawn` automatically runs the `prompts` command to generate them before spawning.

#### Examples

```bash
# Spawn next ready wave
task-pipeline spawn

# Spawn specific tasks
task-pipeline spawn T001 T003

# Preview spawn plan
task-pipeline spawn --all --dry-run

# Custom session prefix
task-pipeline spawn --session-prefix myproject --all
```

---

## Data Model

### tasks.json Schema

```typescript
interface TasksData {
  $schema: string;
  metadata: {
    totalTasks?: number;
    totalEstimatedHours?: number;
    prd?: string;
    [key: string]: unknown;
  };
  phases: Record<string, Phase>;
  tasks: Task[];
  agents: Record<string, AgentInfo>;
}

interface Task {
  id: string;                    // e.g., "T001"
  title: string;
  description: string;
  phase: string;                 // References a phase key
  priority: "critical" | "high" | "medium" | "low";
  estimatedHours: number;
  dependencies: string[];        // Array of task IDs
  agent: string;                 // References an agent key
  moeExperts: string[];          // Mixture-of-experts perspectives
  acceptanceCriteria: string[];
  userStory?: string | null;
  functionalReq?: string | null;
  tags?: string[];
}

interface Phase {
  label: string;                 // e.g., "1-documentation"
  description: string;
  tasks: string[];               // Task IDs in this phase
}

interface AgentInfo {
  role: string;
  tasks: string[];
}
```

### Filesystem Layout

```
your-project/
├── tasks.json                           # Task plan
├── PRD.md                               # Optional PRD for context
└── tasks/                               # Execution artifacts
    ├── T001-prompt                      # Generated prompt
    ├── T001.out                         # Execution output
    ├── T001.done                        # Completion marker
    ├── T002-prompt
    └── ...
```

### Status Markers

| File | Meaning |
|------|---------|
| `tasks/{ID}-prompt` | Prompt file for task |
| `tasks/{ID}.out` | Task is running (stdout captured here) |
| `tasks/{ID}.done` | Task completed (contains `{ID}_DONE`) |

### Task Status Resolution

Status is determined by marker file presence:

```
done     → {ID}.done exists
running  → {ID}.out exists AND {ID}.done does NOT exist
pending  → No markers, all dependencies satisfied
blocked  → No markers, one or more dependencies incomplete
```

---

## Library API

The `src/lib/tasks-lib.ts` module provides pure domain logic for programmatic use. Import directly in TypeScript/Bun projects:

```typescript
import {
  // Data Loading
  findTasksJson,
  loadTasks,

  // Dependency Graph
  buildAdjacency,
  buildReverseAdjacency,
  validateDependencies,
  detectCycles,

  // Topological Sort
  topologicalSort,

  // Wave Computation
  computeWaves,

  // Critical Path
  criticalPath,

  // Task Query
  getTaskById,
  getTasksByPhase,
  getReadyTasks,
  getBlockedTasks,

  // Status Tracking
  scanTaskStatus,
  computeStats,
  resolveTasksDir,
  readDoneMarkers,
  readPrompt,
  generateRunnerScript,

  // Error Handling
  TaskError,
} from "./lib/tasks-lib.ts";
```

### Function Reference

#### Data Loading

| Function | Signature | Description |
|----------|-----------|-------------|
| `findTasksJson` | `(startDir?: string) => string` | Walk up from `startDir` (default: cwd) to find tasks.json. Also checks `tasks/tasks.json`. Throws `TaskError` if not found. |
| `loadTasks` | `(path?: string) => Promise<TasksData>` | Load and parse a tasks.json file. If no path, auto-detects via `findTasksJson`. |

#### Dependency Graph

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildAdjacency` | `(tasks: Task[]) => Map<string, string[]>` | Build adjacency map: task ID → its dependency IDs. |
| `buildReverseAdjacency` | `(tasks: Task[]) => Map<string, string[]>` | Build reverse adjacency: task ID → tasks that depend on it. |
| `validateDependencies` | `(tasks: Task[]) => string[]` | Return errors for dependencies referencing non-existent tasks. |
| `detectCycles` | `(tasks: Task[]) => string[]` | Detect circular dependencies. Returns cycle descriptions. |

#### Topological Sort

| Function | Signature | Description |
|----------|-----------|-------------|
| `topologicalSort` | `(tasks: Task[]) => string[]` | Return task IDs in dependency-first order. Uses Kahn's algorithm. Throws `TaskError` on circular dependencies. |

#### Wave Computation

| Function | Signature | Description |
|----------|-----------|-------------|
| `computeWaves` | `(tasks: Task[]) => string[][]` | Partition tasks into parallel execution waves. Tasks within a wave can run concurrently; waves execute sequentially. |

#### Critical Path

| Function | Signature | Description |
|----------|-----------|-------------|
| `criticalPath` | `(tasks: Task[]) => { hours: number; path: string[] }` | Compute the longest dependency chain through the DAG. |

#### Task Query

| Function | Signature | Description |
|----------|-----------|-------------|
| `getTaskById` | `(tasks: Task[], tid: string) => Task \| undefined` | Find a task by its ID. |
| `getTasksByPhase` | `(tasks: Task[], phase: string) => Task[]` | Get all tasks in a given phase. |
| `getReadyTasks` | `(tasks: Task[], doneIds: Set<string>) => string[]` | Return IDs of tasks whose dependencies are all satisfied. |
| `getBlockedTasks` | `(tasks: Task[], doneIds: Set<string>) => Array<{ id: string; blockedBy: string[] }>` | Return blocked tasks with their unmet dependencies. |

#### Status Tracking

| Function | Signature | Description |
|----------|-----------|-------------|
| `scanTaskStatus` | `(tasks: Task[], tasksDir?: string) => Map<string, TaskStatus>` | Scan the tasks directory for `.done`/`.out` markers and derive status for every task. |
| `computeStats` | `(data: TasksData) => TaskStats` | Aggregate summary statistics including phase/agent breakdowns and critical path. |
| `resolveTasksDir` | `(projectDir?: string) => string` | Return the tasks directory path (default: `cwd/tasks`). |
| `readDoneMarkers` | `(tasksDir: string) => Set<string>` | Read all completed task IDs from `.done` markers. |
| `readPrompt` | `(tasksDir: string, tid: string) => string \| null` | Read the content of a prompt file. |
| `generateRunnerScript` | `(tid, projectDir, tasksDir, promptContent) => string` | Generate a bash runner script for tmux execution. Returns script path. |

### Types

```typescript
type TaskStatus = "done" | "running" | "pending" | "blocked";

interface TaskStats {
  totalTasks: number;
  totalHours: number;
  phases: Record<string, PhaseStats>;
  agents: Record<string, AgentStats>;
  criticalPath: { hours: number; path: string[] };
}

interface PhaseStats {
  label: string;
  count: number;
  hours: number;
}

interface AgentStats {
  role: string;
  count: number;
  hours: number;
}
```

---

## Integration with Pi Skills

The task-pipeline is designed to work with the [pi agent skill system](/Users/marco/.pi/agent/skills/). Here's how it fits into the workflow:

### Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  /skill:grill-with-docs                                         │
│  ↓                                                              │
│  PRD.md (requirements)                                          │
│  ↓                                                              │
│  /skill:prd-to-tasks                                            │
│  ↓                                                              │
│  tasks.json (task plan)                                         │
│  ↓                                                              │
│  task-pipeline validate  →  Verify schema & DAG                 │
│  ↓                                                              │
│  task-pipeline prompts   →  Generate per-task prompts           │
│  ↓                                                              │
│  task-pipeline spawn     →  Execute via tmux sub-agents         │
│       ↓                                                         │
│       ├── Wave 1: [T001, T002, T003]  (parallel)              │
│       ├── Wave 2: [T004, T005]        (parallel)              │
│       └── Wave 3: [T006]              (sequential)             │
│  ↓                                                              │
│  task-pipeline status    →  Track progress                      │
│  ↓                                                              │
│  /skill:quality-assurance  →  Validate results                  │
└─────────────────────────────────────────────────────────────────┘
```

### Skill Integration

| Skill | Pipeline Command | Description |
|-------|------------------|-------------|
| `/skill:prd-to-tasks` | — | Generates `tasks.json` from PRD |
| `/skill:implement-tasks` | `spawn` | Orchestrates task execution |
| `/skill:quality-assurance` | `status` | Validates completion |

### Spawning from Pi Skills

The `/skill:implement-tasks` skill internally calls:

```bash
# 1. Validate the plan
task-pipeline validate --quiet

# 2. Generate prompts
task-pipeline prompts --no-validate

# 3. Execute first wave
task-pipeline spawn
```

Each spawned task runs a pi agent that:
1. Reads its prompt file
2. Discovers and edits source files
3. Verifies acceptance criteria
4. Writes `{TASK_ID}_DONE` to `tasks/{TASK_ID}.done`

---

## Logging & Debugging

### Verbose Output

By default, commands print success/error indicators. Use these flags for more detail:

```bash
# Show full validation details
task-pipeline validate --summary --topo --waves

# JSON output for inspection
task-pipeline status --json | jq .

# Preview prompt content
task-pipeline prompts --dry-run
```

### Task Execution Output

When a task is spawned via tmux, its output is captured to:

```
tasks/{TASK_ID}.out
```

View with:

```bash
# Real-time tail
tail -f tasks/T001.out

# Full log
cat tasks/T001.out
```

### Tmux Sessions

Monitor active tmux sessions:

```bash
# List all task sessions
tmux ls | grep task-

# Attach to a running task
tmux attach -t task-T001

# Detach: Ctrl+B, then D
```

### Completion Markers

Check which tasks are done:

```bash
# List completed tasks
ls tasks/*.done 2>/dev/null | sed 's/\.done//;s/tasks\///'

# Or via status command
task-pipeline status --done
```

### Debugging Failed Tasks

```bash
# Check task status
task-pipeline status --blocked

# View output of failed task
cat tasks/T001.out

# Check prompt that was used
cat tasks/T001-prompt
```

---

## Error Handling

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Validation error, task not found, or runtime failure |

### Error Format

Errors are printed to stderr with a red `✗` prefix:

```
  ✗ tasks.json not found at /path/to/tasks.json
```

### Common Error Types

| Error | Cause | Solution |
|-------|-------|----------|
| `tasks.json not found` | No `tasks.json` in current or parent directories | Run from project root or pass path explicitly |
| `Circular dependency detected` | DAG contains a cycle | Review task dependencies and break the cycle |
| `Duplicate task IDs` | Multiple tasks with the same ID | Ensure all task IDs are unique |
| `Missing required field` | Task missing mandatory property | Add the required field to the task |
| `Flag requires a value` | String flag without argument | Provide the value: `--flag value` or `--flag=value` |
| `Unknown flag` | Unrecognized CLI option | Check `--help` for valid flags |

### Catching Errors in Code

When using the library API:

```typescript
import { loadTasks, TaskError } from "./lib/tasks-lib.ts";

try {
  const data = await loadTasks("tasks.json");
  // Process data...
} catch (e) {
  if (e instanceof TaskError) {
    console.error(`Task pipeline error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
```

---

## Troubleshooting

### "tasks.json not found"

**Cause:** The CLI searches upward from the current directory.

**Solution:**
```bash
# Run from the project root
cd /path/to/your/project
task-pipeline validate

# Or pass the path explicitly
task-pipeline validate /path/to/tasks.json
```

### "Circular dependency detected"

**Cause:** Task A depends on B, which depends on A.

**Solution:**
```bash
# See which tasks are involved
task-pipeline validate 2>&1 | grep "Circular"

# Review and break the cycle in tasks.json
```

### tmux "duplicate session" errors

**Cause:** A session with the same name already exists.

**Solution:** The `spawn` command automatically kills existing sessions before creating new ones. If issues persist:

```bash
# Kill all task sessions
tmux ls | grep task- | cut -d: -f1 | xargs -I {} tmux kill-session -t {}

# Or with custom prefix
tmux ls | grep myprefix- | cut -d: -f1 | xargs -I {} tmux kill-session -t {}
```

### Spawned tasks not completing

**Cause:** Task may have crashed or is waiting for input.

**Solution:**
```bash
# Check task output
cat tasks/T001.out

# Check if task is still running
tmux ls | grep task-T001

# Check for done marker
ls tasks/T001.done
```

### Prompt generation missing context

**Cause:** PRD not found or no relevant sections.

**Solution:**
```bash
# Specify PRD explicitly
task-pipeline prompts --prd docs/PRD.md

# Check PRD has "Executive Summary" or "Decisions" sections
grep "^## " docs/PRD.md
```

### "No tasks ready (all done or blocked)"

**Cause:** `spawn` (without `--all`) found no tasks with satisfied dependencies.

**Solution:**
```bash
# Check which tasks are blocked
task-pipeline status --blocked

# Wait for running tasks to complete, or use --all
task-pipeline spawn --all
```

---

## Development

### Project Structure

```
task-pipeline/
├── package.json               # Bun package with bin + scripts
├── tsconfig.json              # Strict TypeScript config
├── bun.lock
├── README.md
└── src/
    ├── cli.ts                 # CLI entry point (#!/usr/bin/env bun)
    ├── commands/
    │   ├── validate.ts        # Validate tasks.json schema and DAG
    │   ├── status.ts          # Show task execution status
    │   ├── prompts.ts         # Generate prompt files from tasks.json
    │   └── spawn.ts           # Spawn tmux sub-agents
    └── lib/
        ├── tasks-lib.ts       # Domain logic (types, DAG, waves, stats)
        └── cli-utils.ts       # CLI utilities (arg parsing, ANSI, tables)
```

### Available Scripts

```bash
# Install dependencies
bun install

# Type-check
bunx tsc --noEmit

# Run commands
bun run validate -- --topo
bun run status -- --compact
bun run prompts -- --dry-run
bun run spawn -- --all
```

### Adding a New Command

1. Create `src/commands/my-command.ts`:

```typescript
import { parseArgs, printHelp, type FlagSpec, type HelpSpec } from "../lib/cli-utils.ts";

const FLAGS: FlagSpec[] = [
  { name: "--my-flag", type: "boolean", desc: "Description" },
  { name: "--help", short: "-h", type: "boolean", desc: "Show help" },
];

export const HELP: HelpSpec = {
  name: "task-pipeline my-command",
  description: "Description of my command",
  usage: "task-pipeline my-command [options]",
  flags: FLAGS,
};

export async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv, FLAGS);
  if (flags["--help"]) { printHelp(HELP); return; }
  // Implementation...
}
```

2. Register in `src/cli.ts`:

```typescript
const COMMANDS: Command[] = [
  // ... existing commands
  {
    name: "my-command",
    description: "Description of my command",
    run: (argv) => import("./commands/my-command.ts").then((m) => m.run(argv)),
  },
];
```

3. Add npm script in `package.json`:

```json
{
  "scripts": {
    "my-command": "bun src/cli.ts my-command"
  }
}
```

---

## License

Private — internal tool for the pi agent ecosystem.
