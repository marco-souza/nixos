import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendActivity, createJob, listJobs, loadJob, nextSlot, saveJob, type Job } from '../job'
import { jobPaths } from '../paths'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'factory-job-'))
})
afterEach(() => rm(repo, { recursive: true, force: true }))

const make = (id: string, slot: number, now: Date) => createJob({ id, feature: `f ${id}`, repo, slot, now })
const put = (job: Job, now = new Date(2026, 10, 26)) => saveJob(jobPaths(repo, job.id).jobFile, job, now)

describe('job state', () => {
  test('createJob starts in requirements, waiting on the grill', () => {
    const now = new Date(2026, 10, 26, 9)
    const job = make('261126-a', 1, now)
    expect(job).toMatchObject({
      version: 2, stage: 'requirements', waitingFor: 'requirements', cycle: 1, trip: 0, planned: false,
      branch: 'factory/261126-a', worktree: jobPaths(repo, '261126-a').worktree, slot: 1,
      running: [], trips: [], discovery: [], ready: null, pr: null, stoppedReason: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), waitingSince: now.toISOString(),
    })
  })

  test('save/load roundtrip', () => {
    const file = jobPaths(repo, '261126-a').jobFile
    const now = new Date(2026, 10, 26, 10)
    const job = make('261126-a', 1, new Date(2026, 10, 26, 9))
    saveJob(file, job, now)
    expect(loadJob(file)).toEqual({ ...job, updatedAt: now.toISOString() })
  })

  test('a v2 job.json from before stoppedReason loads with it null', () => {
    const file = jobPaths(repo, '261126-old').jobFile
    const { stoppedReason, ...old } = make('261126-old', 1, new Date(2026, 10, 26, 9))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(old))
    expect(stoppedReason).toBeNull()
    expect(loadJob(file)).toEqual({ ...old, stoppedReason: null } as Job)
  })

  test('saveJob leaves no .tmp file', () => {
    const p = jobPaths(repo, '261126-a')
    saveJob(p.jobFile, make('261126-a', 1, new Date()), new Date())
    expect(existsSync(`${p.jobFile}.tmp`)).toBe(false)
    expect(readdirSync(p.jobDir)).toEqual(['job.json'])
  })

  test('a v1 job.json (no version) does not load', () => {
    const p = jobPaths(repo, '003-rate-limiting')
    mkdirSync(p.jobDir, { recursive: true })
    writeFileSync(p.jobFile, '{"id":"003-rate-limiting","stage":"review"}')
    expect(() => loadJob(p.jobFile)).toThrow('not a factory v2 job')
  })

  test('listJobs orders newest first, skips v1 jobs and folders without job.json', () => {
    put(make('old', 1, new Date(2026, 10, 1)))
    put(make('new', 2, new Date(2026, 10, 20)))
    const p = jobPaths(repo, 'v1')
    mkdirSync(p.jobDir, { recursive: true })
    writeFileSync(p.jobFile, '{"id":"v1","stage":"done"}')
    mkdirSync(jobPaths(repo, 'empty').jobDir, { recursive: true })
    const jobs = listJobs(repo)
    expect(jobs.map((j) => j.id)).toEqual(['new', 'old'])
  })

  test('listJobs skips a job.json that is unparseable or not an object', () => {
    put(make('good', 1, new Date(2026, 10, 1)))
    for (const [id, text] of [['broken', '{"id": '], ['null', 'null'], ['array', '[1]'], ['string', '"x"']]) {
      const p = jobPaths(repo, id!)
      mkdirSync(p.jobDir, { recursive: true })
      writeFileSync(p.jobFile, text!)
    }
    expect(listJobs(repo).map((j) => j.id)).toEqual(['good'])
  })

  test('listJobs on a repo without .factory is empty', () => {
    expect(listJobs(repo)).toEqual([])
  })

  test('appendActivity formats HH:MM:SS', () => {
    const file = jobPaths(repo, 'a').activityLog
    appendActivity(file, 'spawn planner', new Date(2026, 10, 26, 9, 5, 7))
    appendActivity(file, 'done planner', new Date(2026, 10, 26, 9, 6, 0))
    expect(readFileSync(file, 'utf8')).toBe('09:05:07 spawn planner\n09:06:00 done planner\n')
  })

  test('nextSlot reuses slots of done/discarded jobs', () => {
    put({ ...make('a', 1, new Date(2026, 10, 1)), stage: 'done' })
    put({ ...make('b', 2, new Date(2026, 10, 2)), stage: 'build' })
    expect(nextSlot(repo)).toBe(1)
    put({ ...make('c', 1, new Date(2026, 10, 3)), stage: 'review' })
    expect(nextSlot(repo)).toBe(3)
  })

  test('nextSlot ignores v1 jobs and starts at 1', () => {
    expect(nextSlot(repo)).toBe(1)
    const p = jobPaths(repo, 'v1')
    mkdirSync(p.jobDir, { recursive: true })
    writeFileSync(p.jobFile, '{"id":"v1","stage":"build","slot":1}')
    expect(nextSlot(repo)).toBe(1)
  })
})
