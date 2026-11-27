import { existsSync } from 'node:fs'
import type { Deps } from '../deps'
import { driverCommand } from '../driver'
import { appendActivity, loadJob, saveJob, type Job, type LegacyJob } from '../job'
import { applyCommand, CommandError, type Command } from '../machine'
import { jobPaths } from '../paths'
import { nextHint, nextLines, paint } from '../ui'

/** Parsed command line: positionals and `--flag [value]`s. */
export interface Args {
  pos: string[]
  flags: Record<string, string | true>
}

/** Where a command's I/O goes. The real one is in cli.ts; tests pass a fake. */
export interface Cli {
  cwd: string
  out(text: string): void
  err(text: string): void
  /** y/N question on the terminal. */
  confirm(question: string): boolean
  terminal: Terminal
  deps(repo: string, o?: { inline?: boolean }): Deps
}

export interface Terminal {
  /** Running inside tmux. */
  tmux: boolean
  /** stdin and stdout are a terminal. */
  tty: boolean
  /** Runs `cmd` on this terminal (tmux attach) and returns its exit code. */
  handOver(cmd: string[]): number
}

/** An error the command already printed; the CLI only exits 1. */
export class ReportedError extends Error {}

export const JOB_ID = /^[A-Za-z0-9][\w.-]*$/

/** Job `id`, v1 or v2. Throws CommandError when there is none. */
export function findJob(repo: string, id: string): Job | LegacyJob {
  const file = jobPaths(repo, id).jobFile
  // The id becomes a path: anything but a plain name is no job.
  if (!JOB_ID.test(id) || !existsSync(file)) throw new CommandError(`no job ${id} (see: factory status)`)
  return loadJob(file)
}

/** The v2 job `id`. Throws CommandError when there is none or it is a v1 job. */
export function requireJob(repo: string, id: string): Job {
  const job = findJob(repo, id)
  if ('legacy' in job) throw new CommandError(`${id} is a v1 job; v2 cannot drive it`)
  return job
}

/** Applies a human command to the saved job (read fresh), saves it and logs it to activity.log. */
export function transition(repo: string, id: string, command: Command, deps: Deps, patch: Partial<Job> = {}): Job {
  const job = requireJob(repo, id)
  const next = { ...applyCommand(job, command, deps.now()), ...patch }
  const paths = jobPaths(repo, id)
  saveJob(paths.jobFile, next, deps.now())
  appendActivity(paths.activityLog, `${command.kind}: ${job.stage} → ${next.stage}`, deps.now())
  return next
}

/** Restarts (or starts) the driver in the job's tmux session. */
export function restartDriver(job: Job, deps: Deps): Promise<void> {
  return deps.spawner.respawnDriver(job.id, job.worktree, driverCommand(job.id))
}

/** `next: <hint>` when the job has one. */
export function printNext(job: Job, cli: Cli): void {
  const hint = nextHint(job)
  if (hint) cli.out(nextLines(hint).join('\n'))
}

/** `factory: <message>` in red on stderr; the stack too with FACTORY_DEBUG=1. */
export function fail(cli: Cli, e: unknown): void {
  cli.err(paint('red', `factory: ${e instanceof Error ? e.message : String(e)}`))
  if (process.env.FACTORY_DEBUG === '1' && e instanceof Error && e.stack) cli.err(e.stack)
}

export const ok = (s: string) => `${paint('green', '✓')} ${s}`
export const failed = (s: string) => paint('red', `✗ ${s}`)
