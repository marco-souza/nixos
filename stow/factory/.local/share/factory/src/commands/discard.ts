import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import type { Deps } from '../deps'
import type { Job } from '../job'
import { applyCommand, CommandError } from '../machine'
import { jobPaths } from '../paths'
import { prNumber } from '../ui'
import { failed, ok, requireJob, transition, type Args, type Cli } from './shared'

/**
 * Stops the session, removes the worktree, closes the PR, deletes the branch and marks the job discarded.
 * Each step is best effort: a failure is printed and the rest still runs. The job folder stays.
 */
export async function discard(repo: string, id: string, deps: Deps): Promise<Job> {
  const job = requireJob(repo, id)
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
  // The session first: it holds the driver, which would otherwise save over `discarded`.
  await attempt(`stop tmux session factory-${id}`, () => deps.spawner.killSession(id))
  // The worktree before the PR: `gh pr close --delete-branch` can't delete a branch a worktree has checked out.
  if (existsSync(job.worktree)) await attempt('remove worktree', () => deps.git.removeWorktree(job.worktree))
  if (job.pr) await attempt(`close PR ${prNumber(job.pr)}`, () => deps.gh.close(job.pr!))
  await attempt(`delete branch ${job.branch}`, () => deps.git.deleteBranch(job.branch))
  const next = transition(repo, id, { kind: 'discard' }, deps, { running: [] })
  deps.log(ok(`discarded ${id}; its folder stays: ${relative(repo, jobPaths(repo, id).jobDir)}`))
  return next
}

export async function discardCommand(args: Args, cli: Cli, repo: string): Promise<number | void> {
  const id = args.pos[0]!
  const job = requireJob(repo, id)
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
