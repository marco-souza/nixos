/**
 * Integration tests for the validate command.
 * Tests valid/invalid JSON, circular deps, missing fields, edge cases.
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run as validateRun } from "../commands/validate.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const SIMPLE_FIXTURE = join(FIXTURES_DIR, "tasks-simple.json");
const CIRCULAR_FIXTURE = join(FIXTURES_DIR, "tasks-circular.json");
const MISSING_DEPS_FIXTURE = join(FIXTURES_DIR, "tasks-missing-deps.json");
const EMPTY_FIXTURE = join(FIXTURES_DIR, "tasks-empty.json");

// Helper to run validate and capture output
async function runValidate(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    await validateRun(args);
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

// ── Valid Tasks ────────────────────────────────────────────────────

describe("validate command - valid input", () => {
  test("validates a correct tasks.json", async () => {
    const result = await runValidate([SIMPLE_FIXTURE]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ALL VALIDATIONS PASSED");
  });

  test("--quiet flag suppresses output", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--quiet"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("✓");
  });

  test("--json flag outputs JSON", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--json"]);
    expect(result.exitCode).toBe(0);
    // JSON output should contain valid JSON
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      expect(parsed.valid).toBe(true);
    }
  });

  test("--topo flag shows topological order", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--topo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Topological Execution Order");
  });

  test("--waves flag shows execution waves", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--waves"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Parallel Execution Waves");
  });

  test("--summary flag shows phase and agent breakdown", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--summary"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Phase Breakdown");
    expect(result.stdout).toContain("Agent Breakdown");
  });
});

// ── Invalid Input ──────────────────────────────────────────────────

describe("validate command - invalid input", () => {
  test("exits with error for circular dependencies", async () => {
    const result = await runValidate([CIRCULAR_FIXTURE]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Circular dependency");
  });

  test("exits with error for missing dependency references", async () => {
    const result = await runValidate([MISSING_DEPS_FIXTURE]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-existent task");
  });

  test("exits with error for non-existent file", async () => {
    const result = await runValidate(["/nonexistent/tasks.json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("exits with error for invalid JSON", async () => {
    const tmpDir = join(import.meta.dir, "tmp-validate-invalid");
    mkdirSync(tmpDir, { recursive: true });
    const badFile = join(tmpDir, "bad.json");
    writeFileSync(badFile, "{ broken json }}}", "utf-8");
    try {
      const result = await runValidate([badFile]);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("validate command - edge cases", () => {
  test("validates empty tasks array", async () => {
    const result = await runValidate([EMPTY_FIXTURE]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ALL VALIDATIONS PASSED");
  });

  test("--help shows usage information", async () => {
    const result = await runValidate(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-pipeline validate");
    expect(result.stdout).toContain("Options:");
  });

  test("unknown flag causes error", async () => {
    const result = await runValidate([SIMPLE_FIXTURE, "--unknown-flag"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown flag");
  });
});
