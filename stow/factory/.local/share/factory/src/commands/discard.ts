import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Deps } from '../deps'
import type { Job } from '../job'
import { applyCommand, CommandError } from '../machine'
import { jobPaths } from '../paths'
import { prNumber } from '../ui'
import { failed, ok, findJob, transition, type Args, type Cli } from './shared'

/**
 * Stops the driver and agents, removes the worktree, closes the PR, deletes the branch and the proof branch, marks the job
 * discarded and moves its folder to `.factory/archive/`, so its id is free again. Each step is best effort: a failure is
 * printed and the rest still runs.
 */
export async function discard(repo: string, id: string, deps: Deps): Promise<Job> {
  const job = findJob(repo, id)
  // Refuses an already discarded job before touching anything.
  applyCommand(job, { kind: 'discard' }, deps.now())
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      deps.log(ok(name))
    } catch (e) {
      deps.log(failed(`${name}: ${(e as Error).message}`))
    }
  }
  // The driver first: it would otherwise save over `discarded`.
  await attempt('stop the driver and agents', async () => {
    await deps.spawner.kill(id, 'driver')
    await deps.spawner.killAgents(id)
  })
  // The worktree before the branch: git can't delete a branch a worktree has checked out.
  if (existsSync(job.worktree)) await attempt('remove worktree', () => deps.git.removeWorktree(job.worktree))
  if (job.pr) await attempt(`close PR ${prNumber(job.pr)}`, () => deps.gh.close(job.pr!))
  await attempt(`delete branch ${job.branch}`, () => deps.git.deleteBranch(job.branch))
  // The proof screenshots finalize pushed; only on the remote, so a missing local one is fine.
  await attempt(`delete branch factory-proof/${id}`, () => deps.git.deleteBranch(`factory-proof/${id}`))
  const next = transition(repo, id, { kind: 'discard' }, deps, { running: [] })
  const paths = jobPaths(repo, id)
  const to = join(paths.factoryDir, 'archive', `${id}-${deps.now().getTime()}`)
  mkdirSync(dirname(to), { recursive: true })
  renameSync(paths.jobDir, to)
  deps.log(ok(`discarded ${id}; its folder is now ${relative(repo, to)}`))
  return next
}

export async function discardCommand(args: Args, cli: Cli, repo: string): Promise<number | void> {
  const id = args.pos[0]!
  const job = findJob(repo, id)
  if (args.flags.yes !== true && args.flags.y !== true) {
    // Agents run commands without a terminal: no one there could have said yes.
    if (!cli.terminal.tty) throw new CommandError(`refusing to discard ${id} without --yes (no terminal to confirm)`)
    const what = job.pr ? `closes PR ${prNumber(job.pr)} and deletes` : 'deletes'
    if (!cli.confirm(`Discard ${id}? This ${what} ${job.branch} and its worktree. [y/N]`)) {
      cli.out(`Kept ${id}.`)
      return 1
    }
  }
  await discard(repo, id, cli.deps(repo))
}
