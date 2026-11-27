import { existsSync, readFileSync } from 'node:fs'
import { listJobs, type Job } from '../job'
import { jobPaths } from '../paths'
import { needsYou, nextHint, nextLines, paint, pipelineLine, statusTable, whatFor } from '../ui'
import { findJob, type Args, type Cli } from './shared'

const ACTIVITY_LINES = 10

export async function statusCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const id = args.pos[0]
  const json = args.flags.json === true
  if (id !== undefined) {
    const job = findJob(repo, id)
    cli.out(json ? JSON.stringify(job, null, 2) : detail(repo, job))
    return
  }
  const jobs = listJobs(repo)
  if (json || !jobs.length) {
    cli.out(json ? JSON.stringify(jobs, null, 2) : 'No factory jobs yet. Start one: factory new "<feature>"')
    return
  }
  cli.out(statusTable(jobs, cli.deps(repo).now()))
  // What to type for each job that needs the human, in table order.
  const hints = jobs.flatMap((j) => (needsYou(j) ? [nextHint(j)!] : []))
  if (hints.length) cli.out(['', ...hints.flatMap(nextLines)].join('\n'))
}

/** One job: header, pipeline, what it needs, running agents, recent activity, next step. */
function detail(repo: string, job: Job): string {
  const title = `${paint('bold', job.id)}${job.feature ? `  ${job.feature}` : ''}`
  const facts = [job.stage, `cycle ${job.cycle}`, ...(job.trip > 0 ? [`trip ${job.trip}`] : []), ...(job.pr ? [job.pr] : [])]
  const sections = [[title, facts.join(' · '), pipelineLine(job)]]
  const why = whatFor(job)
  const now = [...(why ? [`${paint('gold', 'Needs you:')} ${why}`] : []), ...(job.running.length ? [`Running: ${job.running.join(', ')}`] : [])]
  sections.push(now)
  sections.push(activity(repo, job.id).map((l) => paint('dim', `  ${l}`)))
  const hint = nextHint(job)
  sections.push(hint ? nextLines(hint) : [])
  return sections.filter((s) => s.length).map((s) => s.join('\n')).join('\n\n')
}

function activity(repo: string, id: string): string[] {
  const file = jobPaths(repo, id).activityLog
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-ACTIVITY_LINES)
}
