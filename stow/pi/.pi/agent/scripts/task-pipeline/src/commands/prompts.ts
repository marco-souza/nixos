/**
 * Generate self-contained prompt files from tasks.json.
 *
 * Usage:
 *   task-pipeline prompts [path] [options]
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadTasks,
  findTasksJson,
  topologicalSort,
  TaskError,
  type Task,
  type TasksData,
} from "../lib/tasks-lib.ts";
import {
  parseArgs,
  printHelp,
  style,
  ok,
  die,
  warn,
  type FlagSpec,
  type HelpSpec,
} from "../lib/cli-utils.ts";

// ── Specs ────────────────────────────────────────────────────────────

const FLAGS: FlagSpec[] = [
  { name: "--dry-run", type: "boolean", desc: "Preview without writing files" },
  { name: "--no-validate", type: "boolean", desc: "Skip validation step" },
  { name: "--prd", type: "string", desc: "Path to PRD.md for extra context" },
  { name: "--help", short: "-h", type: "boolean", desc: "Show this help" },
];

export const HELP: HelpSpec = {
  name: "task-pipeline prompts",
  description: "Generate self-contained prompt files from tasks.json",
  usage: "task-pipeline prompts [path] [options]",
  flags: FLAGS,
};

// ── Validation ───────────────────────────────────────────────────────

async function validateFirst(tasksPath: string) {
  const validator = join(import.meta.dir!, "validate.ts");
  if (!existsSync(validator)) {
    // Fallback to direct validation import
    const { run: validate } = await import("./validate.ts");
    try {
      await validate([tasksPath, "--quiet"]);
      ok("tasks.json validated");
    } catch {
      await validate([tasksPath]);
      process.exit(1);
    }
    return;
  }
  try {
    const result = await Bun.spawn(["bun", validator, tasksPath, "--quiet"], { stdout: "pipe", stderr: "pipe" }).exited;
    if (result === 0) {
      ok("tasks.json validated");
    } else {
      await Bun.spawn(["bun", validator, tasksPath], { stdio: ["inherit", "inherit", "inherit"] }).exited;
      process.exit(1);
    }
  } catch {
    die("Failed to run validation");
  }
}

// ── PRD Context ──────────────────────────────────────────────────────

async function loadPrdContext(prdPath: string): Promise<string | null> {
  if (!existsSync(prdPath)) return null;
  try {
    const text = await Bun.file(prdPath).text();
    const sections: string[] = [];
    let current: string | null = null;
    let lines: string[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) {
        if (current && lines.length > 0 && isRelevantSection(current)) {
          sections.push(`## ${current}\n${lines.join("\n")}`);
        }
        current = line.slice(3).trim();
        lines = [];
      } else if (current) {
        lines.push(line);
      }
    }
    if (current && lines.length > 0 && isRelevantSection(current)) {
      sections.push(`## ${current}\n${lines.join("\n")}`);
    }
    return sections.length > 0 ? sections.join("\n\n") : null;
  } catch {
    return null;
  }
}

function isRelevantSection(name: string): boolean {
  return name === "Executive Summary" || name.startsWith("Decisions");
}

// ── Prompt Generation ────────────────────────────────────────────────

function generatePrompt(task: Task, allTasks: Task[], prdContext: string | null, projectDir: string): string {
  const depContext = task.dependencies.length > 0
    ? "\nDEPENDENCIES (completed before this task):\n" +
      task.dependencies.map((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep ? `- ${depId}: ${dep.title} — ${dep.description.slice(0, 200)}` : `- ${depId}: (not found)`;
      }).join("\n")
    : "";

  const expertContext = task.moeExperts.length > 0
    ? "\nEXPERT PERSPECTIVES TO CONSIDER:\n" + task.moeExperts.map((e) => `- ${e}`).join("\n")
    : "";

  const acLines = task.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n");
  const prdBlock = prdContext ? `\nPROJECT CONTEXT (from PRD):\n${prdContext}` : "";

  return [
    `WORKDIR: ${projectDir}`,
    `TASK_ID: ${task.id}`,
    `TASK_TITLE: ${task.title}`,
    `AGENT: ${task.agent}`,
    `PHASE: ${task.phase}`,
    `PRIORITY: ${task.priority}`,
    `ESTIMATED: ${task.estimatedHours}h`,
    depContext,
    "DESCRIPTION:",
    task.description,
    "",
    "WHAT YOU MUST DO:",
    "1. Discover relevant source files (use ls/find to locate, read to examine)",
    "2. Implement the changes using edit/write/bash tools",
    "3. Verify each acceptance criterion listed below",
    "4. Do NOT modify files unrelated to this task",
    "5. Do NOT skip acceptance criteria — verify each one",
    "",
    "ACCEPTANCE CRITERIA:",
    acLines,
    expertContext,
    prdBlock,
    "",
    `AFTER COMPLETION:`,
    `Write "${task.id}_DONE" to tasks/${task.id}.done`,
  ].join("\n");
}

// ── Run ──────────────────────────────────────────────────────────────

export async function run(argv: string[]) {
  const { positional, flags } = parseArgs(argv, FLAGS);
  if (flags["--help"]) { printHelp(HELP); return; }

  const tasksPath = positional[0] ? findTasksJson(positional[0]) : findTasksJson();

  if (!flags["--no-validate"]) {
    await validateFirst(tasksPath);
  }

  let data: TasksData;
  try {
    data = await loadTasks(tasksPath);
  } catch (e) {
    die(e instanceof TaskError ? e.message : String(e));
  }

  const { tasks, metadata } = data;
  const projectDir = process.cwd();

  // ── PRD context ──
  let prdContext: string | null = null;
  const prdFlag = flags["--prd"];

  if (prdFlag) {
    const prdPath = resolve(String(prdFlag));
    prdContext = await loadPrdContext(prdPath);
    if (prdContext) ok(`Loaded PRD context from ${prdPath}`);
    else warn(`No relevant sections found in ${prdPath}`);
  } else {
    const prdName = metadata.prd as string | undefined;
    if (prdName) {
      for (const candidate of [
        join(process.cwd(), "docs", prdName),
        join(process.cwd(), prdName),
        resolve(tasksPath, "..", prdName),
      ]) {
        prdContext = await loadPrdContext(candidate);
        if (prdContext) { ok(`Loaded PRD context from ${candidate}`); break; }
      }
    }
  }

  // ── Generate ──
  const order = topologicalSort(tasks);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const ordered = order.map((id) => taskMap.get(id)!);

  const tasksDir = join(projectDir, "tasks");
  const dryRun = !!flags["--dry-run"];
  if (!dryRun) mkdirSync(tasksDir, { recursive: true });

  let count = 0;
  for (const task of ordered) {
    const prompt = generatePrompt(task, tasks, prdContext, projectDir);
    const promptPath = join(tasksDir, `${task.id}-prompt`);
    if (dryRun) {
      console.log(`  · ${task.id}: would write ${promptPath} (${prompt.length} bytes)`);
    } else {
      await Bun.write(promptPath, prompt);
      console.log(`  ${style.green("✓")} ${task.id}: ${task.title} (${prompt.length} bytes)`);
    }
    count++;
  }

  console.log(`\n${dryRun ? `Would generate ${count} prompt files` : `Generated ${count} prompt files`} in ${tasksDir}/`);
}
