/**
 * Spawn tmux sub-agents for tasks.json tasks, respecting the DAG.
 *
 * Usage:
 *   task-pipeline spawn [task-ids...] [options]
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadTasks,
  findTasksJson,
  computeWaves,
  readPrompt,
  readDoneMarkers,
  generateRunnerScript,
} from "../lib/tasks-lib.ts";
import {
  parseArgs,
  printHelp,
  style,
  type FlagSpec,
  type HelpSpec,
} from "../lib/cli-utils.ts";

// ── Specs ────────────────────────────────────────────────────────────

const FLAGS: FlagSpec[] = [
  { name: "--all", type: "boolean", desc: "Spawn all waves sequentially" },
  { name: "--dry-run", type: "boolean", desc: "Show what would spawn, don't actually spawn" },
  { name: "--session-prefix", type: "string", desc: "Custom tmux session prefix", default: "task" },
  { name: "--help", short: "-h", type: "boolean", desc: "Show this help" },
];

export const HELP: HelpSpec = {
  name: "task-pipeline spawn",
  description: "Spawn tmux sub-agents for task execution",
  usage: "task-pipeline spawn [task-ids...] [options]",
  flags: FLAGS,
};

// ── Tmux Helpers ─────────────────────────────────────────────────────

function tmuxSpawn(sessionName: string, scriptPath: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`  · Would spawn tmux session "${sessionName}" (${scriptPath})`);
    return;
  }
  Bun.spawnSync(["tmux", "kill-session", "-t", sessionName], { stdio: ["ignore", "ignore", "ignore"] });
  const result = Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName, "bash", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    console.error(`  ${style.red("✗")} Failed to spawn "${sessionName}": ${result.stderr.toString()}`);
  } else {
    console.log(`  ${style.green("→")} Spawned ${sessionName}`);
  }
}

function tmuxActive(prefix: string): number {
  const result = Bun.spawnSync(["tmux", "ls"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.exitCode !== 0) return 0;
  return result.stdout.toString().split("\n").filter((l) => l.startsWith(`${prefix}-`)).length;
}

// ── Core Logic ───────────────────────────────────────────────────────

function spawnTask(
  tid: string,
  projectDir: string,
  tasksDir: string,
  sessionPrefix: string,
  dryRun: boolean,
): void {
  if (existsSync(join(tasksDir, `${tid}.done`))) {
    console.log(`  ${style.dim(`SKIP ${tid}: already done`)}`);
    return;
  }
  const prompt = readPrompt(tasksDir, tid);
  if (!prompt) {
    console.log(`  ${style.yellow(`SKIP ${tid}: no prompt file`)}`);
    return;
  }
  const script = generateRunnerScript(tid, projectDir, tasksDir, prompt);
  tmuxSpawn(`${sessionPrefix}-${tid}`, script, dryRun);
}

async function autoGeneratePrompts(tasksPath: string, tasksDir: string): Promise<void> {
  const count = readdirSync(tasksDir).filter((e) => e.endsWith("-prompt")).length;
  if (count > 0) return;
  console.log("⚡ No prompt files found — generating from tasks.json...");
  const { run: gen } = await import("./prompts.ts");
  await gen([tasksPath, "--no-validate"]);
  console.log("");
}

// ── Modes ────────────────────────────────────────────────────────────

async function spawnSpecific(
  ids: string[],
  projectDir: string,
  tasksDir: string,
  prefix: string,
  dryRun: boolean,
) {
  for (const tid of ids) spawnTask(tid, projectDir, tasksDir, prefix, dryRun);
  if (!dryRun) {
    const n = tmuxActive(prefix);
    console.log(`\nActive: ${n} session(s)`);
  }
}

async function spawnNextWave(
  tasksPath: string,
  projectDir: string,
  tasksDir: string,
  prefix: string,
  dryRun: boolean,
) {
  console.log("⚡ Scanning for the next ready wave...");
  const data = await loadTasks(tasksPath);
  const done = readDoneMarkers(tasksDir);
  const ready = data.tasks.filter((t) => {
    if (done.has(t.id)) return false;
    return (t.dependencies ?? []).every((d) => done.has(d));
  });
  if (ready.length === 0) {
    console.log(style.yellow("No tasks ready (all done or blocked)"));
    return;
  }
  console.log(`Ready: ${ready.map((t) => t.id).join(", ")}\n`);
  for (const t of ready) spawnTask(t.id, projectDir, tasksDir, prefix, dryRun);
  if (!dryRun) {
    console.log(`\nActive: ${tmuxActive(prefix)} session(s)`);
  }
}

async function spawnAllWaves(
  tasksPath: string,
  projectDir: string,
  tasksDir: string,
  prefix: string,
  dryRun: boolean,
) {
  console.log(style.bold("🚀 Spawning all remaining waves..."));
  const data = await loadTasks(tasksPath);
  const waves = computeWaves(data.tasks);

  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    const pending = wave.filter((tid) => !existsSync(join(tasksDir, `${tid}.done`)));
    if (pending.length === 0) {
      console.log(`  ${style.dim(`Wave ${i + 1}: all done, skipping`)}`);
      continue;
    }
    console.log(`\n${style.bold(`Wave ${i + 1}: ${pending.join(", ")}`)}`);
    for (const tid of pending) {
      spawnTask(tid, projectDir, tasksDir, prefix, dryRun);
    }
    if (dryRun) continue;

    // Wait for all tasks in this wave to complete
    for (const tid of pending) {
      while (!existsSync(join(tasksDir, `${tid}.done`))) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log(`  ${style.green("✓")} ${tid} complete`);
      Bun.spawnSync(["tmux", "kill-session", "-t", `${prefix}-${tid}`], { stdio: ["ignore", "ignore", "ignore"] });
    }
  }

  if (dryRun) {
    console.log(`\n${style.dim("Dry run: no sessions spawned")}`);
  } else {
    const total = data.tasks.length;
    const done = readDoneMarkers(tasksDir).size;
    console.log(`\n${style.green("🎉 All waves complete")}`);
    console.log(`   Done: ${done}/${total} tasks`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────

export async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv, FLAGS);
  if (flags["--help"]) { printHelp(HELP); return; }

  const projectDir = process.cwd();
  const tasksDir = join(projectDir, "tasks");
  const sessionPrefix = String(flags["--session-prefix"] ?? "task");
  const dryRun = !!flags["--dry-run"];
  const allMode = !!flags["--all"];

  // Ensure tasks directory
  mkdirSync(tasksDir, { recursive: true });

  // Resolve tasks.json
  const tasksPath = findTasksJson();

  // Auto-generate prompts if needed
  await autoGeneratePrompts(tasksPath, tasksDir);

  // Dispatch mode
  if (positional.length > 0) {
    await spawnSpecific(positional, projectDir, tasksDir, sessionPrefix, dryRun);
  } else if (allMode) {
    await spawnAllWaves(tasksPath, projectDir, tasksDir, sessionPrefix, dryRun);
  } else {
    await spawnNextWave(tasksPath, projectDir, tasksDir, sessionPrefix, dryRun);
  }
}
