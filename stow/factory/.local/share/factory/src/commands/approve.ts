import type { Deps } from '../deps'
import type { Job } from '../job'
import { ok, printNext, restartDriver, transition, type Args, type Cli } from './shared'

/** Accepts what is there: finalizes the PR, or goes on past an escalation. Restarts the driver. */
export async function approve(repo: string, id: string, deps: Deps): Promise<Job> {
  const job = transition(repo, id, { kind: 'approve' }, deps)
  await restartDriver(job, deps)
  return job
}

export async function approveCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const job = await approve(repo, args.pos[0]!, cli.deps(repo))
  cli.out(ok(`approved ${job.id}; the driver goes on with ${job.stage}`))
  printNext(job, cli)
}
