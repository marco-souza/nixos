import type { Deps } from '../deps'
import { runJob } from '../driver'
import type { Job } from '../job'
import { CommandError } from '../machine'
import { hasSession, hasTmux } from './attach'
import { fail, ok, printNext, requireJob, restartDriver, transition, type Args, type Cli } from './shared'

/** Retries the step a `needs-human` job failed (one more trip at the trip cap) and restarts the driver. */
export async function retry(repo: string, id: string, deps: Deps): Promise<Job> {
  const job = transition(repo, id, { kind: 'retry' }, deps)
  await restartDriver(job, deps)
  return job
}

/** Drives the job in this process until it waits on the human; a failed job is retried first. */
export async function runCommand(args: Args, cli: Cli, repo: string): Promise<number | void> {
  const id = args.pos[0]!
  const inline = args.flags.inline === true
  const deps = cli.deps(repo, { inline })
  let job = requireJob(repo, id)
  if (job.stage === 'needs-human') {
    try {
      job = transition(repo, id, { kind: 'retry' }, deps)
    } catch (e) {
      if (!(e instanceof CommandError)) throw e
      fail(cli, e)
      printNext(job, cli)
      return 1
    }
    cli.out(`${id}: retrying from ${job.stage}`)
  }
  // Agents run as windows of the job's session: without one, the driver starts in a new session instead of here.
  if (!inline && !(await hasSession(deps.exec, id))) {
    if (!(await hasTmux(deps.exec))) throw new CommandError(`tmux is not installed (or drive it here: factory run ${id} --inline)`)
    await restartDriver(job, deps)
    cli.out(ok(`driver started in tmux session factory-${id}`))
    printNext(job, cli)
    return
  }
  // The driver prints why it stopped and what to type next.
  if ((await runJob(repo, id, deps)) === 'discarded') cli.out(`${id}: discarded`)
}
