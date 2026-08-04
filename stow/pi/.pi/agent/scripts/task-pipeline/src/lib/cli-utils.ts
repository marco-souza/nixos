/**
 * Shared CLI utilities — argument parsing, ANSI styling, table formatting, help generation.
 * Separated from domain logic (tasks-lib.ts) so commands stay clean.
 */

// ── Exits ────────────────────────────────────────────────────────────

/** Print an error message and exit with the given code (default 1). */
export function die(message: string, code = 1): never {
  console.error(`\n  ${style.red("✗")} ${message}`);
  process.exit(code);
}

/** Print a success message. */
export function ok(message: string): void {
  console.log(`  ${style.green("✓")} ${message}`);
}

/** Print a warning message. */
export function warn(message: string): void {
  console.log(`  ${style.yellow("⚠")} ${message}`);
}

// ── ANSI Styling ─────────────────────────────────────────────────────

export const style = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ── Argument Parsing ─────────────────────────────────────────────────

export interface ParsedArgs {
  /** Positional (non-flag) arguments. */
  positional: string[];
  /** Parsed flags — value is `true` for booleans, `string` for string flags. */
  flags: Record<string, string | boolean>;
  /** Raw remaining args after `--`. */
  rest: string[];
}

export interface FlagSpec {
  /** Long flag name including `--` prefix, e.g. `"--dry-run"`. */
  name: string;
  /** Short alias, e.g. `"-d"`, or empty string if none. */
  short?: string;
  /** Type of value this flag expects. */
  type: "boolean" | "string";
  /** Description for help text. */
  desc: string;
  /** Default value when not provided. */
  default?: string | boolean;
}

/**
 * Parse CLI arguments against a spec.
 *
 * Supports both `--flag=value` and `--flag value` for string flags.
 * Unrecognised flags cause an error.
 */
export function parseArgs(
  argv: string[],
  specs: FlagSpec[],
): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  // Build lookup maps
  const specMap = new Map<string, FlagSpec>();
  const shortMap = new Map<string, FlagSpec>();
  for (const s of specs) {
    specMap.set(s.name, s);
    if (s.short) shortMap.set(s.short, s);
    // Set defaults
    if (s.default !== undefined) flags[s.name] = s.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // `--` signals end of flags
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    // Positional
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    // Determine which spec this matches
    let name: string;
    let spec: FlagSpec | undefined;

    if (arg.startsWith("--")) {
      // `--flag` or `--flag=value`
      const eqIdx = arg.indexOf("=");
      name = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
      spec = specMap.get(name);
    } else {
      // `-f` short form
      spec = shortMap.get(arg);
      name = spec?.name ?? arg;
    }

    if (!spec) {
      // Allow `-h` / `--help` implicitly
      if (arg === "-h" || arg === "--help") {
        flags["--help"] = true;
        continue;
      }
      die(`Unknown flag: ${arg}`);
    }

    if (spec.type === "boolean") {
      flags[name] = true;
    } else {
      // String flag: next arg or `=` value
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[name] = arg.slice(eqIdx + 1);
      } else {
        const next = argv[++i];
        if (next === undefined || next.startsWith("-")) {
          die(`Flag ${name} requires a value`);
        }
        flags[name] = next;
      }
    }
  }

  return { positional, flags, rest };
}

// ── Table Formatting ─────────────────────────────────────────────────

/** Print a table with aligned columns to stdout. */
export function logTable(
  headers: string[],
  rows: string[][],
  options?: { indent?: number; separator?: string },
): void {
  const indent = options?.indent ?? 0;
  const sep = options?.separator ?? " ";

  if (rows.length === 0) return;

  // Calculate column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      if (row[i] && row[i].length > max) max = row[i].length;
    }
    return max;
  });

  const pad = " ".repeat(indent);

  // Header
  const hLine = headers.map((h, i) => h.padEnd(widths[i])).join(sep);
  console.log(`${pad}${style.bold(hLine)}`);

  // Separator
  const sLine = widths.map((w) => "─".repeat(w)).join(sep);
  console.log(`${pad}${style.dim(sLine)}`);

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => {
      const text = cell ?? "";
      return text.length <= widths[i]
        ? text.padEnd(widths[i])
        : text.slice(0, widths[i] - 1) + "…";
    }).join(sep);
    console.log(`${pad}${line}`);
  }
}

// ── Help Generation ──────────────────────────────────────────────────

export interface HelpSpec {
  name: string;
  description: string;
  usage: string;
  flags?: FlagSpec[];
  subcommands?: { name: string; desc: string }[];
}

/** Print formatted help text for a command. */
export function printHelp(spec: HelpSpec): void {
  console.log(`\n${style.bold(spec.name)} — ${spec.description}\n`);
  console.log(`  ${style.dim("Usage:")} ${spec.usage}\n`);

  if (spec.subcommands) {
    console.log(`  ${style.dim("Commands:")}`);
    const max = Math.max(...spec.subcommands.map((c) => c.name.length));
    for (const cmd of spec.subcommands) {
      console.log(`    ${style.cyan(cmd.name.padEnd(max + 2))} ${cmd.desc}`);
    }
    console.log();
  }

  if (spec.flags) {
    console.log(`  ${style.dim("Options:")}`);
    const max = Math.max(
      ...spec.flags.map((f) => (f.short ? `${f.short}, ${f.name}` : f.name).length),
    );
    for (const f of spec.flags) {
      const label = f.short ? `${f.short}, ${f.name}` : f.name;
      const def = f.default !== undefined ? ` (default: ${f.default})` : "";
      console.log(`    ${label.padEnd(max + 2)} ${f.desc}${def}`);
    }
    console.log();
  }
}
