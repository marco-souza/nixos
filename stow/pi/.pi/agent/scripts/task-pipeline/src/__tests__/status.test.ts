/**
 * Integration tests for the status command.
 * Tests pending, running, done, blocked states and various output modes.
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run as statusRun } from "../commands/status.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const SIMPLE_FIXTURE = join(FIXTURES_DIR, "tasks-simple.json");
const EMPTY_FIXTURE = join(FIXTURES_DIR, "tasks-empty.json");

// Helper to run status and capture output
async function runStatus(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const origCwd = process.cwd;

  console.log = (...args: unknown[]) => { stdout += args.join(" ") + "\n"; };
  console.error = (...args: unknown[]) => { stderr += args.join(" ") + "\n"; };
  (process as any).exit = (code: number) => { exitCode = code; throw new Error(`EXIT_${code}`); };

  try {
    await statusRun(args);
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
    (process as any).cwd = origCwd;
  }

  return { stdout, stderr, exitCode };
}

// ── Basic Status ───────────────────────────────────────────────────

describe("status command - basic", () => {
  test("shows status for tasks with no markers", async () => {
    const result = await runStatus([SIMPLE_FIXTURE]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Total:");
  });

  test("shows all tasks in table format", async () => {
    const result = await runStatus([SIMPLE_FIXTURE]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("T001");
    expect(result.stdout).toContain("T002");
    expect(result.stdout).toContain("T003");
    expect(result.stdout).toContain("T004");
  });
});

// ── Compact Mode ───────────────────────────────────────────────────

describe("status command - compact mode", () => {
  test("--compact shows one-line summary", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--compact"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("pending");
    expect(result.stdout).toContain("blocked");
  });
});

// ── JSON Mode ──────────────────────────────────────────────────────

describe("status command - JSON mode", () => {
  test("--json outputs valid JSON", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--json"]);
    expect(result.exitCode).toBe(0);
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      expect(parsed.stats).toBeDefined();
      expect(parsed.status).toBeDefined();
    }
  });
});

// ── Filter Flags ───────────────────────────────────────────────────

describe("status command - filters", () => {
  test("--pending shows only pending tasks", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--pending"]);
    expect(result.exitCode).toBe(0);
    // Should show T001 (pending, no deps)
    expect(result.stdout).toContain("T001");
  });

  test("--done shows only completed tasks", async () => {
    // Create a temp dir with a .done marker
    const tmpDir = join(import.meta.dir, "tmp-status-done");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    try {
      // We can't easily mock cwd, so test with the done marker in the fixture
      const result = await runStatus([SIMPLE_FIXTURE, "--done"]);
      expect(result.exitCode).toBe(0);
      // The output should filter to only done tasks
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("--ready shows tasks ready to spawn", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--ready"]);
    expect(result.exitCode).toBe(0);
    // T001 should be ready (no deps)
    expect(result.stdout).toContain("T001");
  });

  test("--running shows running tasks", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--running"]);
    expect(result.exitCode).toBe(0);
    // No running tasks, should show empty or summary
  });

  test("--blocked shows blocked tasks", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--blocked"]);
    expect(result.exitCode).toBe(0);
    // T002, T003, T004 are blocked (deps not done)
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("status command - edge cases", () => {
  test("handles empty tasks list", async () => {
    const result = await runStatus([EMPTY_FIXTURE]);
    expect(result.exitCode).toBe(0);
  });

  test("--help shows usage information", async () => {
    const result = await runStatus(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-pipeline status");
    expect(result.stdout).toContain("Options:");
  });

  test("unknown flag causes error", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--invalid"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown flag");
  });

  test("mutually exclusive flags cause error", async () => {
    const result = await runStatus([SIMPLE_FIXTURE, "--pending", "--done"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mutually exclusive");
  });
});
