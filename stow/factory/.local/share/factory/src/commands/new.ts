import { mkdirSync, rmSync } from 'node:fs'
import { loadConfig } from '../config'
import type { Deps } from '../deps'
import { driverCommand } from '../driver'
import { newJobId, takenIds } from '../ids'
import { appendActivity, createJob, nextSlot, saveJob, type Job } from '../job'
import { CommandError } from '../machine'
import { jobPaths } from '../paths'
import { paint } from '../ui'
import { enterSession, hasTmux, realTerminal } from './attach'
import { failed, ok, ReportedError, type Args, type Cli, type Terminal } from './shared'

const SETUP_OUTPUT_LINES = 30

/**
 * Creates the job, its worktree and its tmux session, whose driver starts the grill. Prints one line per step;
 * a failing step prints `✗ <step>: …` and throws. Checks gh and tmux before creating anything.
 */
export async function newJob(
  repo: string,
  feature: string,
  deps: Deps,
  o: { attach: boolean; terminal?: Terminal },
): Promise<Job> {
  const what = feature.trim()
  if (!what) throw new CommandError('say what to build: factory new "<feature>"')
  const cfg = loadConfig(repo)
  await deps.gh.preflight()
  if (!(await hasTmux(deps.exec))) throw new Error('tmux is not installed')
  await deps.git.ensureExcluded()

  const id = await step(deps, 'job', () => claimId(repo, what, cfg.docs.requirements, deps))
  deps.log(ok(`job ${id}`))
  const paths = jobPaths(repo, id)
  let worktree = false
  try {
    await step(deps, 'worktree', () => deps.git.createWorktree(`factory/${id}`, paths.worktree, cfg.base))
    worktree = true
    deps.log(ok(`worktree ${paths.worktree}`))
    for (const cmd of cfg.setup) await setup(cmd, paths.worktree, deps)
    if (cfg.setup.length) deps.log(ok('setup'))
  } catch (e) {
    await rollback(repo, id, worktree, deps)
    throw e
  }

  const job = createJob({ id, feature: what, repo, slot: nextSlot(repo), now: deps.now() })
  saveJob(paths.jobFile, job, deps.now())
  appendActivity(paths.activityLog, 'created', deps.now())
  await step(deps, 'tmux session', () => deps.spawner.ensureSession(id, paths.worktree, driverCommand(id)))
  deps.log(ok(`tmux session factory-${id}`))
  if (!(o.attach && (await enterSession(id, deps.exec, o.terminal ?? realTerminal)))) {
    deps.log(`Answer the grill: factory attach ${id}`)
  }
  return job
}

/** Runs `fn`; on failure prints `✗ <name>: <message>` and throws a ReportedError. */
async function step<T>(deps: Deps, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ReportedError) throw e
    const message = `${name}: ${(e as Error).message}`
    deps.log(failed(message))
    throw new ReportedError(message)
  }
}

/** Takes the first free id by creating its job folder; mkdir without -p so a folder made meanwhile is a clash. */
async function claimId(repo: string, feature: string, requirementsDir: string, deps: Deps): Promise<string> {
  const taken = await takenIds(repo, deps.exec, requirementsDir)
  mkdirSync(jobPaths(repo, '').jobsDir, { recursive: true })
  for (;;) {
    const id = newJobId(deps.now(), feature, (x) => taken.has(x))
    try {
      mkdirSync(jobPaths(repo, id).jobDir)
      return id
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      taken.add(id)
    }
  }
}

/** One `setup` command from .factory.json (repo config, so a shell script by design). */
async function setup(cmd: string, cwd: string, deps: Deps): Promise<void> {
  // exec 2>&1: one stream, in the order the command printed it.
  const r = await deps.exec.run(['bash', '-c', `exec 2>&1\n${cmd}`], { cwd })
  if (r.code === 0) return
  const message = `setup: ${cmd} failed (exit ${r.code})`
  deps.log(failed(message))
  const output = `${r.stdout}${r.stderr}`.trimEnd()
  if (output) for (const line of output.split('\n').slice(-SETUP_OUTPUT_LINES)) deps.log(`    ${line}`)
  throw new ReportedError(message)
}

/** Removes what this `factory new` created, so the id is free again. Best effort. */
async function rollback(repo: string, id: string, worktree: boolean, deps: Deps): Promise<void> {
  const paths = jobPaths(repo, id)
  if (worktree) {
    await deps.git.removeWorktree(paths.worktree).catch(() => {})
    await deps.git.deleteBranch(`factory/${id}`).catch(() => {})
  }
  rmSync(paths.jobDir, { recursive: true, force: true })
  deps.log(paint('dim', `  removed job ${id}${worktree ? ', its worktree and branch' : ''}`))
}

export async function newCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  await newJob(repo, args.pos.join(' '), cli.deps(repo), { attach: args.flags['no-attach'] !== true, terminal: cli.terminal })
}
