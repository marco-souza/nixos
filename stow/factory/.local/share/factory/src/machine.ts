import type { Job, Stage, TripRecord, WaitingFor } from './job'

export type Outcome =
  | { kind: 'done'; stage: Stage; verdict?: string; reworkStep?: 'tech-discovery' | 'design'; humanQuestions?: boolean; reasonFile?: string; questionsFile?: string }
  | { kind: 'failed'; stage: Stage; reason: string }
export type Command = { kind: 'approve' } | { kind: 'feedback'; file: string } | { kind: 'retry' } | { kind: 'discard' }
export class CommandError extends Error {}
export interface Limits { maxTrips: number; maxDiscoveryLoops: number }

type Done = Extract<Outcome, { kind: 'done' }>

/** Stages whose `done` always leads to the same next stage. */
const NEXT: Partial<Record<Stage, Stage>> = {
  requirements: 'tech-discovery',
  'tech-discovery': 'design',
  design: 'discovery-review',
  planning: 'build',
  build: 'review',
  review: 'build-judge',
  'test-planning': 'rebase',
  rebase: 'qa-wait',
  'qa-wait': 'validation',
  validation: 'validation-judge',
  finalize: 'done',
}

/** Stages the driver stops at. `requirements` is not one: the driver runs the grill. */
const WAITING: Stage[] = ['human-review', 'needs-human', 'done', 'discarded']

export function isWaiting(job: Job): boolean {
  return WAITING.includes(job.stage)
}

/** The next job after `o`, the outcome of the job's current stage. */
export function route(job: Job, o: Outcome, limits: Limits, now: Date): Job {
  if (o.stage !== job.stage) throw new Error(`outcome for ${o.stage} but ${job.id} is in ${job.stage}`)
  return stamp(job, next(job, o, limits), now)
}

/** The job after a human command; throws CommandError when the command doesn't apply. */
export function applyCommand(job: Job, c: Command, now: Date): Job {
  return stamp(job, command(job, c), now)
}

function next(job: Job, o: Outcome, limits: Limits): Job {
  if (o.kind === 'failed') return needsHuman(job, 'failure', o.stage, { reason: o.reason })
  switch (o.stage) {
    case 'design':
      if (o.humanQuestions) return discoveryLoop(job, 'requirements', { questionsFile: o.questionsFile ?? null }, limits)
      break
    case 'discovery-review':
      return discoveryReview(job, o, limits)
    case 'planning':
      return goTo(job, 'build', { planned: true })
    case 'build-judge':
      return buildJudge(job, o, limits)
    case 'validation-judge':
      return validationJudge(job, o, limits)
  }
  const to = NEXT[o.stage]
  if (!to) throw new Error(`no outcome expected in ${o.stage}`)
  return goTo(job, to)
}

function discoveryReview(job: Job, o: Done, limits: Limits): Job {
  const discovery = [...job.discovery, { n: job.discovery.length + 1, verdict: o.verdict ?? '' }]
  switch (o.verdict) {
    case 'PASS':
      return goTo(job, 'planning', { discovery, ...newTrip(job.trips, job.cycle, 1) })
    case 'REWORK':
      return discoveryLoop(job, o.reworkStep ?? 'design', { discovery }, limits)
    case 'ASK':
      return discoveryLoop(job, 'requirements', { discovery, questionsFile: o.questionsFile ?? null }, limits)
  }
  return unexpected(job, o)
}

function buildJudge(job: Job, o: Done, limits: Limits): Job {
  const trips = recordVerdict(job, { buildJudge: o.verdict ?? null })
  switch (o.verdict) {
    case 'APPROVE':
      return goTo(job, 'test-planning', { trips })
    case 'CHANGES':
      return nextTrip(job, trips, o, limits)
    case 'ESCALATE':
      return needsHuman(job, 'escalation', 'test-planning', { trips, ...judgeFiles(job, o) })
  }
  return unexpected(job, o)
}

function validationJudge(job: Job, o: Done, limits: Limits): Job {
  const trips = recordVerdict(job, { validationJudge: o.verdict ?? null })
  switch (o.verdict) {
    case 'PASS':
      return goTo(job, 'human-review', { trips })
    case 'FAIL':
      return nextTrip(job, trips, o, limits)
    case 'ENV':
      // One ENV retry per trip: wait for QA again and re-run validation, then pause.
      if (job.envRetries < 1) return goTo(job, 'qa-wait', { trips, envRetries: job.envRetries + 1 })
      return needsHuman(job, 'escalation', 'human-review', { trips, capHit: 'env', reasonFile: o.reasonFile ?? job.reasonFile, questionsFile: null })
    case 'ESCALATE':
      return needsHuman(job, 'escalation', 'human-review', { trips, ...judgeFiles(job, o) })
  }
  return unexpected(job, o)
}

/** ASK, REWORK and designer questions share one cap, raised by each discovery retry. */
function discoveryLoop(job: Job, to: Stage, patch: Partial<Job>, limits: Limits): Job {
  const discoveryLoops = job.discoveryLoops + 1
  const cap = limits.maxDiscoveryLoops + job.extraDiscoveryLoops
  if (discoveryLoops >= cap) {
    return needsHuman(job, 'failure', to, { ...patch, discoveryLoops, capHit: 'discovery', reason: `discovery loop cap (${cap}) reached` })
  }
  return goTo(job, to, { ...patch, discoveryLoops })
}

/** CHANGES or FAIL: back to planning for another trip, unless the trip cap is reached. */
function nextTrip(job: Job, trips: TripRecord[], o: Done, limits: Limits): Job {
  const reasonFile = o.reasonFile ?? job.reasonFile
  const cap = limits.maxTrips + job.extraTrips
  if (job.trip >= cap) {
    return needsHuman(job, 'failure', 'planning', { trips, reasonFile, capHit: 'trips', reason: `trip cap (${cap}) reached` })
  }
  return goTo(job, 'planning', { reasonFile, ...newTrip(trips, job.cycle, job.trip + 1) })
}

function unexpected(job: Job, o: Done): Job {
  return needsHuman(job, 'failure', o.stage, { reason: `${o.stage}: unexpected verdict ${o.verdict ?? 'none'}` })
}

function command(job: Job, c: Command): Job {
  const cleared = { capHit: null, reason: null, resumeStage: null }
  switch (c.kind) {
    case 'approve':
      if (job.stage === 'human-review') return goTo(job, 'finalize', { ...cleared, ready: true })
      if (job.stage !== 'needs-human') throw new CommandError(`nothing to approve: ${job.id} is in ${job.stage}`)
      // Approving an escalation goes on as if the judge had approved.
      if (job.waitingFor === 'escalation') return goTo(job, resumeStage(job), cleared)
      return goTo(job, 'finalize', { ...cleared, ready: false, stoppedReason: job.reason })
    case 'feedback': {
      if (job.stage === 'discarded') throw new CommandError(`cannot send feedback: ${job.id} is discarded`)
      // A new cycle: its caps start over.
      const cycle = job.cycle + 1
      const patch: Partial<Job> = {
        ...cleared, cycle, reasonFile: c.file, questionsFile: null, feedbackCount: job.feedbackCount + 1, ready: null,
        stoppedReason: null, envRetries: 0, extraTrips: 0, discoveryLoops: 0, extraDiscoveryLoops: 0,
      }
      if (job.planned) return goTo(job, 'planning', { ...patch, ...newTrip(job.trips, cycle, 1) })
      return goTo(job, 'requirements', { ...patch, trip: 0 })
    }
    case 'retry': {
      if (job.stage !== 'needs-human' || (job.waitingFor !== 'failure' && job.capHit !== 'env')) {
        const waiting = job.stage === 'needs-human' ? ` waiting for ${job.waitingFor}` : ''
        throw new CommandError(`nothing to retry: ${job.id} is in ${job.stage}${waiting}`)
      }
      // Retrying clears what an earlier approval of a failure recorded.
      const fresh = { ...cleared, stoppedReason: null }
      // QA is back: wait for it and validate again, in the same trip.
      if (job.capHit === 'env') return goTo(job, 'qa-wait', { ...fresh, envRetries: 0 })
      if (job.capHit === 'trips') {
        return goTo(job, 'planning', { ...fresh, extraTrips: job.extraTrips + 1, ...newTrip(job.trips, job.cycle, job.trip + 1) })
      }
      const to = resumeStage(job)
      if (job.capHit === 'discovery') return goTo(job, to, { ...fresh, extraDiscoveryLoops: job.extraDiscoveryLoops + 1 })
      return goTo(job, to, fresh)
    }
    case 'discard':
      if (job.stage === 'discarded') throw new CommandError(`nothing to discard: ${job.id} is already discarded`)
      return goTo(job, 'discarded')
  }
}

/** Moves to `stage`, waiting on what that stage waits on. */
function goTo(job: Job, stage: Stage, patch: Partial<Job> = {}): Job {
  return { ...job, stage, waitingFor: waitsOn(stage), ...patch }
}

function waitsOn(stage: Stage): WaitingFor {
  if (stage === 'requirements') return 'requirements'
  if (stage === 'human-review') return 'human-review'
  return null
}

function needsHuman(job: Job, waitingFor: 'failure' | 'escalation', resumeStage: Stage, patch: Partial<Job> = {}): Job {
  return { ...job, stage: 'needs-human', waitingFor, resumeStage, capHit: null, reason: null, ...patch }
}

function resumeStage(job: Job): Stage {
  if (!job.resumeStage) throw new CommandError(`nothing to resume: ${job.id} has no resume stage`)
  return job.resumeStage
}

/** Starts trip `trip` of `cycle`; each trip gets one ENV retry. */
function newTrip(trips: TripRecord[], cycle: number, trip: number): Partial<Job> {
  const record: TripRecord = { cycle, trip, reviews: {}, buildJudge: null, validations: {}, validationJudge: null }
  return { cycle, trip, envRetries: 0, trips: [...trips, record] }
}

/** The trips with `patch` applied to the current trip's record. */
function recordVerdict(job: Job, patch: Partial<TripRecord>): TripRecord[] {
  return job.trips.map((t) => (t.cycle === job.cycle && t.trip === job.trip ? { ...t, ...patch } : t))
}

/** An escalating judge's file holds both its reasons and its questions. */
function judgeFiles(job: Job, o: Done): Partial<Job> {
  return { reasonFile: o.reasonFile ?? job.reasonFile, questionsFile: o.questionsFile ?? null }
}

/** `waitingSince` restarts when the job starts waiting on something new, and is null when it waits on nothing. */
function stamp(prev: Job, next: Job, now: Date): Job {
  if (next.waitingFor === null) return { ...next, waitingSince: null }
  const same = next.waitingFor === prev.waitingFor && next.stage === prev.stage
  return { ...next, waitingSince: same ? prev.waitingSince : now.toISOString() }
}
