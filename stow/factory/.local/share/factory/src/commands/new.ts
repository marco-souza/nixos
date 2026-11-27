import { mkdirSync, rmSync } from 'node:fs'
import { loadConfig } from '../config'
import type { Deps } from '../deps'
import { driverCommand } from '../driver'
import { jobIdFor, nameBranch, takenIds } from '../ids'
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

  const named = await nameBranch(what, cfg, deps.exec, repo)
  const { id, branch } = await step(deps, 'job', () => claim(repo, named, cfg.docs.requirements, deps))
  deps.log(ok(`job ${id} on ${branch}`))
  const paths = jobPaths(repo, id)
  let worktree = false
  try {
    await step(deps, 'worktree', () => deps.git.createWorktree(branch, paths.worktree, cfg.base))
    worktree = true
    deps.log(ok(`worktree ${paths.worktree}`))
    for (const cmd of cfg.setup) await setup(cmd, paths.worktree, deps)
    if (cfg.setup.length) deps.log(ok('setup'))
  } catch (e) {
    await rollback(repo, id, worktree ? branch : null, deps)
    throw e
  }

  const job = createJob({ id, branch, feature: what, repo, slot: nextSlot(repo), now: deps.now() })
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

/**
 * Takes `named`, or `named-2`, `-3`… when its id or the branch is taken, by creating the job folder; mkdir without -p
 * so a folder made meanwhile is a clash. Never an existing branch: `discard` deletes the job's branch.
 */
async function claim(repo: string, named: string, requirementsDir: string, deps: Deps): Promise<{ id: string; branch: string }> {
  const taken = takenIds(repo, requirementsDir)
  mkdirSync(jobPaths(repo, '').jobsDir, { recursive: true })
  for (let n = 1; ; n++) {
    const suffix = n > 1 ? `-${n}` : ''
    const id = jobIdFor(named) + suffix
    const branch = named + suffix
    if (taken.has(id) || (await deps.git.branchExists(branch))) continue
    try {
      mkdirSync(jobPaths(repo, id).jobDir)
      return { id, branch }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
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
async function rollback(repo: string, id: string, branch: string | null, deps: Deps): Promise<void> {
  const paths = jobPaths(repo, id)
  if (branch) {
    await deps.git.removeWorktree(paths.worktree).catch(() => {})
    await deps.git.deleteBranch(branch).catch(() => {})
  }
  rmSync(paths.jobDir, { recursive: true, force: true })
  deps.log(paint('dim', `  removed job ${id}${branch ? ', its worktree and branch' : ''}`))
}

export async function newCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  await newJob(repo, args.pos.join(' '), cli.deps(repo), { attach: args.flags['no-attach'] !== true, terminal: cli.terminal })
}
