/**
 * Integration tests for the prompts command.
 * Tests prompt generation structure, dry-run mode, and edge cases.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { run as promptsRun } from "../commands/prompts.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Helper to run prompts and capture output
async function runPrompts(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    await promptsRun(args);
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

describe("prompts command - dry run", () => {
  test("--dry-run shows what would be generated", async () => {
    // Pass the fixtures directory (prompts expects a directory path)
    const result = await runPrompts([FIXTURES_DIR, "--dry-run", "--no-validate"]);
    // This will look for tasks.json in FIXTURES_DIR and parent dirs
    // Since there's no tasks.json in the fixtures dir, it should find one in parents
    // But we're testing the dry-run flag behavior
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would write");
    expect(result.stdout).toContain("Would generate");
  });

  test("--dry-run shows byte count for each prompt", async () => {
    const result = await runPrompts([FIXTURES_DIR, "--dry-run", "--no-validate"]);
    expect(result.exitCode).toBe(0);
    // Should show byte counts like "(123 bytes)"
    expect(result.stdout).toMatch(/\(\d+ bytes\)/);
  });
});

// ── Validation ─────────────────────────────────────────────────────

describe("prompts command - validation", () => {
  test("--no-validate skips validation", async () => {
    const result = await runPrompts([FIXTURES_DIR, "--no-validate", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("validated");
  });

  test("validates by default", async () => {
    const result = await runPrompts([FIXTURES_DIR, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("validated");
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("prompts command - edge cases", () => {
  test("--help shows usage information", async () => {
    const result = await runPrompts(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-pipeline prompts");
    expect(result.stdout).toContain("Options:");
  });

  test("--help shows available flags", async () => {
    const result = await runPrompts(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--no-validate");
    expect(result.stdout).toContain("--prd");
  });

  test("unknown flag causes error", async () => {
    const result = await runPrompts([FIXTURES_DIR, "--invalid"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown flag");
  });
});
