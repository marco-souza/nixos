import { describe, expect, test } from 'bun:test'
import { createJob, type Job, type Stage, type TripRecord } from '../job'
import { applyCommand, CommandError, isWaiting, route, type Limits, type Outcome } from '../machine'

const ID = '261126-x'
const earlier = new Date('2026-11-26T09:00:00Z')
const now = new Date('2026-11-26T12:00:00Z')
const L: Limits = { maxTrips: 3, maxDiscoveryLoops: 3 }

/** A job in `stage`; stages other than requirements start with no wait. */
function job(o: Partial<Job> = {}): Job {
  const base = createJob({ id: ID, branch: `factory/${ID}`, base: 'main', feature: 'f', repo: '/repo', slot: 1, now: earlier })
  const waits = o.stage && o.stage !== 'requirements' ? { waitingFor: null, waitingSince: null } : {}
  return { ...base, ...waits, ...o }
}
const rec = (cycle: number, trip: number): TripRecord => ({
  cycle, trip, reviews: {}, buildJudge: null, validations: {}, validationJudge: null,
})
const done = (stage: Stage, extra: Partial<Extract<Outcome, { kind: 'done' }>> = {}): Outcome => ({ kind: 'done', stage, ...extra })
const inTrip = (o: Partial<Job>) => job({ planned: true, trip: 1, trips: [rec(1, 1)], ...o })

describe('route: linear stages', () => {
  test.each([
    ['requirements', 'preflight'],
    ['preflight', 'tech-discovery'],
    ['tech-discovery', 'design'],
    ['design', 'discovery-review'],
    ['build', 'review'],
    ['review', 'build-judge'],
    ['test-planning', 'rebase'],
    ['rebase', 'qa-wait'],
    ['qa-wait', 'validation'],
    ['validation', 'validation-judge'],
    ['finalize', 'done'],
  ] as [Stage, Stage][])('%s → %s', (from, to) => {
    const j = route(job({ stage: from }), done(from), L, now)
    expect(j).toMatchObject({ stage: to, waitingFor: null, waitingSince: null })
  })

  test('a report job goes from preflight to report, then to the human', () => {
    const r = route(job({ stage: 'preflight', deliverable: 'report' }), done('preflight'), L, now)
    expect(r).toMatchObject({ stage: 'report', waitingFor: null })
    expect(route(r, done('report'), L, now)).toMatchObject({ stage: 'human-review', waitingFor: 'human-review' })
  })

  test('planning done sets planned and goes to build', () => {
    const j = route(inTrip({ stage: 'planning', planned: false }), done('planning'), L, now)
    expect(j).toMatchObject({ stage: 'build', planned: true, trip: 1 })
  })
})

describe('route: discovery', () => {
  test('design with human questions goes back to requirements', () => {
    const j = route(job({ stage: 'design' }), done('design', { humanQuestions: true, questionsFile: '/design.md' }), L, now)
    expect(j).toMatchObject({
      stage: 'requirements', discoveryLoops: 1, waitingFor: 'requirements', waitingSince: now.toISOString(),
      questionsFile: '/design.md',
    })
    expect(j.discovery).toEqual([])
  })

  test('design questions at the cap go to needs-human, resuming in requirements', () => {
    const j = route(job({ stage: 'design', discoveryLoops: 2 }), done('design', { humanQuestions: true, questionsFile: '/design.md' }), L, now)
    expect(j).toMatchObject({
      stage: 'needs-human', waitingFor: 'failure', capHit: 'discovery', resumeStage: 'requirements',
      discoveryLoops: 3, questionsFile: '/design.md', reason: 'discovery loop cap (3) reached',
    })
  })

  test('PASS starts trip 1 with a new TripRecord', () => {
    const j = route(job({ stage: 'discovery-review', envRetries: 1 }), done('discovery-review', { verdict: 'PASS' }), L, now)
    expect(j).toMatchObject({ stage: 'planning', cycle: 1, trip: 1, envRetries: 0, waitingFor: null, discoveryLoops: 0 })
    expect(j.trips).toEqual([rec(1, 1)])
    expect(j.discovery).toEqual([{ n: 1, verdict: 'PASS' }])
  })

  test('REWORK goes to the named step without the human', () => {
    const j = route(job({ stage: 'discovery-review' }), done('discovery-review', { verdict: 'REWORK', reworkStep: 'tech-discovery' }), L, now)
    expect(j).toMatchObject({ stage: 'tech-discovery', discoveryLoops: 1, waitingFor: null, waitingSince: null })
    expect(j.discovery).toEqual([{ n: 1, verdict: 'REWORK' }])
  })

  test('REWORK without a step defaults to design', () => {
    const j = route(job({ stage: 'discovery-review' }), done('discovery-review', { verdict: 'REWORK' }), L, now)
    expect(j.stage).toBe('design')
  })

  test('ASK goes to requirements with the questions', () => {
    const prior = [{ n: 1, verdict: 'REWORK' }]
    const j = route(job({ stage: 'discovery-review', discoveryLoops: 1, discovery: prior }), done('discovery-review', { verdict: 'ASK', questionsFile: '/q' }), L, now)
    expect(j).toMatchObject({
      stage: 'requirements', discoveryLoops: 2, waitingFor: 'requirements', waitingSince: now.toISOString(), questionsFile: '/q',
    })
    expect(j.discovery).toEqual([...prior, { n: 2, verdict: 'ASK' }])
  })

  test('third non-PASS discovery review hits the cap', () => {
    const j = route(job({ stage: 'discovery-review', discoveryLoops: 2 }), done('discovery-review', { verdict: 'ASK', questionsFile: '/q' }), L, now)
    expect(j).toMatchObject({
      stage: 'needs-human', waitingFor: 'failure', capHit: 'discovery', resumeStage: 'requirements',
      discoveryLoops: 3, questionsFile: '/q', reason: 'discovery loop cap (3) reached', waitingSince: now.toISOString(),
    })
    expect(j.discovery).toEqual([{ n: 1, verdict: 'ASK' }])
  })

  test('REWORK at the cap resumes into the rework step', () => {
    const j = route(job({ stage: 'discovery-review', discoveryLoops: 2 }), done('discovery-review', { verdict: 'REWORK', reworkStep: 'tech-discovery' }), L, now)
    expect(j).toMatchObject({ stage: 'needs-human', capHit: 'discovery', resumeStage: 'tech-discovery' })
  })

  test('extra discovery loops raise the cap', () => {
    const ask = done('discovery-review', { verdict: 'ASK', questionsFile: '/q' })
    expect(route(job({ stage: 'discovery-review', discoveryLoops: 3, extraDiscoveryLoops: 1 }), ask, L, now))
      .toMatchObject({ stage: 'needs-human', discoveryLoops: 4, reason: 'discovery loop cap (4) reached' })
    expect(route(job({ stage: 'discovery-review', discoveryLoops: 2, extraDiscoveryLoops: 1 }), ask, L, now))
      .toMatchObject({ stage: 'requirements', discoveryLoops: 3 })
  })
})

describe('route: build-judge', () => {
  test('APPROVE goes to test-planning and records the verdict', () => {
    const j = route(inTrip({ stage: 'build-judge' }), done('build-judge', { verdict: 'APPROVE' }), L, now)
    expect(j).toMatchObject({ stage: 'test-planning', trip: 1 })
    expect(j.trips).toEqual([{ ...rec(1, 1), buildJudge: 'APPROVE' }])
  })

  test('CHANGES starts the next trip from planning', () => {
    const j = route(inTrip({ stage: 'build-judge', envRetries: 1 }), done('build-judge', { verdict: 'CHANGES', reasonFile: '/judge.md' }), L, now)
    expect(j).toMatchObject({ stage: 'planning', trip: 2, reasonFile: '/judge.md', envRetries: 0, waitingFor: null })
    expect(j.trips).toEqual([{ ...rec(1, 1), buildJudge: 'CHANGES' }, rec(1, 2)])
  })

  test('CHANGES at the trip cap goes to needs-human', () => {
    const trips = [rec(1, 1), rec(1, 2), rec(1, 3)]
    const j = route(inTrip({ stage: 'build-judge', trip: 3, trips }), done('build-judge', { verdict: 'CHANGES', reasonFile: '/judge.md' }), L, now)
    expect(j).toMatchObject({
      stage: 'needs-human', waitingFor: 'failure', capHit: 'trips', resumeStage: 'planning', trip: 3,
      reasonFile: '/judge.md', reason: 'trip cap (3) reached', waitingSince: now.toISOString(),
    })
    expect(j.trips).toEqual([rec(1, 1), rec(1, 2), { ...rec(1, 3), buildJudge: 'CHANGES' }])
  })

  test('extra trips raise the trip cap', () => {
    const changes = done('build-judge', { verdict: 'CHANGES', reasonFile: '/judge.md' })
    expect(route(inTrip({ stage: 'build-judge', trip: 3, extraTrips: 1 }), changes, L, now)).toMatchObject({ stage: 'planning', trip: 4 })
    expect(route(inTrip({ stage: 'build-judge', trip: 4, extraTrips: 1 }), changes, L, now))
      .toMatchObject({ stage: 'needs-human', capHit: 'trips', reason: 'trip cap (4) reached' })
  })

  test('ESCALATE pauses for the human without spending a trip', () => {
    const j = route(inTrip({ stage: 'build-judge' }), done('build-judge', { verdict: 'ESCALATE', reasonFile: '/judge.md', questionsFile: '/judge.md' }), L, now)
    expect(j).toMatchObject({
      stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'test-planning', trip: 1, capHit: null,
      reasonFile: '/judge.md', questionsFile: '/judge.md', waitingSince: now.toISOString(),
    })
    expect(j.trips).toEqual([{ ...rec(1, 1), buildJudge: 'ESCALATE' }])
  })
})

describe('route: validation-judge', () => {
  test('PASS goes to human-review', () => {
    const j = route(inTrip({ stage: 'validation-judge' }), done('validation-judge', { verdict: 'PASS' }), L, now)
    expect(j).toMatchObject({ stage: 'human-review', waitingFor: 'human-review', waitingSince: now.toISOString() })
    expect(j.trips).toEqual([{ ...rec(1, 1), validationJudge: 'PASS' }])
  })

  test('FAIL starts the next trip like CHANGES', () => {
    const j = route(inTrip({ stage: 'validation-judge', envRetries: 1 }), done('validation-judge', { verdict: 'FAIL', reasonFile: '/vj.md' }), L, now)
    expect(j).toMatchObject({ stage: 'planning', trip: 2, reasonFile: '/vj.md', envRetries: 0 })
    expect(j.trips).toEqual([{ ...rec(1, 1), validationJudge: 'FAIL' }, rec(1, 2)])
  })

  test('FAIL at the trip cap goes to needs-human', () => {
    const j = route(inTrip({ stage: 'validation-judge', trip: 3 }), done('validation-judge', { verdict: 'FAIL', reasonFile: '/vj.md' }), L, now)
    expect(j).toMatchObject({ stage: 'needs-human', waitingFor: 'failure', capHit: 'trips', resumeStage: 'planning', trip: 3, reasonFile: '/vj.md' })
  })

  test('first ENV waits for QA again without a trip', () => {
    const j = route(inTrip({ stage: 'validation-judge' }), done('validation-judge', { verdict: 'ENV' }), L, now)
    expect(j).toMatchObject({ stage: 'qa-wait', envRetries: 1, trip: 1, waitingFor: null })
    expect(j.trips).toEqual([{ ...rec(1, 1), validationJudge: 'ENV' }])
  })

  test('second ENV in a trip escalates to the human', () => {
    const j = route(inTrip({ stage: 'validation-judge', envRetries: 1 }), done('validation-judge', { verdict: 'ENV', reasonFile: '/vj.md' }), L, now)
    expect(j).toMatchObject({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'human-review', reasonFile: '/vj.md' })
  })

  test('second ENV marks the pause as an env cap without stale questions', () => {
    const j = route(
      inTrip({ stage: 'validation-judge', envRetries: 1, questionsFile: '/old-q.md' }),
      done('validation-judge', { verdict: 'ENV', reasonFile: '/vj.md' }), L, now,
    )
    expect(j).toMatchObject({ capHit: 'env', questionsFile: null })
  })

  test('ESCALATE pauses for the human, resuming in human-review', () => {
    const j = route(inTrip({ stage: 'validation-judge' }), done('validation-judge', { verdict: 'ESCALATE', reasonFile: '/vj.md', questionsFile: '/vj.md' }), L, now)
    expect(j).toMatchObject({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'human-review', trip: 1, questionsFile: '/vj.md' })
  })
})

describe('route: failures and guards', () => {
  test('failed goes to needs-human, resuming in the failed stage', () => {
    const j = route(inTrip({ stage: 'build' }), { kind: 'failed', stage: 'build', reason: 'builder-backend: STATUS: BLOCKED' }, L, now)
    expect(j).toMatchObject({
      stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build', reason: 'builder-backend: STATUS: BLOCKED',
      capHit: null, waitingSince: now.toISOString(),
    })
  })

  test('an unexpected verdict pauses for the human', () => {
    const j = route(inTrip({ stage: 'build-judge' }), done('build-judge', { verdict: 'MAYBE' }), L, now)
    expect(j).toMatchObject({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build-judge', reason: 'build-judge: unexpected verdict MAYBE' })
  })

  test('an outcome for another stage throws', () => {
    expect(() => route(job({ stage: 'build' }), done('review'), L, now)).toThrow('outcome for review but 261126-x is in build')
  })

  test('no outcome is expected while waiting', () => {
    expect(() => route(job({ stage: 'human-review' }), done('human-review'), L, now)).toThrow('no outcome expected in human-review')
  })

  test('route never mutates its input', () => {
    const cases: [Job, Outcome][] = [
      [inTrip({ stage: 'build-judge' }), done('build-judge', { verdict: 'CHANGES', reasonFile: '/j' })],
      [job({ stage: 'discovery-review' }), done('discovery-review', { verdict: 'PASS' })],
      [job({ stage: 'discovery-review', discoveryLoops: 2 }), done('discovery-review', { verdict: 'ASK', questionsFile: '/q' })],
      [inTrip({ stage: 'validation-judge' }), done('validation-judge', { verdict: 'ENV' })],
    ]
    for (const [input, o] of cases) {
      const before = structuredClone(input)
      expect(route(input, o, L, now)).not.toBe(input)
      expect(input).toEqual(before)
    }
  })
})

describe('applyCommand: approve', () => {
  test('human-review → finalize, ready', () => {
    const j = applyCommand(inTrip({ stage: 'human-review', waitingFor: 'human-review', waitingSince: earlier.toISOString() }), { kind: 'approve' }, now)
    expect(j).toMatchObject({ stage: 'finalize', ready: true, waitingFor: null, waitingSince: null })
  })

  test('an escalation resumes where the judge would have gone', () => {
    const esc = { stage: 'needs-human', waitingFor: 'escalation', waitingSince: earlier.toISOString() } as const
    expect(applyCommand(inTrip({ ...esc, resumeStage: 'test-planning' }), { kind: 'approve' }, now))
      .toMatchObject({ stage: 'test-planning', waitingFor: null, waitingSince: null, resumeStage: null, capHit: null, reason: null, stoppedReason: null })
    expect(applyCommand(inTrip({ ...esc, resumeStage: 'human-review' }), { kind: 'approve' }, now))
      .toMatchObject({ stage: 'human-review', waitingFor: 'human-review', waitingSince: now.toISOString(), resumeStage: null })
  })

  test('an env cap goes on to human-review', () => {
    const j = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'escalation', capHit: 'env', resumeStage: 'human-review', envRetries: 1 }),
      { kind: 'approve' }, now,
    )
    expect(j).toMatchObject({ stage: 'human-review', waitingFor: 'human-review', capHit: null, resumeStage: null })
  })

  test('any other needs-human → finalize, not ready', () => {
    const j = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'failure', capHit: 'trips', resumeStage: 'planning', reason: 'trip cap (3) reached' }),
      { kind: 'approve' }, now,
    )
    expect(j).toMatchObject({
      stage: 'finalize', ready: false, waitingFor: null, capHit: null, resumeStage: null, reason: null,
      stoppedReason: 'trip cap (3) reached',
    })
  })

  test('anything else has nothing to approve', () => {
    const run = () => applyCommand(job({ stage: 'build' }), { kind: 'approve' }, now)
    expect(run).toThrow(CommandError)
    expect(run).toThrow('nothing to approve: 261126-x is in build')
  })
})

describe('applyCommand: feedback', () => {
  test('a planned job starts a new cycle at planning, trip 1', () => {
    const j = applyCommand(
      inTrip({ stage: 'human-review', waitingFor: 'human-review', trip: 2, trips: [rec(1, 1), rec(1, 2)], ready: true, feedbackCount: 1 }),
      { kind: 'feedback', file: '/feedback-2.md' }, now,
    )
    expect(j).toMatchObject({
      stage: 'planning', cycle: 2, trip: 1, reasonFile: '/feedback-2.md', feedbackCount: 2, ready: null,
      waitingFor: null, waitingSince: null,
    })
    expect(j.trips).toEqual([rec(1, 1), rec(1, 2), rec(2, 1)])
  })

  test('an unplanned job starts a new cycle at requirements, trip 0', () => {
    const j = applyCommand(job({ stage: 'design' }), { kind: 'feedback', file: '/feedback-1.md' }, now)
    expect(j).toMatchObject({
      stage: 'requirements', cycle: 2, trip: 0, reasonFile: '/feedback-1.md', feedbackCount: 1, ready: null,
      waitingFor: 'requirements', waitingSince: now.toISOString(),
    })
    expect(j.trips).toEqual([])
  })

  test('a report job writes the report again in a new cycle', () => {
    const j = applyCommand(job({ stage: 'done', deliverable: 'report' }), { kind: 'feedback', file: '/feedback-1.md' }, now)
    expect(j).toMatchObject({ stage: 'report', cycle: 2, trip: 0, reasonFile: '/feedback-1.md', waitingFor: null })
  })

  test('feedback clears the wait it answers', () => {
    const j = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'test-planning', reason: 'x', capHit: null, questionsFile: '/judge.md' }),
      { kind: 'feedback', file: '/f.md' }, now,
    )
    expect(j).toMatchObject({ stage: 'planning', waitingFor: null, resumeStage: null, reason: null, capHit: null, questionsFile: null })
    const after = applyCommand(inTrip({ stage: 'done', stoppedReason: 'boom' }), { kind: 'feedback', file: '/f.md' }, now)
    expect(after.stoppedReason).toBeNull()
  })

  test('feedback resets the per-cycle counters', () => {
    const j = applyCommand(
      job({ stage: 'needs-human', waitingFor: 'failure', capHit: 'discovery', discoveryLoops: 4, extraDiscoveryLoops: 1, extraTrips: 2, envRetries: 1 }),
      { kind: 'feedback', file: '/f.md' }, now,
    )
    expect(j).toMatchObject({ discoveryLoops: 0, extraDiscoveryLoops: 0, extraTrips: 0, envRetries: 0, capHit: null })
  })

  test('a discarded job takes no feedback', () => {
    const run = () => applyCommand(job({ stage: 'discarded' }), { kind: 'feedback', file: '/f.md' }, now)
    expect(run).toThrow(CommandError)
    expect(run).toThrow('cannot send feedback: 261126-x is discarded')
  })
})

describe('applyCommand: retry', () => {
  test('a trip cap gets one more trip', () => {
    const trips = [rec(1, 1), rec(1, 2), rec(1, 3)]
    const j = applyCommand(
      inTrip({
        stage: 'needs-human', waitingFor: 'failure', capHit: 'trips', resumeStage: 'planning', reason: 'trip cap (3) reached',
        trip: 3, trips, reasonFile: '/judge.md', envRetries: 1,
      }),
      { kind: 'retry' }, now,
    )
    expect(j).toMatchObject({
      stage: 'planning', extraTrips: 1, trip: 4, envRetries: 0, reasonFile: '/judge.md',
      waitingFor: null, waitingSince: null, capHit: null, resumeStage: null, reason: null,
    })
    expect(j.trips).toEqual([...trips, rec(1, 4)])
  })

  test('a discovery cap gets one more loop, resuming where it would have gone', () => {
    const j = applyCommand(
      job({
        stage: 'needs-human', waitingFor: 'failure', capHit: 'discovery', resumeStage: 'requirements',
        reason: 'discovery loop cap (3) reached', discoveryLoops: 3, questionsFile: '/q',
      }),
      { kind: 'retry' }, now,
    )
    expect(j).toMatchObject({
      stage: 'requirements', extraDiscoveryLoops: 1, discoveryLoops: 3, questionsFile: '/q',
      waitingFor: 'requirements', waitingSince: now.toISOString(), capHit: null, resumeStage: null, reason: null,
    })
  })

  test('a failure resumes the failed stage', () => {
    const j = applyCommand(inTrip({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build', reason: 'boom' }), { kind: 'retry' }, now)
    expect(j).toMatchObject({ stage: 'build', trip: 1, waitingFor: null, resumeStage: null, reason: null, extraTrips: 0 })
    const fin = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'finalize', reason: 'gh down', stoppedReason: 'boom' }),
      { kind: 'retry' }, now,
    )
    expect(fin).toMatchObject({ stage: 'finalize', stoppedReason: null })
  })

  test('an env cap validates again in the same trip', () => {
    const trips = [rec(1, 1)]
    const j = applyCommand(
      inTrip({
        stage: 'needs-human', waitingFor: 'escalation', capHit: 'env', resumeStage: 'human-review',
        envRetries: 1, trips, reasonFile: '/vj.md',
      }),
      { kind: 'retry' }, now,
    )
    expect(j).toMatchObject({
      stage: 'qa-wait', envRetries: 0, trip: 1, waitingFor: null, waitingSince: null, capHit: null, resumeStage: null, reason: null,
    })
    expect(j.trips).toEqual(trips)
  })

  test('only a failure or an env cap can be retried', () => {
    const esc = () => applyCommand(inTrip({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'test-planning' }), { kind: 'retry' }, now)
    expect(esc).toThrow(CommandError)
    expect(esc).toThrow('nothing to retry: 261126-x is in needs-human waiting for escalation')
    expect(() => applyCommand(job({ stage: 'build' }), { kind: 'retry' }, now)).toThrow('nothing to retry: 261126-x is in build')
  })
})

describe('applyCommand: unblock', () => {
  test('a failure resumes the failed stage with the decision, in the same trip and cycle', () => {
    const j = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build', reason: 'blocked', decisions: ['/decision-1.md'] }),
      { kind: 'unblock', file: '/decision-2.md' }, now,
    )
    expect(j).toMatchObject({ stage: 'build', cycle: 1, trip: 1, waitingFor: null, reason: null, decisions: ['/decision-1.md', '/decision-2.md'] })
  })

  test('a trip cap gets one more trip, like retry', () => {
    const j = applyCommand(
      inTrip({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'planning', capHit: 'trips' }),
      { kind: 'unblock', file: '/decision-1.md' }, now,
    )
    expect(j).toMatchObject({ stage: 'planning', trip: 2, extraTrips: 1, decisions: ['/decision-1.md'] })
  })

  test('only what retry takes can be unblocked', () => {
    expect(() => applyCommand(job({ stage: 'build' }), { kind: 'unblock', file: '/d.md' }, now)).toThrow('nothing to retry: 261126-x is in build')
  })
})

describe('applyCommand: discard', () => {
  test.each(['requirements', 'build', 'needs-human', 'human-review', 'done'] as Stage[])('%s → discarded', (stage) => {
    const j = applyCommand(job({ stage }), { kind: 'discard' }, now)
    expect(j).toMatchObject({ stage: 'discarded', waitingFor: null, waitingSince: null })
  })

  test('a discarded job cannot be discarded again', () => {
    const run = () => applyCommand(job({ stage: 'discarded' }), { kind: 'discard' }, now)
    expect(run).toThrow(CommandError)
    expect(run).toThrow('nothing to discard: 261126-x is already discarded')
  })
})

describe('waits', () => {
  test.each([
    ['human-review', true], ['needs-human', true], ['done', true], ['discarded', true],
    ['requirements', true], ['tech-discovery', false], ['design', false], ['discovery-review', false],
    ['planning', false], ['build', false], ['review', false], ['build-judge', false], ['test-planning', false],
    ['rebase', false], ['qa-wait', false], ['validation', false], ['validation-judge', false], ['finalize', false],
  ] as [Stage, boolean][])('isWaiting(%s) is %p', (stage, waiting) => {
    expect(isWaiting(job({ stage }))).toBe(waiting)
  })

  test('waitingSince is kept while the job keeps waiting on the same thing', () => {
    const j = applyCommand(job({ stage: 'requirements' }), { kind: 'feedback', file: '/f.md' }, now)
    expect(j).toMatchObject({ stage: 'requirements', waitingFor: 'requirements', waitingSince: earlier.toISOString() })
  })

  test('applyCommand never mutates its input', () => {
    const input = inTrip({ stage: 'needs-human', waitingFor: 'failure', capHit: 'trips', resumeStage: 'planning', trip: 3, trips: [rec(1, 3)] })
    const before = structuredClone(input)
    expect(applyCommand(input, { kind: 'retry' }, now)).not.toBe(input)
    expect(applyCommand(input, { kind: 'feedback', file: '/f.md' }, now)).not.toBe(input)
    expect(input).toEqual(before)
  })
})
