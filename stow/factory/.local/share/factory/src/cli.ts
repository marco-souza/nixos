#!/usr/bin/env bun
import { resolve } from 'node:path'
import { approveCommand } from './commands/approve'
import { attachCommand, realTerminal } from './commands/attach'
import { dashboardCommand } from './commands/dashboard'
import { discardCommand } from './commands/discard'
import { feedbackCommand } from './commands/feedback'
import { logsCommand } from './commands/logs'
import { newCommand } from './commands/new'
import { runCommand } from './commands/run'
import { fail, ReportedError, type Args, type Cli } from './commands/shared'
import { statusCommand } from './commands/status'
import type { Harness } from './config'
import { makeDeps } from './deps'
import { realExec } from './exec'
import { CommandError } from './machine'
import { findRepo } from './paths'
import { runTail } from './tail'

interface Spec {
  usage: string
  about: string
  example: string
  /** Positional arguments allowed. */
  args: [min: number, max: number]
  flags: string[]
  run(args: Args, cli: Cli, repo: string): Promise<number | void>
}

const EX = '261126-rate-limit'

// In help order.
const COMMANDS: Record<string, Spec> = {
  new: {
    usage: 'new "<feature>" [--no-attach]', about: 'Start a job and answer its requirements grill',
    example: 'factory new "Rate limit the signup form"', args: [1, Infinity], flags: ['no-attach'], run: newCommand,
  },
  status: {
    usage: 'status [<id>] [--json]', about: 'Every job and what it needs; or one job',
    example: `factory status ${EX}`, args: [0, 1], flags: ['json'], run: statusCommand,
  },
  attach: {
    usage: 'attach <id>', about: "Open the job's tmux session",
    example: `factory attach ${EX}`, args: [1, 1], flags: [], run: attachCommand,
  },
  logs: {
    usage: 'logs <id> [<role>] [-f]', about: "An agent's log (default: the latest)",
    example: `factory logs ${EX} planner -f`, args: [1, 2], flags: ['f', 'follow'], run: logsCommand,
  },
  approve: {
    usage: 'approve <id>', about: 'Accept the PR, or an escalation, and go on',
    example: `factory approve ${EX}`, args: [1, 1], flags: [], run: approveCommand,
  },
  feedback: {
    usage: 'feedback <id> [<note>…]', about: 'Send new PR comments and a note; new cycle',
    example: `factory feedback ${EX} "Count per IP"`, args: [1, Infinity], flags: [], run: feedbackCommand,
  },
  run: {
    usage: 'run <id> [--inline]', about: '(Re)start the driver; retries a failed step',
    // --here: the driver window's own command (driverCommand), not in the help.
    example: `factory run ${EX}`, args: [1, 1], flags: ['inline', 'here'], run: runCommand,
  },
  discard: {
    usage: 'discard <id> [--yes]', about: 'Close the PR, delete the branch and worktree',
    example: `factory discard ${EX}`, args: [1, 1], flags: ['yes', 'y'], run: discardCommand,
  },
  dashboard: {
    usage: 'dashboard [--port <n>]', about: 'Serve the dashboard on 127.0.0.1 (port 8000)',
    example: 'factory dashboard --port 8000', args: [0, 0], flags: ['port'], run: dashboardCommand,
  },
}

/** Flags that take a value. */
const VALUED = new Set(['repo', 'port', 'format'])

export function help(): string {
  const rows = [...Object.values(COMMANDS), { usage: 'help', about: 'This help', example: 'factory help' }]
  const width = Math.max(...rows.map((r) => r.usage.length)) + 2
  return [
    'factory: one job per feature, from the requirements grill to a reviewed PR',
    '',
    'Usage: factory <command> [args] [--repo <path>]',
    '',
    ...rows.flatMap((r) => [`  ${r.usage.padEnd(width)}${r.about}`, `    ${r.example}`]),
    '',
    'Every command takes --repo <path> to act on another checkout.',
  ].join('\n')
}

function parse(argv: string[]): { cmd: string | undefined; args: Args } {
  const pos: string[] = []
  const flags: Args['flags'] = {}
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (rest || a === '-' || !a.startsWith('-')) {
      pos.push(a)
      continue
    }
    if (a === '--') {
      rest = true
      continue
    }
    const eq = a.indexOf('=')
    const name = a.startsWith('--') ? a.slice(2, eq > 0 ? eq : undefined) : a.slice(1)
    if (!VALUED.has(name)) {
      flags[name] = true
      continue
    }
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (value === undefined) throw new CommandError(`--${name} needs a value`)
    flags[name] = value
  }
  return { cmd: pos.shift(), args: { pos, flags } }
}

export const realCli: Cli = {
  cwd: process.cwd(),
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  confirm: (q) => /^y(es)?$/i.test((prompt(q) ?? '').trim()),
  terminal: realTerminal,
  deps: (repo, o) => makeDeps(repo, o),
}

/** Runs one command line; returns the exit code. Errors print `factory: <message>`. */
export async function main(argv: string[], cli: Cli = realCli): Promise<number> {
  try {
    const { cmd, args } = parse(argv)
    if (cmd === undefined || cmd === 'help' || args.flags.help || args.flags.h) {
      cli.out(help())
      return 0
    }
    // Used by the run scripts, not by humans: not in the help.
    if (cmd === 'tail') {
      const format = args.flags.format
      if (format !== 'claude' && format !== 'pi') throw new CommandError('usage: factory tail --format claude|pi')
      await runTail(format as Harness)
      return 0
    }
    const spec = COMMANDS[cmd]
    if (!spec) throw new CommandError(`unknown command "${cmd}" (see: factory help)`)
    for (const f of Object.keys(args.flags)) {
      if (f !== 'repo' && !spec.flags.includes(f)) {
        throw new CommandError(`unknown option ${f.length === 1 ? '-' : '--'}${f} for ${cmd} (see: factory help)`)
      }
    }
    const [min, max] = spec.args
    if (args.pos.length < min || args.pos.length > max) throw new CommandError(`usage: factory ${spec.usage}`)
    const repo = await findRepo(resolve(cli.cwd, String(args.flags.repo ?? '.')), realExec)
    return (await spec.run(args, cli, repo)) ?? 0
  } catch (e) {
    if (!(e instanceof ReportedError)) fail(cli, e)
    return 1
  }
}

// exitCode, not exit(): `factory dashboard` keeps serving after main returns.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
