import { dirname, join, relative } from 'node:path'
import type { Job } from './job'
import { groupsOf, stepsFor } from './prbody'
import { useColor } from './tail'

export type Color = 'dim' | 'bold' | 'green' | 'red' | 'yellow' | 'gold' | 'cyan'

const CODES: Record<Color, string> = {
  dim: '2', bold: '1', green: '32', red: '31', yellow: '33', gold: '38;5;178', cyan: '36',
}

/** `s` in `color`; plain when NO_COLOR is set or stdout is not a TTY. */
export function paint(color: Color, s: string): string {
  return useColor() ? `\x1b[${CODES[color]}m${s}\x1b[0m` : s
}

/** `45s`, `3m`, `2h`, `4d`; `-` for a bad timestamp. */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '-'
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** A job file relative to the repo (the worktree is `<repo>/.factory/<id>`). */
function show(job: Job, file: string): string {
  const rel = relative(dirname(dirname(job.worktree)), file)
  return rel.startsWith('..') ? file : rel
}

const judgeFile = (job: Job) => job.questionsFile ?? job.reasonFile
/** `<repo>/.factory/jobs/<id>/report.md`, from the worktree path `<repo>/.factory/<id>`. */
const reportFile = (job: Job) => join(dirname(job.worktree), 'jobs', job.id, 'report.md')

/** What the human needs to do for a waiting job; null when it needs nothing. */
export function whatFor(job: Job): string | null {
  switch (job.stage) {
    case 'requirements':
      return 'Answer the grill questions'
    case 'human-review':
      if (job.deliverable === 'report') return `Read the report: ${show(job, reportFile(job))}`
      return `Review the PR${job.pr ? `: ${job.pr}` : ''}`
    case 'needs-human': {
      const file = judgeFile(job)
      if (job.capHit === 'env') return `QA env failed twice; see ${job.reasonFile ? show(job, job.reasonFile) : 'the validation files'}`
      if (job.waitingFor === 'escalation') return `A judge escalated${file ? `; see ${show(job, file)}` : ''}`
      return `Failed: ${job.reason ?? 'unknown reason'}`
    }
  }
  return null
}

/** The command(s) to type next. Shared by the CLI, the driver window and the dashboard. */
export function nextHint(job: Job): string | null {
  const id = job.id
  const respond = `factory approve ${id}   or   factory feedback ${id} "…"`
  switch (job.stage) {
    case 'requirements':
      return `factory answer ${id}`
    case 'human-review':
      return respond
    case 'needs-human': {
      if (job.capHit === 'env') return `factory run ${id} once QA is back   or   factory approve ${id}   or   factory discard ${id}`
      const file = judgeFile(job)
      if (job.waitingFor === 'escalation') return file ? `${respond}   (see ${show(job, file)})` : respond
      return `factory unblock ${id} "<decision>"   or   factory run ${id} to retry   or   factory discard ${id}`
    }
    case 'done':
    case 'discarded':
      return null
  }
  return `factory logs ${id} -f to watch`
}

const WIDTH = 80
const OR = '   or   '
const SEE = '   (see '

/** `next: <hint>`; past 80 columns, one alternative per line with the commands aligned. */
export function nextLines(hint: string): string[] {
  const label = paint('dim', 'next:')
  if (`next: ${hint}`.length <= WIDTH) return [`${label} ${hint}`]
  const at = hint.indexOf(SEE)
  const [first, ...rest] = (at < 0 ? hint : hint.slice(0, at)).split(OR)
  return [
    `${label} ${first}`,
    ...rest.map((alt) => `${paint('dim', '  or')}  ${alt}`),
    ...(at < 0 ? [] : [`      ${hint.slice(at + 3)}`]),
  ]
}

/** Waits on the human: the grill, PR review, an escalation or a failure. */
export const needsYou = (job: Job) => job.waitingFor !== null && job.stage !== 'done' && job.stage !== 'discarded'

/** ` 3/5`: verdicts in over lenses (or validators) of the current trip, in review or validation. */
function counter(job: Job): string {
  const trip = job.trips[job.trips.length - 1]
  const rec = job.stage === 'review' ? trip?.reviews : job.stage === 'validation' ? trip?.validations : undefined
  const verdicts = Object.values(rec ?? {})
  return verdicts.length ? ` ${verdicts.filter((v) => v !== 'pending').length}/${verdicts.length}` : ''
}

/** `Discovery ✓ ─ Building ● review 3/5 ─ Validation ○ ─ Deploy ○` */
export function pipelineLine(job: Job): string {
  const current = job.stage === 'needs-human' ? job.resumeStage : job.stage
  const steps = stepsFor(job)
  const all = groupsOf(steps)
  const step = steps.find((s) => s.stage === current)
  const at = step ? all.indexOf(step.group) : -1
  const groups = all.map((g, i) => {
    if (job.stage === 'done') return `${g} ${paint('green', '✓')}`
    if (job.stage === 'discarded') return `${g} ${job.planned && i === 0 ? paint('green', '✓') : paint('dim', '○')}`
    if (i < at) return `${g} ${paint('green', '✓')}`
    if (i > at || !step) return `${g} ${paint('dim', '○')}`
    const failed = job.stage === 'needs-human' && job.waitingFor === 'failure'
    const mark = failed ? paint('red', '✗') : needsYou(job) ? paint('gold', '●') : paint('cyan', '●')
    return `${paint('bold', g)} ${mark} ${step.label}${counter(job)}`
  })
  return groups.join(paint('dim', ' ─ '))
}

const WAITING_LABEL: Record<string, string> = {
  requirements: 'grill', 'human-review': 'review', escalation: 'escalation', failure: 'failure',
}

export const prNumber = (pr: string | null) => (pr ? `#${/\/pull\/(\d+)/.exec(pr)?.[1] ?? '?'}` : '-')

/** Needs-you rows first, then running, then done or discarded. */
function rank(j: Job): number {
  if (needsYou(j)) return 0
  return j.stage === 'done' || j.stage === 'discarded' ? 2 : 1
}

/** One row per job: `JOB  STAGE  TRIP  WAITING  PR  AGE`. */
export function statusTable(jobs: Job[], now: Date): string {
  const sorted = [...jobs].sort((a, b) => rank(a) - rank(b))
  const rows = sorted.map((j) => {
    const waiting = needsYou(j)
      ? `${WAITING_LABEL[j.waitingFor!] ?? j.waitingFor}${j.waitingSince ? ` ${ago(j.waitingSince, now)}` : ''}`
      : '-'
    return {
      mark: needsYou(j),
      cells: [j.id, j.stage, j.trip > 0 ? String(j.trip) : '-', waiting, prNumber(j.pr), ago(j.createdAt, now)],
    }
  })
  const header = ['JOB', 'STAGE', 'TRIP', 'WAITING', 'PR', 'AGE']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r.cells[i]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  const out = [`  ${paint('bold', line(header))}`]
  for (const r of rows) {
    out.push(`${r.mark ? paint('gold', '●') : ' '} ${line(r.cells)}`)
  }
  return out.join('\n')
}
