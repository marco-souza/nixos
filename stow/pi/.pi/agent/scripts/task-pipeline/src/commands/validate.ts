/**
 * Validate a tasks.json file against the PRD-to-Tasks schema.
 *
 * Usage:
 *   task-pipeline validate [path] [options]
 */


import {
  loadTasks,
  validateDependencies,
  detectCycles,
  topologicalSort,
  computeWaves,
  criticalPath,
  computeStats,
  validateTiers,
  tierForTask,
  TIERS,
  TaskError,
  type TasksData,
  type Task,
  type Tier,
} from "../lib/tasks-lib.ts";
import {
  parseArgs,
  printHelp,
  style,
  ok,
  die,
  type FlagSpec,
  type HelpSpec,
} from "../lib/cli-utils.ts";

// ── Specs ────────────────────────────────────────────────────────────

const FLAGS: FlagSpec[] = [
  { name: "--quiet", short: "-q", type: "boolean", desc: "Exit code only, no output" },
  { name: "--summary", type: "boolean", desc: "Show phase & agent breakdown" },
  { name: "--topo", type: "boolean", desc: "Print topological execution order" },
  { name: "--waves", type: "boolean", desc: "Print parallel execution waves" },
  { name: "--tiers", type: "boolean", desc: "Print model-tier breakdown" },
  { name: "--strict-tiers", type: "boolean", desc: "Treat missing/duplicate tier tags as errors" },
  { name: "--json", type: "boolean", desc: "Machine-readable JSON output" },
  { name: "--help", short: "-h", type: "boolean", desc: "Show this help" },
];

export const HELP: HelpSpec = {
  name: "task-pipeline validate",
  description: "Validate tasks.json schema and DAG",
  usage: "task-pipeline validate [path] [options]",
  flags: FLAGS,
};

// ── Validators ────────────────────────────────────────────────────────

/** Normalize data: fill in optional fields with defaults. */
function normalizeData(data: TasksData): TasksData {
  // Default agents to empty map
  if (!data.agents || typeof data.agents !== "object") {
    data.agents = {};
  }
  // Default task fields
  for (const t of data.tasks) {
    if (t.agent === undefined) t.agent = "default";
    if (t.moeExperts === undefined) t.moeExperts = [];
  }
  return data;
}

function validateTopLevel(data: TasksData): string[] {
  const errors: string[] = [];
  if (!Array.isArray(data.tasks)) errors.push("Missing or non-array top-level 'tasks'");
  if (!data.phases || typeof data.phases !== "object") errors.push("Missing top-level 'phases'");
  return errors;
}

function validateRequiredFields(tasks: TasksData["tasks"]): string[] {
  const required = [
    "id", "title", "description", "phase", "priority",
    "estimatedHours", "dependencies", "acceptanceCriteria",
  ] as const;
  const errors: string[] = [];
  for (const t of tasks) {
    for (const field of required) {
      if (!(field in t)) errors.push(`${t.id ?? "?"} missing required field: '${field}'`);
    }
  }
  return errors;
}

function validateUniqueIds(tasks: TasksData["tasks"]): string[] {
  const ids = tasks.map((t) => t.id);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const dupes = [...counts.entries()].filter(([, v]) => v > 1).map(([k]) => k);
  return dupes.length ? [`Duplicate task IDs: ${dupes.join(", ")}`] : [];
}

function validatePhases(tasks: TasksData["tasks"], phases: Record<string, { label: string }>): string[] {
  const phaseKeys = new Set(Object.keys(phases));
  return tasks.filter((t) => !phaseKeys.has(t.phase)).map((t) => `${t.id} references invalid phase: '${t.phase}'`);
}

function validatePhaseLists(tasks: TasksData["tasks"], phases: TasksData["phases"]): string[] {
  const errors: string[] = [];
  for (const [key, pd] of Object.entries(phases)) {
    const listed = new Set(pd.tasks);
    const actual = new Set(tasks.filter((t) => t.phase === key).map((t) => t.id));
    const onlyListed = [...listed].filter((x) => !actual.has(x));
    const onlyActual = [...actual].filter((x) => !listed.has(x));
    if (onlyListed.length || onlyActual.length) {
      const parts: string[] = [];
      if (onlyListed.length) parts.push(`listed but not assigned: ${onlyListed.join(", ")}`);
      if (onlyActual.length) parts.push(`assigned but not listed: ${onlyActual.join(", ")}`);
      errors.push(`Phase '${key}' mismatch — ${parts.join("; ")}`);
    }
  }
  return errors;
}

function validateAgents(tasks: TasksData["tasks"], agents: TasksData["agents"]): string[] {
  const agentMap = agents ?? {};
  const errors: string[] = [];
  if (Object.keys(agentMap).length === 0 && tasks.length > 0) {
    // No agents map — assign all tasks to "default" implicitly
    return errors;
  }
  const allAssigned = new Set<string>();
  for (const [name, ad] of Object.entries(agentMap)) {
    for (const tid of ad.tasks) {
      allAssigned.add(tid);
      const task = tasks.find((t) => t.id === tid);
      if (!task) errors.push(`Agent '${name}' references non-existent task: '${tid}'`);
      else if (task.agent !== name) errors.push(`Task '${tid}' has agent='${task.agent}' but listed under '${name}'`);
    }
  }
  const missing = tasks.map((t) => t.id).filter((id) => !allAssigned.has(id));
  if (missing.length) errors.push(`Tasks not assigned to any agent: ${missing.join(", ")}`);
  return errors;
}

function validatePriorities(tasks: TasksData["tasks"]): string[] {
  const valid = new Set(["critical", "high", "medium", "low"]);
  return tasks.filter((t) => !valid.has(t.priority)).map((t) => `${t.id} has invalid priority: '${t.priority}'`);
}

function validateMetadata(tasks: TasksData["tasks"], meta: TasksData["metadata"]): string[] {
  const errors: string[] = [];
  if (meta.totalTasks !== undefined && meta.totalTasks !== tasks.length) {
    errors.push(`metadata.totalTasks (${meta.totalTasks}) != actual tasks (${tasks.length})`);
  }
  if (meta.totalEstimatedHours !== undefined) {
    const actual = tasks.reduce((s, t) => s + t.estimatedHours, 0);
    if (Math.abs(meta.totalEstimatedHours - actual) > 0.01) {
      errors.push(`metadata.totalEstimatedHours (${meta.totalEstimatedHours}) != actual (${actual})`);
    }
  }
  return errors;
}

// ── Output ────────────────────────────────────────────────────────────

function printSummary(data: TasksData) {
  const { tasks, phases } = data;
  const agents = data.agents ?? {};
  console.log(`\n${style.bold("Phase Breakdown")}`);
  for (const [key, p] of Object.entries(phases)) {
    const pt = tasks.filter((t) => t.phase === key);
    const h = pt.reduce((s, t) => s + t.estimatedHours, 0);
    console.log(`  ${p.label}: ${pt.length} tasks, ${h}h`);
  }
  console.log(`\n${style.bold("Agent Breakdown")}`);
  for (const [name] of Object.entries(agents)) {
    const at = tasks.filter((t) => t.agent === name);
    const h = at.reduce((s, t) => s + t.estimatedHours, 0);
    console.log(`  ${name}: ${at.length} tasks, ${h}h`);
  }
  const cp = criticalPath(tasks);
  console.log(`\n${style.bold(`Critical Path (${cp.hours}h)`)}`);
  console.log(`  ${style.yellow(cp.path.join(" → "))}`);
}

function printTopo(tasks: TasksData["tasks"]) {
  const order = topologicalSort(tasks);
  console.log(`\n${style.bold("Topological Execution Order")}`);
  order.forEach((tid, i) => {
    const t = tasks.find((x) => x.id === tid)!;
    const depText = t.dependencies.length ? t.dependencies.join(", ") : style.dim("—");
    console.log(`  ${String(i + 1).padStart(2)}. ${style.cyan(tid)} (${t.estimatedHours}h)  deps: ${depText}`);
  });
}

function printWaves(tasks: TasksData["tasks"]) {
  const waves = computeWaves(tasks);
  console.log(`\n${style.bold("Parallel Execution Waves")}`);
  waves.forEach((wave, i) => {
    const totalH = wave.reduce((s, tid) => s + tasks.find((t) => t.id === tid)!.estimatedHours, 0);
    console.log(`  Wave ${i + 1}: [${wave.join(", ")}]  (${wave.length} tasks, ~${totalH}h)`);
  });
}

function printTiers(tasks: Task[]) {
  console.log(`\n${style.bold("Model-Tier Breakdown")}`);
  const counts: Record<Tier, string[]> = { min: [], mid: [], smart: [] };
  for (const t of tasks) counts[tierForTask(t)].push(t.id);
  (["smart", "mid", "min"] as Tier[]).forEach((name) => {
    const spec = TIERS[name];
    const ids = counts[name];
    const list = ids.length ? ids.join(", ") : "(none)";
    console.log(`  ${style.cyan(name.padEnd(6))} (${spec.model}, thinking=${spec.thinking}): ${ids.length} task(s)`);
    console.log(`    ${list}`);
  });
}

function printJson(data: TasksData) {
  const order = topologicalSort(data.tasks);
  const waves = computeWaves(data.tasks);
  const cp = criticalPath(data.tasks);
  const stats = computeStats(data);
  console.log(JSON.stringify({ valid: true, stats, topologicalOrder: order, waves, criticalPath: cp }, null, 2));
}

// ── Run ───────────────────────────────────────────────────────────────

export async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv, FLAGS);

  if (flags["--help"]) { printHelp(HELP); return; }

  const tasksPath = positional[0];

  let data: TasksData;
  try {
    data = await loadTasks(tasksPath);
  } catch (e) {
    die(e instanceof TaskError ? e.message : String(e));
  }

  // Normalize optional fields with defaults
  normalizeData(data);

  const { tasks, phases, metadata } = data;
  const agents = data.agents ?? {};

  const checks: [string, () => string[]][] = [
    ["Top-level structure valid", () => validateTopLevel(data)],
    ["All tasks have required fields", () => validateRequiredFields(tasks)],
    ["All task IDs are unique", () => validateUniqueIds(tasks)],
    ["All tasks reference valid phases", () => validatePhases(tasks, phases)],
    ["All dependencies reference valid task IDs", () => validateDependencies(tasks)],
    ["No circular dependencies (DAG is valid)", () => detectCycles(tasks).map((c) => `Circular dependency: ${c}`)],
    ["Phase task lists match actual assignments", () => validatePhaseLists(tasks, phases)],
    ["All agent assignments are consistent", () => validateAgents(tasks, agents)],
    ["All priorities are valid", () => validatePriorities(tasks)],
    [`Metadata consistent (${metadata.totalTasks ?? "?"} tasks, ${metadata.totalEstimatedHours ?? "?"}h)`, () => validateMetadata(tasks, metadata)],
  ];

  const strictTiers = !!flags["--strict-tiers"];
  const tierWarnings = validateTiers(tasks);

  const quiet = !!flags["--quiet"];
  let allPassed = true;
  const allErrors: string[] = [];

  for (const [label, check] of checks) {
    const errs = check();
    if (errs.length > 0) {
      allPassed = false;
      for (const e of errs) {
        allErrors.push(e);
        console.error(`  ${style.red("✗")} ${e}`);
      }
    } else if (!quiet) {
      ok(label);
    }
  }

  if (!allPassed) {
    if (flags["--json"]) {
      console.log(JSON.stringify({ valid: false, errors: allErrors, tierWarnings }, null, 2));
    }
    process.exit(1);
  }

  if (flags["--json"]) printJson(data);
  else {
    if (flags["--summary"]) printSummary(data);
    if (flags["--topo"]) printTopo(tasks);
    if (flags["--waves"]) printWaves(tasks);
    if (flags["--tiers"]) printTiers(tasks);
  }

  // Surface tier warnings (always, even when other checks pass). In --strict-tiers
  // they become errors that flip the exit code.
  if (tierWarnings.length > 0) {
    for (const w of tierWarnings) {
      if (strictTiers) {
        console.error(`  ${style.red("✗")} ${w}`);
        allErrors.push(w);
      } else {
        console.log(`  ${style.yellow("⚠")} ${w}`);
      }
    }
    if (strictTiers) {
      if (flags["--json"]) {
        console.log(JSON.stringify({ valid: false, errors: allErrors, tierWarnings }, null, 2));
      }
      process.exit(1);
    }
  }

  if (!quiet) console.log(`\n${style.green("✓ ALL VALIDATIONS PASSED")}`);
}
