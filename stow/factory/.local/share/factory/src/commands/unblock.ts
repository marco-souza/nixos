import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Deps } from '../deps'
import type { Job } from '../job'
import { CommandError } from '../machine'
import { jobPaths } from '../paths'
import { findJob, ok, printNext, restartDriver, transition, type Args, type Cli } from './shared'

/**
 * Settles what a failed or blocked step stopped on: the decision goes to `decision-<k>.md`, the step runs again with it
 * as an input (so do all later agents), and the driver restarts. Cheaper than feedback, which starts a new cycle.
 */
export async function unblock(repo: string, id: string, decision: string, deps: Deps): Promise<Job> {
  const text = decision.trim()
  if (!text) throw new CommandError(`say what you decided: factory unblock ${id} "<decision>"`)
  const file = jobPaths(repo, id).decision(findJob(repo, id).decisions.length + 1)
  // After the transition, so a refused unblock leaves no file behind.
  const next = transition(repo, id, { kind: 'unblock', file }, deps)
  writeFileSync(file, `# Decision for ${id}\n\n${text}\n`)
  await restartDriver(next, deps)
  return next
}

export async function unblockCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const [id, ...words] = args.pos
  const job = await unblock(repo, id!, words.join(' '), cli.deps(repo))
  cli.out(ok(`sent ${relative(repo, job.decisions.at(-1)!)}; ${job.id} resumes at ${job.stage}`))
  printNext(job, cli)
}
