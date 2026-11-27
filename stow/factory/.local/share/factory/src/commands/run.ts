import type { Deps } from '../deps'
import { runJob } from '../driver'
import type { Job } from '../job'
import { CommandError } from '../machine'
import { hasTmux } from './attach'
import { fail, ok, printNext, requireJob, restartDriver, transition, type Args, type Cli } from './shared'

/** Retries the step a `needs-human` job failed (one more trip at the trip cap) and restarts the driver. */
export async function retry(repo: string, id: string, deps: Deps): Promise<Job> {
  const job = transition(repo, id, { kind: 'retry' }, deps)
  await restartDriver(job, deps)
  return job
}

/**
 * (Re)starts the driver in the job's tmux session and returns; a failed job is retried first. The driver never runs
 * as a child of this command, whose caller (an agent's shell) may not outlive it. `--inline` drives here instead,
 * agents included; `--here` is the driver window's own command.
 */
export async function runCommand(args: Args, cli: Cli, repo: string): Promise<number | void> {
  const id = args.pos[0]!
  let job = requireJob(repo, id)
  if (args.flags.here === true) return drive(repo, id, cli.deps(repo, { inline: false }), cli)
  const inline = args.flags.inline === true
  const deps = cli.deps(repo, { inline })
  if (!inline && !(await hasTmux(deps.exec))) throw new CommandError(`tmux is not installed (or drive it here: factory run ${id} --inline)`)
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
  if (inline) {
    // Inline agents get no terminal, and the grill is a conversation with the human.
    if (job.stage === 'requirements') throw new CommandError('the grill needs a terminal; run without --inline')
    return drive(repo, id, deps, cli)
  }
  await restartDriver(job, deps)
  cli.out(ok(`driver started in tmux session factory-${id}`))
  printNext(job, cli)
}

/** Drives the job in this process until it waits on the human. The driver prints why it stopped and what to type next. */
async function drive(repo: string, id: string, deps: Deps, cli: Cli): Promise<void> {
  if ((await runJob(repo, id, deps)) === 'discarded') cli.out(`${id}: discarded`)
}
