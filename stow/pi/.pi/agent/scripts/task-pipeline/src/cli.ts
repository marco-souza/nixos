#!/usr/bin/env bun
/**
 * task-pipeline -- CLI for pi agent task orchestration.
 *
 * Entry point for the package. Dispatches to subcommands.
 *
 * Usage:
 *   bun cli.ts <command> [options]
 *   bun cli.ts validate --topo
 *   bun cli.ts status --compact
 *   bun cli.ts prompts --dry-run
 *   bun cli.ts spawn --all
 */

import { style } from "./lib/cli-utils.ts";

// -- Command Registry ----------------------------------------------------

interface Command {
  name: string;
  description: string;
  run: (argv: string[]) => Promise<void>;
}

const COMMANDS: Command[] = [
  {
    name: "validate",
    description: "Validate tasks.json schema and DAG",
    run: (argv) => import("./commands/validate.ts").then((m) => m.run(argv)),
  },
  {
    name: "status",
    description: "Show task execution status from tasks/ directory markers",
    run: (argv) => import("./commands/status.ts").then((m) => m.run(argv)),
  },
  {
    name: "prompts",
    description: "Generate self-contained prompt files from tasks.json",
    run: (argv) => import("./commands/prompts.ts").then((m) => m.run(argv)),
  },
  {
    name: "spawn",
    description: "Spawn tmux sub-agents for task execution",
    run: (argv) => import("./commands/spawn.ts").then((m) => m.run(argv)),
  },
];

const VERSION = "1.0.0";

// -- Help -----------------------------------------------------------------

function printGlobalHelp(): void {
  console.log("");
  console.log(style.bold("task-pipeline v" + VERSION));
  console.log("  DAG task execution tools for the pi agent");
  console.log("");
  console.log("  " + style.dim("Usage:") + " task-pipeline <command> [options]");
  console.log("");
  console.log("  " + style.dim("Commands:"));
  const max = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const cmd of COMMANDS) {
    const padded = cmd.name.padEnd(max + 2);
    console.log("    " + style.cyan(padded) + cmd.description);
  }
  console.log("");
  console.log("  " + style.dim("Options:"));
  console.log("    -h, --help     Show this help");
  console.log("    --version      Show version");
  console.log("");
  console.log("  " + style.dim("Run 'task-pipeline <command> --help' for command-specific options"));
  console.log("");
}

// -- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printGlobalHelp();
    return;
  }
  if (args[0] === "--version") {
    console.log(VERSION);
    return;
  }

  const commandName = args[0];
  const commandArgs = args.slice(1);

  const cmd = COMMANDS.find((c) => c.name === commandName);
  if (!cmd) {
    console.error("");
    console.error("  " + style.red("X") + " Unknown command: " + commandName);
    console.error("  Available: " + COMMANDS.map((c) => c.name).join(", "));
    console.error("");
    process.exit(1);
  }

  await cmd.run(commandArgs);
}

main().catch((err) => {
  console.error("");
  console.error("  " + style.red("X") + " Unexpected error: " + (err.message ?? err));
  console.error("");
  process.exit(1);
});
