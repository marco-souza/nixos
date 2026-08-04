/**
 * Show task execution status from tasks/ directory markers.
 *
 * Usage:
 *   task-pipeline status [options]
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadTasks,
  findTasksJson,
  scanTaskStatus,
  computeStats,
  topologicalSort,
  computeWaves,
  TaskError,
  type TaskStatus,
  type TasksData,
} from "../lib/tasks-lib.ts";
import {
  parseArgs,
  printHelp,
  logTable,
  style,
  die,
  type FlagSpec,
  type HelpSpec,
} from "../lib/cli-utils.ts";

// ── Specs ────────────────────────────────────────────────────────────

const FLAGS: FlagSpec[] = [
  { name: "--compact", short: "-c", type: "boolean", desc: "One-line summary only" },
  { name: "--json", short: "-j", type: "boolean", desc: "Machine-readable JSON output" },
  { name: "--pending", type: "boolean", desc: "Only pending tasks (not blocked)" },
  { name: "--ready", type: "boolean", desc: "Only tasks ready to spawn (deps met, not running/done)" },
  { name: "--running", type: "boolean", desc: "Only running tasks" },
  { name: "--done", type: "boolean", desc: "Only completed tasks" },
  { name: "--blocked", type: "boolean", desc: "Only blocked tasks" },
  { name: "--help", short: "-h", type: "boolean", desc: "Show this help" },
];

export const HELP: HelpSpec = {
  name: "task-pipeline status",
  description: "Show task execution status",
  usage: "task-pipeline status [options]",
  flags: FLAGS,
};

// ── Helpers ──────────────────────────────────────────────────────────

const STATUS_ICON: Record<TaskStatus, string> = {
  done: "✅",
  running: "🔄",
  pending: "⏳",
  blocked: "🚫",
};

const STATUS_STYLE: Record<TaskStatus, (s: string) => string> = {
  done: style.green,
  running: style.blue,
  pending: style.dim,
  blocked: style.red,
};

/** Count tasks by status from the full status map. */
function countByStatus(status: Map<string, TaskStatus>): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { done: 0, running: 0, pending: 0, blocked: 0 };
  for (const s of status.values()) counts[s]++;
  return counts;
}

// ── Output Modes ─────────────────────────────────────────────────────

function printCompact(tasks: TasksData["tasks"], status: Map<string, TaskStatus>) {
  const counts = countByStatus(status);
  const total = tasks.length;
  const pct = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const parts = [
    `${style.green(String(counts.done))}/${total} done`,
    `${style.bold(String(pct))}%`,
    `running: ${style.blue(String(counts.running))}`,
    `pending: ${style.dim(String(counts.pending))}`,
    `blocked: ${style.red(String(counts.blocked))}`,
  ];
  console.log(parts.join(" | "));
}

function printJson(data: TasksData, status: Map<string, TaskStatus>) {
  const stats = computeStats(data);
  const order = topologicalSort(data.tasks);
  const waves = computeWaves(data.tasks);
  const statusObj: Record<string, string> = {};
  for (const [tid, s] of status) statusObj[tid] = s;
  console.log(JSON.stringify({ stats, topologicalOrder: order, waves, status: statusObj }, null, 2));
}

function printFull(
  filteredTasks: TasksData["tasks"],       // tasks matching the current filter
  allTasks: TasksData["tasks"],             // all tasks (for summary counts)
  status: Map<string, TaskStatus>,
  stats: ReturnType<typeof computeStats>,
) {
  const waves = computeWaves(allTasks);

  // ── Table ──
  const headers = ["ID", "Status", "Title", "Phase", "Agent", "Hrs"];
  const rows = filteredTasks.map((task) => {
    const s = status.get(task.id) ?? "pending";
    const icon = STATUS_ICON[s];
    const styledStatus = STATUS_STYLE[s](s);
    return [
      `${icon} ${task.id}`,
      styledStatus,
      task.title,
      task.phase,
      task.agent,
      String(task.estimatedHours),
    ];
  });
  logTable(headers, rows);

  // ── Summary (always from ALL tasks, not just filtered)  ──
  const counts = countByStatus(status);
  const total = allTasks.length;
  const pct = total > 0 ? Math.round((counts.done / total) * 100) : 0;

  console.log(
    `\nTotal: ${total} tasks | ✅ ${counts.done} | 🔄 ${counts.running} | ⏳ ${counts.pending} | 🚫 ${counts.blocked} | ${style.bold(String(pct))}% complete`,
  );
  console.log(
    `Estimated: ${stats.totalHours}h | Critical path: ${style.yellow(String(stats.criticalPath.hours))}h (${stats.criticalPath.path.join(" → ")})`,
  );

  // ── Waves ──
  console.log(`\nExecution waves: ${waves.length}`);
  waves.forEach((wave, i) => {
    const waveStatuses = wave.map((tid) => status.get(tid) ?? "pending");
    const doneCount = waveStatuses.filter((s) => s === "done").length;
    const label = doneCount === wave.length
      ? style.green(`${doneCount}/${wave.length} done`)
      : `${doneCount}/${wave.length} done`;
    console.log(`  Wave ${i + 1}: ${wave.join(", ")} (${label})`);
  });
}

// ── Filter Logic ─────────────────────────────────────────────────────

type FilterFn = (s: TaskStatus | undefined) => boolean;

const FILTERS: Record<string, FilterFn | undefined> = {
  "--pending": (s) => s === "pending",
  "--ready": (s) => s === "pending",       // "pending" = deps met, not started
  "--running": (s) => s === "running",
  "--done": (s) => s === "done",
  "--blocked": (s) => s === "blocked",
};

// ── Run ──────────────────────────────────────────────────────────────

export async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv, FLAGS);
  if (flags["--help"]) { printHelp(HELP); return; }

  try {
    // Resolve tasks.json path (positional or auto-detect)
    const tasksPath = positional[0] ?? findTasksJson();
    const data = await loadTasks(tasksPath);
    const { tasks } = data;
    const tasksDir = join(process.cwd(), "tasks");
    const status = scanTaskStatus(tasks, existsSync(tasksDir) ? tasksDir : undefined);

    // Check for mutually exclusive filter flags
    const activeFilters = Object.keys(FILTERS).filter((f) => flags[f]);
    if (activeFilters.length > 1) {
      die(`Mutually exclusive flags: ${activeFilters.join(", ")}`);
    }

    // Compact mode
    if (flags["--compact"]) {
      printCompact(tasks, status);
      return;
    }

    // JSON mode
    if (flags["--json"]) {
      printJson(data, status);
      return;
    }

    // Apply filter
    const activeFilter = activeFilters[0];
    const filterFn = activeFilter ? FILTERS[activeFilter]! : undefined;
    const filteredTasks = filterFn ? tasks.filter((t) => filterFn(status.get(t.id))) : tasks;

    const stats = computeStats(data);
    printFull(filteredTasks, tasks, status, stats);
  } catch (e) {
    die(e instanceof TaskError ? e.message : String(e));
  }
}
