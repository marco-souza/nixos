import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createJob, type Job } from '../job'
import { ago, nextHint, nextLines, paint, pipelineLine, statusTable, whatFor } from '../ui'

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
beforeEach(() => {
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const NOW = new Date('2026-11-26T12:00:00Z')
const REPO = '/r'

function job(id: string, over: Partial<Job> = {}): Job {
  return { ...createJob({ id, feature: `f ${id}`, repo: REPO, slot: 1, now: new Date('2026-11-26T09:00:00Z') }), ...over }
}

const running = (id: string, over: Partial<Job> = {}) =>
  job(id, { stage: 'build', waitingFor: null, waitingSince: null, planned: true, trip: 1, pr: 'https://github.com/o/r/pull/7', ...over })

describe('statusTable', () => {
  const jobs = [
    running('261126-csv-export'),
    job('261126-rate-limit', {
      stage: 'human-review', waitingFor: 'human-review', waitingSince: '2026-11-26T10:00:00Z', trip: 1,
      pr: 'https://github.com/o/r/pull/12',
    }),
    job('261125-done', { stage: 'done', waitingFor: null, waitingSince: null, pr: 'https://github.com/o/r/pull/3' }),
    job('261124-broken', {
      stage: 'needs-human', waitingFor: 'failure', waitingSince: '2026-11-26T11:57:00Z', trip: 2, reason: 'x',
      createdAt: '2026-11-22T12:00:00Z',
    }),
  ]

  test('rows waiting on the human come first, marked ●', () => {
    const lines = statusTable(jobs, NOW).split('\n')
    expect(lines[0]).toMatch(/^ {2}JOB +STAGE +TRIP +WAITING +PR +AGE$/)
    expect(lines.slice(1).map((l) => l.split(/\s+/).filter(Boolean)[l.startsWith('●') ? 1 : 0])).toEqual([
      '261126-rate-limit', '261124-broken', '261126-csv-export', '261125-done',
    ])
    expect(lines[1]).toStartWith('● 261126-rate-limit')
    expect(lines[2]).toStartWith('● 261124-broken')
    expect(lines[3]).toStartWith('  261126-csv-export')
  })

  test('cells: stage, trip, what it waits for and since when, PR number, age', () => {
    const lines = statusTable(jobs, NOW).split('\n')
    expect(lines[1].split(/\s{2,}/)).toEqual(['● 261126-rate-limit', 'human-review', '1', 'review 2h', '#12', '3h'])
    expect(lines[2].split(/\s{2,}/)).toEqual(['● 261124-broken', 'needs-human', '2', 'failure 3m', '-', '4d'])
    expect(lines[3].split(/\s{2,}/)).toEqual(['', '261126-csv-export', 'build', '1', '-', '#7', '3h'])
  })

  test('columns line up', () => {
    const lines = statusTable(jobs, NOW).split('\n')
    const at = lines[0].indexOf('STAGE')
    for (const l of lines.slice(1)) expect(l[at - 1]).toBe(' ')
    for (const l of lines.slice(1)) expect(l[at]).not.toBe(' ')
  })
})

describe('pipelineLine', () => {
  test('review job', () => {
    const j = running('261126-x', {
      stage: 'review',
      trips: [{
        cycle: 1, trip: 1, buildJudge: null, validations: {}, validationJudge: null,
        reviews: { product: 'PASS', code: 'CHANGES', security: 'PASS', ux: 'pending', ui: 'pending' },
      }],
    })
    expect(pipelineLine(j)).toBe('Discovery ✓ ─ Building ● review 3/5 ─ Validation ○ ─ Deploy ○')
  })

  test('the grill, a failure, done', () => {
    expect(pipelineLine(job('261126-x'))).toBe('Discovery ● requirements ─ Building ○ ─ Validation ○ ─ Deploy ○')
    const failed = job('261126-x', { stage: 'needs-human', waitingFor: 'failure', resumeStage: 'design', reason: 'boom' })
    expect(pipelineLine(failed)).toBe('Discovery ✗ design ─ Building ○ ─ Validation ○ ─ Deploy ○')
    expect(pipelineLine(job('261126-x', { stage: 'done', waitingFor: null }))).toBe('Discovery ✓ ─ Building ✓ ─ Validation ✓ ─ Deploy ✓')
  })

  test('the human-facing marker is gold, a running one cyan', () => {
    process.env.FORCE_COLOR = '1'
    expect(pipelineLine(job('261126-x', { stage: 'human-review', waitingFor: 'human-review' }))).toContain(paint('gold', '●'))
    expect(pipelineLine(running('261126-x'))).toContain(paint('cyan', '●'))
  })
})

describe('nextHint', () => {
  const id = '261126-x'
  test('each waiting state says what to type', () => {
    expect(nextHint(job(id))).toBe(`factory attach ${id}`)
    expect(nextHint(job(id, { stage: 'human-review', waitingFor: 'human-review' }))).toBe(
      `factory approve ${id}   or   factory feedback ${id} "…"`,
    )
    const judge = `${REPO}/.factory/jobs/${id}/trip-1/build-judge.md`
    expect(nextHint(job(id, { stage: 'needs-human', waitingFor: 'escalation', questionsFile: judge, reasonFile: judge }))).toBe(
      `factory approve ${id}   or   factory feedback ${id} "…"   (see .factory/jobs/${id}/trip-1/build-judge.md)`,
    )
    expect(nextHint(job(id, { stage: 'needs-human', waitingFor: 'failure', reason: 'boom' }))).toBe(
      `factory run ${id} to retry   or   factory discard ${id}`,
    )
    expect(nextHint(job(id, { stage: 'needs-human', waitingFor: 'escalation', capHit: 'env' }))).toBe(
      `factory run ${id} once QA is back   or   factory approve ${id}   or   factory discard ${id}`,
    )
  })

  test('a running job can be watched; a finished one needs nothing', () => {
    expect(nextHint(running(id))).toBe(`factory attach ${id} to watch`)
    expect(nextHint(job(id, { stage: 'done', waitingFor: null }))).toBeNull()
    expect(nextHint(job(id, { stage: 'discarded', waitingFor: null }))).toBeNull()
  })
})

describe('nextLines', () => {
  test('one line when it fits in 80 columns', () => {
    expect(nextLines('factory approve 261126-x   or   factory feedback 261126-x "…"')).toEqual([
      'next: factory approve 261126-x   or   factory feedback 261126-x "…"',
    ])
  })

  test('longer: one alternative per line, the file last, commands aligned', () => {
    const id = '261125-dark-mode-settings-page'
    const hint = `factory approve ${id}   or   factory feedback ${id} "…"   (see .factory/jobs/${id}/trip-2/build-judge.md)`
    expect(nextLines(hint)).toEqual([
      `next: factory approve ${id}`,
      `  or  factory feedback ${id} "…"`,
      `      (see .factory/jobs/${id}/trip-2/build-judge.md)`,
    ])
  })
})

describe('whatFor', () => {
  const id = '261126-x'
  test('says why the job waits, with repo-relative files', () => {
    expect(whatFor(job(id))).toBe('Answer the grill')
    expect(whatFor(job(id, { stage: 'human-review', waitingFor: 'human-review', pr: 'https://x/pull/1' }))).toBe('Review the PR: https://x/pull/1')
    expect(whatFor(job(id, { stage: 'needs-human', waitingFor: 'failure', reason: 'designer: exited with code 3' }))).toBe(
      'Failed: designer: exited with code 3',
    )
    const judge = `${REPO}/.factory/jobs/${id}/trip-1/build-judge.md`
    expect(whatFor(job(id, { stage: 'needs-human', waitingFor: 'escalation', questionsFile: judge }))).toBe(
      `A judge escalated; see .factory/jobs/${id}/trip-1/build-judge.md`,
    )
    expect(whatFor(job(id, { stage: 'needs-human', waitingFor: 'escalation' }))).toBe('A judge escalated')
    expect(whatFor(job(id, { stage: 'needs-human', waitingFor: 'escalation', capHit: 'env' }))).toBe(
      'QA env failed twice; see the validation files',
    )
    expect(whatFor(running(id))).toBeNull()
  })
})

describe('paint', () => {
  test('NO_COLOR: no escape codes anywhere', () => {
    const j = job('261126-x', { stage: 'human-review', waitingFor: 'human-review' })
    const out = [paint('gold', 'x'), statusTable([j], NOW), pipelineLine(j)].join('\n')
    expect(out).not.toContain('\x1b[')
  })

  test('FORCE_COLOR: each color wraps the text and resets', () => {
    process.env.FORCE_COLOR = '1'
    expect(paint('red', 'x')).toBe('\x1b[31mx\x1b[0m')
    expect(paint('bold', 'x')).toBe('\x1b[1mx\x1b[0m')
    for (const c of ['dim', 'green', 'yellow', 'gold', 'cyan'] as const) expect(paint(c, 'x')).toMatch(/^\x1b\[[\d;]+mx\x1b\[0m$/)
  })
})

test('ago', () => {
  expect(ago('2026-11-26T11:57:00Z', NOW)).toBe('3m')
  expect(ago('2026-11-26T10:00:00Z', NOW)).toBe('2h')
  expect(ago('2026-11-22T12:00:00Z', NOW)).toBe('4d')
  expect(ago('2026-11-26T11:59:50Z', NOW)).toBe('10s')
  expect(ago('2026-11-26T12:00:10Z', NOW)).toBe('0s')
  expect(ago('not a date', NOW)).toBe('-')
})
