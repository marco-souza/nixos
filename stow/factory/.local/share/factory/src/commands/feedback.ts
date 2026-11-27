import { existsSync, statSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Deps } from '../deps'
import type { PrComment } from '../git'
import { heldSlots, nextSlot, type Job } from '../job'
import { CommandError } from '../machine'
import { jobPaths } from '../paths'
import { ok, printNext, findJob, restartDriver, transition, type Args, type Cli } from './shared'

/**
 * New PR comments (since the last feedback file) and `note` go to `feedback-<k>.md`; the job starts a new cycle.
 * Stops the job's agents first; a done job's PR goes back to draft, and it takes a free slot if its own was taken.
 */
export async function feedback(repo: string, id: string, note: string | null, deps: Deps): Promise<Job> {
  const job = findJob(repo, id)
  if (job.stage === 'discarded') throw new CommandError(`cannot send feedback: ${id} is discarded`)
  const paths = jobPaths(repo, id)
  const last = job.feedbackCount > 0 ? paths.feedback(job.feedbackCount) : null
  const since = last && existsSync(last) ? seconds(statSync(last).mtime) : null
  const comments = job.pr ? await deps.gh.commentsSince(job.pr, since) : []
  const text = note?.trim() || null
  if (!comments.length && !text) throw new CommandError('nothing new to send')

  const k = job.feedbackCount + 1
  const file = paths.feedback(k)
  writeFileSync(file, render(id, k, comments, text))
  // The driver goes first: alive, it would save its old state over the new cycle when its agents die.
  await deps.spawner.kill(id, 'driver')
  await deps.spawner.killAgents(id)
  if (job.stage === 'done' && job.pr) await deps.gh.toDraft(job.pr)
  // A done job holds no slot, so another job may have its ports by now.
  const slot = job.stage === 'done' && heldSlots(repo).has(job.slot) ? nextSlot(repo) : job.slot
  const next = transition(repo, id, { kind: 'feedback', file }, deps, { running: [], slot })
  await restartDriver(next, deps)
  return next
}

/** GitHub's timestamp format (no milliseconds), so a comment from the same second as the file counts as sent. */
const seconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

function render(id: string, k: number, comments: PrComment[], note: string | null): string {
  const parts = [`# Feedback ${k} for ${id}`]
  if (comments.length) parts.push('## PR comments')
  for (const c of comments) {
    const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''
    parts.push(`### @${c.author || 'unknown'}${where}`, c.body.trimEnd())
  }
  if (note) parts.push('## Note', note)
  return `${parts.join('\n\n')}\n`
}

export async function feedbackCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const [id, ...words] = args.pos
  const job = await feedback(repo, id!, words.join(' ') || null, cli.deps(repo))
  cli.out(ok(`sent ${relative(repo, job.reasonFile!)}; cycle ${job.cycle} starts at ${job.stage}`))
  printNext(job, cli)
}
