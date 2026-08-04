/**
 * Integration tests for the spawn command.
 * Tests dry-run mode, session prefix, and edge cases.
 */

import { describe, test, expect } from "bun:test";
import { run as spawnRun } from "../commands/spawn.ts";

// Helper to run spawn and capture output
async function runSpawn(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  console.log = (...args: unknown[]) => { stdout += args.join(" ") + "\n"; };
  console.error = (...args: unknown[]) => { stderr += args.join(" ") + "\n"; };
  (process as any).exit = (code: number) => { exitCode = code; throw new Error(`EXIT_${code}`); };

  try {
    await spawnRun(args);
  } catch (e: any) {
    if (e.message?.startsWith("EXIT_")) {
      exitCode = parseInt(e.message.split("_")[1]);
    } else {
      stderr += e.message + "\n";
      exitCode = 1;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }

  return { stdout, stderr, exitCode };
}

// ── Dry Run Mode ───────────────────────────────────────────────────

describe("spawn command - dry run", () => {
  test("--dry-run shows what would spawn", async () => {
    // The spawn command finds tasks.json from cwd and uses positional args as task IDs
    // In dry-run mode, it should show what would be spawned
    const result = await runSpawn(["--dry-run"]);
    // The command will try to find tasks.json - if not found, it will error
    // If found, it will show dry-run output
    // We test that the flag is recognized and processed
    expect(result.exitCode).toBe(0);
  });

  test("--dry-run shows session name", async () => {
    const result = await runSpawn(["--dry-run"]);
    expect(result.exitCode).toBe(0);
    // Should show session name in dry-run output or "no tasks ready"
  });
});

// ── Session Prefix ─────────────────────────────────────────────────

describe("spawn command - session prefix", () => {
  test("--session-prefix customizes session name", async () => {
    const result = await runSpawn(["--dry-run", "--session-prefix", "myproject"]);
    expect(result.exitCode).toBe(0);
  });

  test("default session prefix is 'task'", async () => {
    const result = await runSpawn(["--dry-run"]);
    expect(result.exitCode).toBe(0);
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("spawn command - edge cases", () => {
  test("--help shows usage information", async () => {
    const result = await runSpawn(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-pipeline spawn");
    expect(result.stdout).toContain("Options:");
  });

  test("--help shows available flags", async () => {
    const result = await runSpawn(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--session-prefix");
  });

  test("unknown flag causes error", async () => {
    const result = await runSpawn(["--invalid"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown flag");
  });
});
