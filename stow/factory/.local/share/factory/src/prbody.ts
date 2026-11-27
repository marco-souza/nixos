import { readdir, rm } from 'node:fs/promises'
import type { FactoryConfig } from './config'
import type { Exec } from './exec'
import { GitError } from './git'
import type { Job, Stage } from './job'

const START = '<!-- factory:status -->'
const END = '<!-- /factory:status -->'

export const GROUPS = ['Discovery', 'Building', 'Validation', 'Deploy'] as const
type Group = (typeof GROUPS)[number]

export const STEPS: { stage: Stage; label: string; group: Group }[] = [
  { stage: 'requirements', label: 'requirements', group: 'Discovery' },
  { stage: 'preflight', label: 'access check', group: 'Discovery' },
  { stage: 'report', label: 'report', group: 'Building' },
  { stage: 'tech-discovery', label: 'tech discovery', group: 'Discovery' },
  { stage: 'design', label: 'design', group: 'Discovery' },
  { stage: 'discovery-review', label: 'AI review', group: 'Discovery' },
  { stage: 'planning', label: 'plan', group: 'Building' },
  { stage: 'build', label: 'build', group: 'Building' },
  { stage: 'review', label: 'review', group: 'Building' },
  { stage: 'build-judge', label: 'judge', group: 'Building' },
  { stage: 'test-planning', label: 'test plan', group: 'Validation' },
  { stage: 'rebase', label: 'rebase', group: 'Validation' },
  { stage: 'qa-wait', label: 'QA ready', group: 'Validation' },
  { stage: 'validation', label: 'validators', group: 'Validation' },
  { stage: 'validation-judge', label: 'judge', group: 'Validation' },
  { stage: 'human-review', label: 'your review', group: 'Deploy' },
  { stage: 'finalize', label: 'ready', group: 'Deploy' },
]

const REPORT_STAGES: Stage[] = ['requirements', 'preflight', 'report', 'human-review', 'finalize']

/** The steps a job goes through: a report job skips the PR's stages, a PR job the report. */
export function stepsFor(job: Pick<Job, 'deliverable'>): typeof STEPS {
  const report = job.deliverable === 'report'
  return STEPS.filter((s) => (report ? REPORT_STAGES.includes(s.stage) : s.stage !== 'report'))
}

/** The groups that have a step in `steps`, in order. */
export const groupsOf = (steps: typeof STEPS): Group[] => GROUPS.filter((g) => steps.some((s) => s.group === g))

const DOC_ORDER = ['requirements', 'tech discovery', 'design', 'spec', 'test plan']

/** ` (k/n)` for the current trip's review or validation record; '' when there is none. */
function counter(job: Job, stage: Stage): string {
  const trip = job.trips[job.trips.length - 1]
  const rec = stage === 'review' ? trip?.reviews : stage === 'validation' ? trip?.validations : undefined
  const verdicts = Object.values(rec ?? {})
  if (!verdicts.length) return ''
  return ` (${verdicts.filter((v) => v !== 'pending').length}/${verdicts.length})`
}

function headline(job: Job): string {
  switch (job.stage) {
    case 'done': return '✅ **Done**'
    case 'discarded': return '🗑 **Discarded**'
    case 'human-review': return '⏸ **Waiting for your review**'
    case 'needs-human': return `⏸ **Waiting for you: ${job.reason ?? 'escalation'}**`
    case 'requirements':
      if (job.waitingFor === 'requirements') return '⏸ **Waiting for you: answer the grill**'
  }
  const step = STEPS.find((s) => s.stage === job.stage)
  if (!step) return `⏳ **${job.stage}**`
  return `⏳ **${step.group}: ${step.label}${counter(job, job.stage)}**`
}

function mark(job: Job, steps: typeof STEPS, i: number): string {
  const step = steps[i]!
  if (job.stage === 'done') return '✅'
  if (job.stage === 'discarded') return job.planned && step.group === 'Discovery' ? '✅' : '⬜'
  const current = job.stage === 'needs-human' ? job.resumeStage : job.stage
  const at = steps.findIndex((s) => s.stage === current)
  if (at < 0) return '⬜'
  if (i < at) return '✅'
  if (i > at) return '⬜'
  if (job.stage === 'needs-human') return job.waitingFor === 'failure' ? '❌' : '⏸'
  if (job.stage === 'human-review' || (job.stage === 'requirements' && job.waitingFor === 'requirements')) return '⏸'
  return '⏳'
}

export function renderStatus(job: Job, cfg: FactoryConfig, docLinks: Record<string, string | null>): string {
  const parts = ['**🏭 Factory**', `\`${job.id}\``, `cycle ${job.cycle}`]
  if (job.trip > 0) parts.push(`trip ${job.trip}/${cfg.maxTrips + job.extraTrips}`)
  parts.push(headline(job))

  const all = stepsFor(job)
  const rows = groupsOf(all).map((group) => {
    const steps = all.flatMap((s, i) =>
      s.group === group ? [`${mark(job, all, i)} ${s.label}${s.stage === job.stage ? counter(job, s.stage) : ''}`] : [],
    )
    return `| ${group} | ${steps.join(' · ')} |`
  })

  const docs = DOC_ORDER.flatMap((name) => (docLinks[name] ? [`[${name}](${docLinks[name]})`] : []))
  return [
    START,
    parts.join(' · '),
    '',
    '| Stage | Steps |',
    '| --- | --- |',
    ...rows,
    ...(docs.length ? ['', `Docs: ${docs.join(' · ')}`] : []),
    END,
  ].join('\n')
}

/** Replace the status block in `body`, or prepend it. Slices instead of `String.replace` so `$` in `status` stays literal. */
export function mergeStatus(body: string, status: string): string {
  const a = body.indexOf(START)
  const b = body.indexOf(END)
  if (a >= 0 && b > a) return body.slice(0, a) + status + body.slice(b + END.length)
  return `${status}\n\n${body}`
}

const DECISION_START = '<!-- factory:decision -->'
const DECISION_END = '<!-- /factory:decision -->'

/** `body` without the block between `start` and `end`, joining what was around it with one blank line. */
function cut(body: string, start: string, end: string): string {
  const a = body.indexOf(start)
  const b = body.indexOf(end)
  if (a < 0 || b <= a) return body
  const before = body.slice(0, a).trimEnd()
  const after = body.slice(b + end.length).trimStart()
  return before && after ? `${before}\n\n${after}` : before || after
}

/** Puts `decision` right below the status block (or on top), replacing an earlier one; null removes it. Slices, so `$` stays literal. */
export function mergeDecision(body: string, decision: string | null): string {
  const rest = cut(body, DECISION_START, DECISION_END)
  if (decision === null) return rest
  const block = `${DECISION_START}\n${decision}\n${DECISION_END}`
  const end = rest.indexOf(END)
  if (end < 0) return rest ? `${block}\n\n${rest}` : block
  const at = end + END.length
  const after = rest.slice(at).trimStart()
  return `${rest.slice(0, at)}\n\n${block}${after ? `\n\n${after}` : ''}`
}

export function initialBody(job: Job): string {
  // The cap is only shown once a trip has started, which a fresh job has not.
  const status = renderStatus(job, { maxTrips: 0 } as FactoryConfig, {})
  return `${status}\n\n_Work in progress by the factory. Docs and commits land here as they are written._\n`
}

/** Criteria with no `ac<k>.*` / `ac<k>-*` proof file. */
export function proofCoverage(criteria: number[], proofFiles: string[]): number[] {
  return criteria.filter((k) => !proofFiles.some((f) => new RegExp(`^ac${k}(\\.|-)`, 'i').test(f)))
}

/** Orphan commit of `proofDir` pushed to `factory-proof/<jobId>` (v1's temp-index recipe). Null when empty. */
export async function pushProof(
  exec: Exec,
  repo: string,
  proofDir: string,
  jobId: string,
  indexFile: string,
): Promise<string | null> {
  const files = await readdir(proofDir).catch(() => [])
  if (!files.length) return null
  await rm(indexFile, { force: true })
  const git = async (...args: string[]) => {
    const cmd = ['git', ...args]
    const r = await exec.run(cmd, { cwd: repo, env: { GIT_INDEX_FILE: indexFile } })
    if (r.code !== 0) throw new GitError(cmd, r)
    return r.stdout.trim()
  }
  await git(`--work-tree=${proofDir}`, 'add', '-A', '.')
  const tree = await git('write-tree')
  const sha = await git('commit-tree', tree, '-m', `proof: ${jobId}`)
  // Plain --force: an orphan proof ref only the driver writes, never a code branch.
  await git('push', '--force', 'origin', `${sha}:refs/heads/factory-proof/${jobId}`)
  return sha
}
