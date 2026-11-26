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

/** A job written by factory v1: shown, never driven. */
export interface LegacyJob {
  legacy: true
  id: string
  feature: string
  stage: string
  pr: string | null
}

export function createJob(args: { id: string; feature: string; repo: string; slot: number; now: Date }): Job {
  const at = args.now.toISOString()
  return {
    version: 2,
    id: args.id,
    feature: args.feature,
    branch: `factory/${args.id}`,
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

export function loadJob(file: string): Job | LegacyJob {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (raw.version === 2) return raw as Job
  return {
    legacy: true,
    id: raw.id,
    feature: raw.feature ?? '',
    stage: raw.stage,
    pr: raw.pr ?? null,
  }
}

export function saveJob(file: string, job: Job, now: Date): void {
  job.updatedAt = now.toISOString()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`)
  renameSync(tmp, file)
}

export function listJobs(repo: string): (Job | LegacyJob)[] {
  const { jobsDir } = jobPaths(repo, '')
  if (!existsSync(jobsDir)) return []
  const jobs: (Job | LegacyJob)[] = []
  for (const name of readdirSync(jobsDir)) {
    const file = jobPaths(repo, name).jobFile
    if (existsSync(file)) jobs.push(loadJob(file))
  }
  const modern = jobs.filter((j): j is Job => !('legacy' in j))
  const legacy = jobs.filter((j) => 'legacy' in j)
  modern.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return [...modern, ...legacy]
}

export function appendActivity(file: string, line: string, now: Date): void {
  const hms = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${hms} ${line}\n`)
}

/** Lowest slot >= 1 not held by a job that is still alive. Legacy jobs never hold one. */
export function nextSlot(repo: string): number {
  const used = new Set<number>()
  for (const j of listJobs(repo)) {
    if ('legacy' in j || j.stage === 'done' || j.stage === 'discarded') continue
    used.add(j.slot)
  }
  let slot = 1
  while (used.has(slot)) slot++
  return slot
}
