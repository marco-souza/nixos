/**
 * Domain library for tasks.json operations.
 *
 * Pure logic only — no I/O side effects beyond loading/saving files,
 * no presentation/formatting.  CLI concerns belong in cli-utils.ts.
 *
 * Usage:
 *   import { loadTasks, topologicalSort, computeWaves } from "./lib/tasks-lib.ts";
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

/** A single task in the DAG. */
export interface Task {
  id: string;
  title: string;
  description: string;
  phase: string;
  priority: "critical" | "high" | "medium" | "low";
  estimatedHours: number;
  dependencies: string[];
  agent: string;
  moeExperts: string[];
  acceptanceCriteria: string[];
  userStory?: string | null;
  functionalReq?: string | null;
  tags?: string[];
}

/** A named phase grouping tasks. */
export interface Phase {
  label: string;
  description: string;
  tasks: string[];
}

/** Agent role and assigned tasks. */
export interface AgentInfo {
  role: string;
  tasks: string[];
}

/** Top-level tasks.json structure. */
export interface TasksData {
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

/** Resolved status for a single task. */
export type TaskStatus = "done" | "running" | "pending" | "blocked";

/** Stats for a single phase. */
export interface PhaseStats {
  label: string;
  count: number;
  hours: number;
}

/** Stats for a single agent. */
export interface AgentStats {
  role: string;
  count: number;
  hours: number;
}

/** Aggregate summary statistics from a loaded tasks.json. */
export interface TaskStats {
  totalTasks: number;
  totalHours: number;
  phases: Record<string, PhaseStats>;
  agents: Record<string, AgentStats>;
  criticalPath: { hours: number; path: string[] };
}

// ── Errors ──────────────────────────────────────────────────────────────

/** Domain error for task pipeline operations. */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

// ── Path Resolution ────────────────────────────────────────────────────

/**
 * Walk up from `startDir` (default: cwd) to find a tasks.json.
 * Also checks `tasks/tasks.json` as a fallback.
 * Throws TaskError when not found.
 */
export function findTasksJson(startDir?: string): string {
  let here = resolve(startDir ?? process.cwd());
  for (let i = 0; i < 10; i++) {
    const candidate = join(here, "tasks.json");
    if (existsSync(candidate)) return candidate;
    const nested = join(here, "tasks", "tasks.json");
    if (existsSync(nested)) return nested;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  throw new TaskError(
    `tasks.json not found (searched from ${startDir ?? process.cwd()} and parents)`,
  );
}

// ── Data Loading ───────────────────────────────────────────────────────

/**
 * Load and parse a tasks.json file.
 * If no path given, walks up from cwd to find one.
 */
export async function loadTasks(path?: string): Promise<TasksData> {
  const filePath = path ? resolve(path) : findTasksJson();
  if (!existsSync(filePath)) {
    throw new TaskError(`tasks.json not found at ${filePath}`);
  }
  try {
    const raw = Bun.file(filePath);
    return (await raw.json()) as TasksData;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new TaskError(`Invalid JSON in ${filePath}: ${e.message}`);
    }
    throw e;
  }
}

// ── Dependency Graph ───────────────────────────────────────────────────

/** Build adjacency map: task id → its dependency ids. */
export function buildAdjacency(tasks: Task[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.id, [...(t.dependencies ?? [])]);
  return adj;
}

/** Build reverse adjacency: task id → tasks that depend on it. */
export function buildReverseAdjacency(tasks: Task[]): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const t of tasks) reverse.set(t.id, []);
  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) {
      const entry = reverse.get(dep);
      if (entry) entry.push(t.id);
    }
  }
  return reverse;
}

/** Return list of errors for dependencies referencing non-existent tasks. */
export function validateDependencies(tasks: Task[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const errors: string[] = [];
  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) {
      if (!ids.has(dep)) {
        errors.push(`${t.id} depends on non-existent task: '${dep}'`);
      }
    }
  }
  return errors;
}

/** Detect cycles in the dependency graph. Returns cycle descriptions. */
export function detectCycles(tasks: Task[]): string[] {
  const adj = buildAdjacency(tasks);
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[] = [];

  function dfs(n: string, path: string[]) {
    if (stack.has(n)) {
      const cycleStart = path.indexOf(n);
      const cycle = [...path.slice(cycleStart), n];
      cycles.push(cycle.join(" → "));
      return;
    }
    if (visited.has(n)) return;
    stack.add(n);
    visited.add(n);
    for (const dep of adj.get(n) ?? []) {
      dfs(dep, [...path, n]);
    }
    stack.delete(n);
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) dfs(t.id, []);
  }
  return cycles;
}

// ── Topological Sort (Kahn's algorithm) ────────────────────────────────

/**
 * Return task IDs in topological order (dependencies first).
 * Throws TaskError on circular dependencies.
 */
export function topologicalSort(tasks: Task[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const inDegree = new Map<string, number>();
  for (const t of tasks) inDegree.set(t.id, 0);

  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) {
      if (ids.has(dep)) {
        inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [tid, deg] of inDegree) {
    if (deg === 0) queue.push(tid);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const tid = queue.shift()!;
    result.push(tid);
    for (const t of tasks) {
      if ((t.dependencies ?? []).includes(tid)) {
        const newDeg = (inDegree.get(t.id) ?? 1) - 1;
        inDegree.set(t.id, newDeg);
        if (newDeg === 0) queue.push(t.id);
      }
    }
  }

  if (result.length !== ids.size) {
    const remaining = [...ids].filter((id) => !result.includes(id));
    throw new TaskError(
      `Circular dependency detected. Cannot order: ${remaining.join(", ")}`,
    );
  }

  return result;
}

// ── Wave Computation ───────────────────────────────────────────────────

/**
 * Partition tasks into parallel execution waves.
 * Tasks within a wave can run concurrently; waves must execute sequentially.
 * Throws TaskError if the DAG cannot be resolved.
 */
export function computeWaves(tasks: Task[]): string[][] {
  const ids = new Set(tasks.map((t) => t.id));
  const depsMap = new Map<string, Set<string>>();
  for (const t of tasks) {
    depsMap.set(t.id, new Set((t.dependencies ?? []).filter((d) => ids.has(d))));
  }

  const done = new Set<string>();
  const waves: string[][] = [];

  while (done.size < ids.size) {
    const ready = tasks
      .filter(
        (t) =>
          !done.has(t.id) &&
          [...(depsMap.get(t.id) ?? [])].every((d) => done.has(d)),
      )
      .map((t) => t.id)
      .sort();

    if (ready.length === 0) {
      const remaining = [...ids].filter((id) => !done.has(id));
      throw new TaskError(
        `Cannot resolve next wave. Remaining: ${remaining.join(", ")}`,
      );
    }

    waves.push(ready);
    for (const id of ready) done.add(id);
  }

  return waves;
}

// ── Critical Path ──────────────────────────────────────────────────────

/**
 * Compute the critical path (longest chain) through the DAG.
 * Returns total hours and ordered task ID list.
 */
export function criticalPath(
  tasks: Task[],
): { hours: number; path: string[] } {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const memo = new Map<string, { hours: number; path: string[] }>();

  function longest(tid: string): { hours: number; path: string[] } {
    const cached = memo.get(tid);
    if (cached) return cached;

    const task = taskMap.get(tid)!;
    if (!task.dependencies || task.dependencies.length === 0) {
      const result = { hours: task.estimatedHours, path: [tid] };
      memo.set(tid, result);
      return result;
    }

    let best: { hours: number; path: string[] } | null = null;
    for (const dep of task.dependencies) {
      if (taskMap.has(dep)) {
        const sub = longest(dep);
        if (!best || sub.hours > best.hours) {
          best = sub;
        }
      }
    }

    const result = {
      hours: best!.hours + task.estimatedHours,
      path: [...best!.path, tid],
    };
    memo.set(tid, result);
    return result;
  }

  let best: { hours: number; path: string[] } | null = null;
  for (const t of tasks) {
    const candidate = longest(t.id);
    if (!best || candidate.hours > best.hours) {
      best = candidate;
    }
  }

  return best ?? { hours: 0, path: [] };
}

// ── Task Query ────────────────────────────────────────────────────────

/** Find a task by its ID. */
export function getTaskById(tasks: Task[], tid: string): Task | undefined {
  return tasks.find((t) => t.id === tid);
}

/** Get all tasks assigned to a given phase. */
export function getTasksByPhase(tasks: Task[], phase: string): Task[] {
  return tasks.filter((t) => t.phase === phase);
}

/**
 * Return IDs of tasks whose dependencies are all satisfied.
 * These are ready to be worked on.
 */
export function getReadyTasks(
  tasks: Task[],
  doneIds: Set<string>,
): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks
    .filter((t) => !doneIds.has(t.id))
    .filter((t) =>
      (t.dependencies ?? []).filter((d) => ids.has(d)).every((d) => doneIds.has(d)),
    )
    .map((t) => t.id);
}

/** Return tasks that are blocked, along with their unmet dependencies. */
export function getBlockedTasks(
  tasks: Task[],
  doneIds: Set<string>,
): Array<{ id: string; blockedBy: string[] }> {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks
    .filter((t) => !doneIds.has(t.id))
    .map((t) => ({
      id: t.id,
      blockedBy: (t.dependencies ?? []).filter(
        (d) => ids.has(d) && !doneIds.has(d),
      ),
    }))
    .filter((e) => e.blockedBy.length > 0);
}

// ── Status Tracking ────────────────────────────────────────────────────

/**
 * Scan the tasks/ directory for .done and .out markers,
 * then derive the status of every task.
 */
export function scanTaskStatus(
  tasks: Task[],
  tasksDir?: string,
): Map<string, TaskStatus> {
  const dir = tasksDir ?? join(process.cwd(), "tasks");
  const ids = new Set(tasks.map((t) => t.id));
  const doneIds = new Set<string>();
  const runningIds = new Set<string>();

  if (existsSync(dir)) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith(".done")) {
        const tid = entry.slice(0, -5);
        if (ids.has(tid)) doneIds.add(tid);
      } else if (entry.endsWith(".out")) {
        const tid = entry.slice(0, -4);
        if (ids.has(tid) && !doneIds.has(tid)) runningIds.add(tid);
      }
    }
  }

  const status = new Map<string, TaskStatus>();
  for (const t of tasks) {
    if (doneIds.has(t.id)) {
      status.set(t.id, "done");
    } else if (runningIds.has(t.id)) {
      status.set(t.id, "running");
    } else {
      const deps = (t.dependencies ?? []).filter((d) => ids.has(d));
      const blocked = deps.length > 0 && !deps.every((d) => doneIds.has(d));
      status.set(t.id, blocked ? "blocked" : "pending");
    }
  }

  return status;
}

/** Aggregate summary statistics from a loaded tasks.json. */
export function computeStats(data: TasksData): TaskStats {
  const { tasks, phases, agents } = data;
  const totalHours = tasks.reduce((sum, t) => sum + t.estimatedHours, 0);

  const phaseStats: Record<string, PhaseStats> = {};
  for (const [key, p] of Object.entries(phases)) {
    const pt = tasks.filter((t) => t.phase === key);
    phaseStats[key] = {
      label: p.label,
      count: pt.length,
      hours: pt.reduce((sum, t) => sum + t.estimatedHours, 0),
    };
  }

  const agentStats: Record<string, AgentStats> = {};
  for (const [name, a] of Object.entries(agents)) {
    const at = tasks.filter((t) => t.agent === name);
    agentStats[name] = {
      role: a.role,
      count: at.length,
      hours: at.reduce((sum, t) => sum + t.estimatedHours, 0),
    };
  }

  return {
    totalTasks: tasks.length,
    totalHours,
    phases: phaseStats,
    agents: agentStats,
    criticalPath: criticalPath(tasks),
  };
}

/** Resolve the tasks directory path (default: cwd/tasks). */
export function resolveTasksDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), "tasks");
}

/** Read all .done marker IDs from a tasks directory. */
export function readDoneMarkers(tasksDir: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(tasksDir)) return done;
  const entries = readdirSync(tasksDir);
  for (const entry of entries) {
    if (entry.endsWith(".done")) done.add(entry.slice(0, -5));
  }
  return done;
}

/** Read the content of a prompt file. */
export function readPrompt(tasksDir: string, tid: string): string | null {
  const path = join(tasksDir, `${tid}-prompt`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** Generate a runner script for a task and return its path. */
export function generateRunnerScript(
  tid: string,
  projectDir: string,
  tasksDir: string,
  promptContent: string,
): string {
  const b64 = Buffer.from(promptContent, "utf-8").toString("base64");
  const scriptPath = `/tmp/task-${tid}.sh`;
  const script = `#!/bin/bash
set -e
cd "${projectDir}"
PROMPT_B64="${b64}"
pi --thinking low -p "$(echo "$PROMPT_B64" | base64 -d)" 2>&1 | tee "${tasksDir}/${tid}.out"
echo "${tid}_DONE" > "${tasksDir}/${tid}.done"
echo "✓ ${tid} completed at $(date)"
`;
  writeFileSync(scriptPath, script, "utf-8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}
