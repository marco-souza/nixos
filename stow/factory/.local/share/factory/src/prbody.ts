import { readdir, rm } from 'node:fs/promises'
import type { FactoryConfig } from './config'
import type { Exec } from './exec'
import { GitError } from './git'
import type { Job, Stage } from './job'

const START = '<!-- factory:status -->'
const END = '<!-- /factory:status -->'

const GROUPS = ['Discovery', 'Building', 'Validation', 'Deploy'] as const
type Group = (typeof GROUPS)[number]

const STEPS: { stage: Stage; label: string; group: Group }[] = [
  { stage: 'requirements', label: 'requirements', group: 'Discovery' },
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

function mark(job: Job, i: number): string {
  const step = STEPS[i]!
  if (job.stage === 'done') return '✅'
  if (job.stage === 'discarded') return job.planned && step.group === 'Discovery' ? '✅' : '⬜'
  const current = job.stage === 'needs-human' ? job.resumeStage : job.stage
  const at = STEPS.findIndex((s) => s.stage === current)
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

  const rows = GROUPS.map((group) => {
    const steps = STEPS.flatMap((s, i) =>
      s.group === group ? [`${mark(job, i)} ${s.label}${s.stage === job.stage ? counter(job, s.stage) : ''}`] : [],
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
