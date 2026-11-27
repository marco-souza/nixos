import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { jobPaths } from './paths'

export type Stage =
  | 'requirements' | 'tech-discovery' | 'design' | 'discovery-review'
  | 'planning' | 'build' | 'review' | 'build-judge'
  | 'test-planning' | 'rebase' | 'qa-wait' | 'validation' | 'validation-judge'
  | 'human-review' | 'finalize' | 'done' | 'needs-human' | 'discarded'
export type WaitingFor = null | 'requirements' | 'human-review' | 'escalation' | 'failure'
export type CapHit = null | 'trips' | 'discovery' | 'env'

export interface TripRecord {
  cycle: number
  trip: number
  reviews: Record<string, string>
  buildJudge: string | null
  validations: Record<string, string>
  validationJudge: string | null
  /** Task ids whose builder landed READY in this trip, in order; build resume skips exactly these. */
  built?: string[]
}

export interface Job {
  version: 2
  id: string
  feature: string
  branch: string
  worktree: string
  slot: number
  stage: Stage
  cycle: number
  trip: number
  planned: boolean
  discoveryLoops: number
  extraDiscoveryLoops: number
  extraTrips: number
  envRetries: number
  waitingFor: WaitingFor
  waitingSince: string | null
  reason: string | null
  /** Why a job the human approved anyway had stopped, for the draft PR's Open section. Null in job.json files from before it. */
  stoppedReason: string | null
  resumeStage: Stage | null
  capHit: CapHit
  reasonFile: string | null
  questionsFile: string | null
  feedbackCount: number
  ready: boolean | null
  pr: string | null
  qaUrl: string | null
  running: string[]
  trips: TripRecord[]
  discovery: { n: number; verdict: string }[]
  createdAt: string
  updatedAt: string
}

export function createJob(args: { id: string; branch: string; feature: string; repo: string; slot: number; now: Date }): Job {
  const at = args.now.toISOString()
  return {
    version: 2,
    id: args.id,
    feature: args.feature,
    branch: args.branch,
    worktree: jobPaths(args.repo, args.id).worktree,
    slot: args.slot,
    stage: 'requirements',
    cycle: 1,
    trip: 0,
    planned: false,
    discoveryLoops: 0,
    extraDiscoveryLoops: 0,
    extraTrips: 0,
    envRetries: 0,
    waitingFor: 'requirements',
    waitingSince: at,
    reason: null,
    stoppedReason: null,
    resumeStage: null,
    capHit: null,
    reasonFile: null,
    questionsFile: null,
    feedbackCount: 0,
    ready: null,
    pr: null,
    qaUrl: null,
    running: [],
    trips: [],
    discovery: [],
    createdAt: at,
    updatedAt: at,
  }
}

/** Throws when the file is not JSON or not a v2 job. */
export function loadJob(file: string): Job {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (raw?.version !== 2) throw new Error(`${file}: not a factory v2 job`)
  return { ...raw, stoppedReason: raw.stoppedReason ?? null }
}

export function saveJob(file: string, job: Job, now: Date): void {
  job.updatedAt = now.toISOString()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`)
  renameSync(tmp, file)
}

/** Newest first. A job.json that can't be read, or isn't v2, is skipped. */
export function listJobs(repo: string): Job[] {
  const { jobsDir } = jobPaths(repo, '')
  if (!existsSync(jobsDir)) return []
  const jobs: Job[] = []
  for (const name of readdirSync(jobsDir)) {
    const file = jobPaths(repo, name).jobFile
    if (!existsSync(file)) continue
    try {
      jobs.push(loadJob(file))
    } catch {
      // A half-written or hand-edited job.json must not hide the other jobs.
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function appendActivity(file: string, line: string, now: Date): void {
  const hms = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${hms} ${line}\n`)
}

/** Slots held by jobs that are still alive (not done or discarded). */
export function heldSlots(repo: string): Set<number> {
  const used = new Set<number>()
  for (const j of listJobs(repo)) {
    if (j.stage === 'done' || j.stage === 'discarded') continue
    used.add(j.slot)
  }
  return used
}

/** Lowest slot >= 1 not held by a job that is still alive. */
export function nextSlot(repo: string): number {
  const used = heldSlots(repo)
  let slot = 1
  while (used.has(slot)) slot++
  return slot
}
