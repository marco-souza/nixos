/**
 * Unit tests for cli-utils.ts
 * Tests argument parsing, formatting functions, ANSI styling.
 */

import { describe, test, expect, spyOn } from "bun:test";
import {
  parseArgs,
  style,
  ok,
  warn,
  type FlagSpec,
} from "../lib/cli-utils.ts";

// ── ANSI Styling ───────────────────────────────────────────────────

describe("style", () => {
  test("green wraps text in green ANSI codes", () => {
    const result = style.green("hello");
    expect(result).toBe("\x1b[32mhello\x1b[0m");
  });

  test("red wraps text in red ANSI codes", () => {
    const result = style.red("error");
    expect(result).toBe("\x1b[31merror\x1b[0m");
  });

  test("yellow wraps text in yellow ANSI codes", () => {
    const result = style.yellow("warn");
    expect(result).toBe("\x1b[33mwarn\x1b[0m");
  });

  test("blue wraps text in blue ANSI codes", () => {
    const result = style.blue("info");
    expect(result).toBe("\x1b[34minfo\x1b[0m");
  });

  test("bold wraps text in bold ANSI codes", () => {
    const result = style.bold("title");
    expect(result).toBe("\x1b[1mtitle\x1b[0m");
  });

  test("dim wraps text in dim ANSI codes", () => {
    const result = style.dim("muted");
    expect(result).toBe("\x1b[2mmuted\x1b[0m");
  });

  test("cyan wraps text in cyan ANSI codes", () => {
    const result = style.cyan("link");
    expect(result).toBe("\x1b[36mlink\x1b[0m");
  });

  test("magenta wraps text in magenta ANSI codes", () => {
    const result = style.magenta("highlight");
    expect(result).toBe("\x1b[35mhighlight\x1b[0m");
  });
});

// ── parseArgs ──────────────────────────────────────────────────────

describe("parseArgs", () => {
  const specs: FlagSpec[] = [
    { name: "--dry-run", type: "boolean", desc: "Dry run" },
    { name: "--name", short: "-n", type: "string", desc: "Name" },
    { name: "--output", type: "string", desc: "Output path", default: "/default" },
    { name: "--verbose", type: "boolean", desc: "Verbose" },
  ];

  test("parses empty args", () => {
    const result = parseArgs([], specs);
    expect(result.positional).toEqual([]);
    expect(result.flags["--output"]).toBe("/default");
    expect(result.rest).toEqual([]);
  });

  test("parses positional arguments", () => {
    const result = parseArgs(["file1", "file2"], specs);
    expect(result.positional).toEqual(["file1", "file2"]);
  });

  test("parses boolean flags", () => {
    const result = parseArgs(["--dry-run"], specs);
    expect(result.flags["--dry-run"]).toBe(true);
  });

  test("parses string flags with space", () => {
    const result = parseArgs(["--name", "Alice"], specs);
    expect(result.flags["--name"]).toBe("Alice");
  });

  test("parses string flags with =", () => {
    const result = parseArgs(["--name=Bob"], specs);
    expect(result.flags["--name"]).toBe("Bob");
  });

  test("parses short flags", () => {
    const result = parseArgs(["-n", "Charlie"], specs);
    expect(result.flags["--name"]).toBe("Charlie");
  });

  test("applies default values", () => {
    const result = parseArgs([], specs);
    expect(result.flags["--output"]).toBe("/default");
  });

  test("overrides default with provided value", () => {
    const result = parseArgs(["--output", "/custom"], specs);
    expect(result.flags["--output"]).toBe("/custom");
  });

  test("handles -- separator for rest args", () => {
    const result = parseArgs(["--dry-run", "--", "extra1", "extra2"], specs);
    expect(result.flags["--dry-run"]).toBe(true);
    expect(result.rest).toEqual(["extra1", "extra2"]);
  });

  test("parses mixed positional and flags", () => {
    const result = parseArgs(["file.txt", "--dry-run", "-n", "test"], specs);
    expect(result.positional).toEqual(["file.txt"]);
    expect(result.flags["--dry-run"]).toBe(true);
    expect(result.flags["--name"]).toBe("test");
  });

  test("allows -h and --help implicitly", () => {
    const result = parseArgs(["--help"], specs);
    expect(result.flags["--help"]).toBe(true);
  });

  test("allows -h implicitly", () => {
    const result = parseArgs(["-h"], specs);
    expect(result.flags["--help"]).toBe(true);
  });
});

// ── Output Helpers ─────────────────────────────────────────────────

describe("ok", () => {
  test("logs success message with checkmark", () => {
    const spy = spyOn(console, "log");
    ok("Operation succeeded");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("✓"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Operation succeeded"));
    spy.mockRestore();
  });
});

describe("warn", () => {
  test("logs warning message with warning symbol", () => {
    const spy = spyOn(console, "log");
    warn("Be careful");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("⚠"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Be careful"));
    spy.mockRestore();
  });
});
