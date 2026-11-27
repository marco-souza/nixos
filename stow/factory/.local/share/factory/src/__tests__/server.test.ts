import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deps } from '../deps'
import { realExec } from '../exec'
import { Git, GitHub } from '../git'
import { createJob, loadJob, saveJob, type Job } from '../job'
import { acquireLock } from '../lock'
import { jobPaths } from '../paths'
import { startServer } from '../server'
import type { Spawner } from '../spawn'
import { FakeExec } from './helpers'

const NOW = new Date(2026, 10, 26, 12, 0, 0)
const STAGES = ['requirements', 'build', 'human-review', 'needs-human', 'done'] as const
const ID = '261126-human-review'

class RecordingSpawner implements Spawner {
  calls: string[][] = []
  async ensureSession() {}
  async start() {}
  async isAlive() {
    return false
  }
  async kill(jobId: string, window: string) {
    this.calls.push(['kill', jobId, window])
  }
  async killAgents(jobId: string) {
    this.calls.push(['killAgents', jobId])
  }
  async killSession(jobId: string) {
    this.calls.push(['killSession', jobId])
  }
  async respawnDriver(jobId: string, _cwd: string, cmd: string) {
    this.calls.push(['respawnDriver', jobId, cmd])
  }
}

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
beforeEach(() => {
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
})
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-server-')))
  cleanups.push(() => rm(repo, { recursive: true, force: true }))
  await realExec.run(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
  const spawner = new RecordingSpawner()
  const log: string[] = []
  const deps: Deps = {
    exec: new FakeExec(),
    spawner,
    git: new Git(realExec, repo),
    gh: new GitHub(new FakeExec(), repo),
    rolesDir: '',
    notify: async () => {},
    now: () => NOW,
    sleep: async () => {},
    log: (l) => log.push(l),
  }
  const server = startServer(repo, deps, { port: 0 })
  cleanups.push(() => server.stop(true))
  const base = `http://127.0.0.1:${server.port}`
  const save = (id: string, patch: Partial<Job> = {}) => {
    const paths = jobPaths(repo, id)
    saveJob(paths.jobFile, { ...createJob({ id, feature: `feature ${id}`, repo, slot: 1, now: NOW }), ...patch }, NOW)
    return paths
  }
  for (const stage of STAGES) save(`261126-${stage}`, { stage, ...(stage === 'human-review' ? { waitingFor: 'human-review' as const } : {}) })
  // A v1 job: no `version`.
  const v1 = jobPaths(repo, 'old-job')
  mkdirSync(v1.jobDir, { recursive: true })
  writeFileSync(v1.jobFile, JSON.stringify({ id: 'old-job', feature: 'old', stage: 'build' }))
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers })
  const post = (path: string, body?: unknown, headers: Record<string, string> = { 'x-factory': '1' }) =>
    fetch(base + path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { repo, deps, spawner, server, base, save, get, post, paths: jobPaths(repo, ID) }
}

describe('dashboard server', () => {
  test('binds 127.0.0.1 and serves dashboard.html', async () => {
    const t = await setup()
    expect(t.server.hostname).toBe('127.0.0.1')
    const res = await t.get('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/<title>Software Factory – factory-server-\w+<\/title>/)
  })

  test('serves a placeholder page when the html file is missing', async () => {
    const t = await setup()
    const server = startServer(t.repo, t.deps, { port: 0, htmlFile: join(t.repo, 'missing.html') })
    cleanups.push(() => server.stop(true))
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toContain('Factory dashboard: UI not built yet')
  })

  test('/ fills {{PROJECT}} with the escaped repo folder name', async () => {
    const t = await setup()
    const htmlFile = join(t.repo, 'page.html')
    writeFileSync(htmlFile, '<h1>{{PROJECT}}</h1>')
    const server = startServer(t.repo, t.deps, { port: 0, htmlFile })
    cleanups.push(() => server.stop(true))
    const body = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    expect(body).toMatch(/^<h1>factory-server-\w+<\/h1>$/)
  })

  test('lists jobs including legacy', async () => {
    const t = await setup()
    const res = await t.get('/api/jobs')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { project: string; jobs: { id: string; legacy?: boolean; stage: string }[]; now: string }
    expect(body.project).toMatch(/^factory-server-/)
    expect(body.now).toBe(NOW.toISOString())
    expect(body.jobs.map((j) => j.stage).sort()).toEqual([...STAGES, 'build'].sort())
    expect(body.jobs.filter((j) => j.legacy).map((j) => j.id)).toEqual(['old-job'])
  })

  test('job detail lists docs, trips, logs and activity', async () => {
    const t = await setup()
    writeFileSync(join(t.paths.jobDir, 'activity.log'), Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n')
    for (const [n, f] of [[10, 'build.md'], [2, 'review-code.md'], [2, 'build.md']] as const) {
      mkdirSync(join(t.paths.jobDir, `trip-${n}`), { recursive: true })
      writeFileSync(join(t.paths.jobDir, `trip-${n}`, f), 'x')
    }
    mkdirSync(t.paths.logsDir, { recursive: true })
    writeFileSync(join(t.paths.logsDir, 'planner-1.log'), '')
    writeFileSync(join(t.paths.logsDir, 'builder-general-1.log'), '')
    utimesSync(join(t.paths.logsDir, 'planner-1.log'), 1000, 1000)
    mkdirSync(join(t.paths.worktree, 'docs/specs'), { recursive: true })
    writeFileSync(join(t.paths.worktree, 'docs/specs', `${ID}.md`), '# spec\n')
    const d = (await (await t.get(`/api/jobs/${ID}`)).json()) as any
    expect(d.job.id).toBe(ID)
    expect(d.docs.map((x: any) => x.name)).toEqual(['requirements', 'tech discovery', 'design', 'spec', 'test plan'])
    expect(d.docs.find((x: any) => x.name === 'spec')).toEqual({ name: 'spec', path: `docs/specs/${ID}.md`, exists: true })
    expect(d.docs.find((x: any) => x.name === 'design').exists).toBe(false)
    expect(d.trips).toEqual([
      { trip: 2, files: ['trip-2/build.md', 'trip-2/review-code.md'] },
      { trip: 10, files: ['trip-10/build.md'] },
    ])
    expect(d.logs).toEqual(['builder-general-1', 'planner-1'])
    expect(d.activity).toHaveLength(200)
    expect(d.activity.at(-1)).toBe('line 249')
  })

  test('unknown or malformed job ids are 404', async () => {
    const t = await setup()
    expect((await t.get('/api/jobs/nope')).status).toBe(404)
    expect((await t.get('/api/jobs/..%2F..')).status).toBe(404)
    expect((await t.get('/api/jobs/.hidden')).status).toBe(404)
  })

  describe('file endpoint', () => {
    test('rejects traversal', async () => {
      const t = await setup()
      for (const p of ['../../../../etc/passwd', '/etc/passwd', '../../jobs/old-job/job.json', '']) {
        expect((await t.get(`/api/jobs/${ID}/file?path=${encodeURIComponent(p)}`)).status).toBe(403)
      }
    })

    test('serves job files and worktree docs, 404 when missing', async () => {
      const t = await setup()
      mkdirSync(join(t.paths.worktree, 'docs/specs'), { recursive: true })
      writeFileSync(join(t.paths.worktree, 'docs/specs', `${ID}.md`), '# spec\n')
      mkdirSync(join(t.paths.jobDir, 'trip-1'), { recursive: true })
      writeFileSync(join(t.paths.jobDir, 'trip-1/build.md'), 'STATUS: READY\n')
      const doc = await t.get(`/api/jobs/${ID}/file?path=docs/specs/${ID}.md`)
      expect(doc.status).toBe(200)
      expect(doc.headers.get('content-type')).toStartWith('text/plain')
      expect(await doc.text()).toBe('# spec\n')
      expect(await (await t.get(`/api/jobs/${ID}/file?path=trip-1/build.md`)).text()).toBe('STATUS: READY\n')
      expect((await t.get(`/api/jobs/${ID}/file?path=docs/specs/missing.md`)).status).toBe(404)
      expect((await t.get(`/api/jobs/${ID}/file?path=trip-1`)).status).toBe(404)
    })

    test('refuses worktree files outside docs/', async () => {
      const t = await setup()
      mkdirSync(t.paths.worktree, { recursive: true })
      writeFileSync(join(t.paths.worktree, 'secret.txt'), 's')
      expect((await t.get(`/api/jobs/${ID}/file?path=secret.txt`)).status).toBe(403)
    })

    test('refuses a symlink that leaves the allowed folders', async () => {
      const t = await setup()
      const outside = join(t.repo, 'outside.txt')
      writeFileSync(outside, 'secret')
      mkdirSync(join(t.paths.worktree, 'docs'), { recursive: true })
      symlinkSync(outside, join(t.paths.worktree, 'docs', 'link.md'))
      symlinkSync(outside, join(t.paths.jobDir, 'link.md'))
      expect((await t.get(`/api/jobs/${ID}/file?path=docs/link.md`)).status).toBe(403)
      expect((await t.get(`/api/jobs/${ID}/file?path=link.md`)).status).toBe(403)
    })
  })

  describe('log endpoint', () => {
    const claude = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
      JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'hello there' }] } }),
    ].join('\n') + '\n'

    test('formats without colors', async () => {
      const t = await setup()
      process.env.FORCE_COLOR = '1'
      mkdirSync(t.paths.logsDir, { recursive: true })
      writeFileSync(join(t.paths.logsDir, 'planner-1.log'), claude + 'plain line\n')
      const res = await t.get(`/api/jobs/${ID}/log?name=planner-1`)
      const { lines } = (await res.json()) as { lines: string[] }
      expect(lines.join('\n')).toContain('hello there')
      expect(lines).toContain('plain line')
      expect(lines.join('\n')).not.toContain('\x1b')
      const one = (await (await t.get(`/api/jobs/${ID}/log?name=planner-1&lines=1`)).json()) as { lines: string[] }
      expect(one.lines).toEqual(['plain line'])
    })

    test('only names from the log list', async () => {
      const t = await setup()
      mkdirSync(t.paths.logsDir, { recursive: true })
      writeFileSync(join(t.paths.logsDir, 'planner-1.log'), 'x\n')
      for (const n of ['../job', '../../job.json', 'nope', '']) {
        expect((await t.get(`/api/jobs/${ID}/log?name=${encodeURIComponent(n)}`)).status).toBe(404)
      }
    })
  })

  describe('POST', () => {
    test('without X-Factory is 403', async () => {
      const t = await setup()
      expect((await t.post(`/api/jobs/${ID}/approve`, undefined, {})).status).toBe(403)
      expect((loadJob(t.paths.jobFile) as Job).stage).toBe('human-review')
    })

    test('with a foreign Origin is 403, with the real origin is allowed', async () => {
      const t = await setup()
      const bad = await t.post(`/api/jobs/${ID}/approve`, undefined, { 'x-factory': '1', origin: 'http://evil.example' })
      expect(bad.status).toBe(403)
      const wrongPort = await t.post(`/api/jobs/${ID}/approve`, undefined, { 'x-factory': '1', origin: 'http://127.0.0.1:1' })
      expect(wrongPort.status).toBe(403)
      expect((loadJob(t.paths.jobFile) as Job).stage).toBe('human-review')
      const ok = await t.post(`/api/jobs/${ID}/approve`, undefined, { 'x-factory': '1', origin: t.base })
      expect(ok.status).toBe(200)
    })

    test('approve on a human-review job returns finalize and restarts the driver', async () => {
      const t = await setup()
      const res = await t.post(`/api/jobs/${ID}/approve`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { job: Job }).job.stage).toBe('finalize')
      expect(t.spawner.calls.map((c) => c[0])).toEqual(['respawnDriver'])
    })

    test('approve on a build job returns 400 with the CommandError message', async () => {
      const t = await setup()
      const res = await t.post('/api/jobs/261126-build/approve')
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'nothing to approve: 261126-build is in build' })
    })

    test('retry while the driver lock is held returns 409', async () => {
      const t = await setup()
      const id = '261126-needs-human'
      const paths = t.save(id, { stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build' })
      const release = acquireLock(paths.jobDir)
      cleanups.push(release)
      const res = await t.post(`/api/jobs/${id}/retry`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toContain('driver already running')
      expect((loadJob(paths.jobFile) as Job).stage).toBe('needs-human')
      release()
      expect((await t.post(`/api/jobs/${id}/retry`)).status).toBe(200)
    })

    test('feedback with no note and no comments is 400', async () => {
      const t = await setup()
      const res = await t.post(`/api/jobs/${ID}/feedback`, { note: '  ' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'nothing new to send' })
    })

    test('feedback with a note starts a new cycle', async () => {
      const t = await setup()
      const res = await t.post(`/api/jobs/${ID}/feedback`, { note: 'make it blue' })
      expect(res.status).toBe(200)
      const { job } = (await res.json()) as { job: Job }
      expect(job.feedbackCount).toBe(1)
      expect(t.spawner.calls.map((c) => c[0])).toEqual(['kill', 'killAgents', 'respawnDriver'])
    })

    test('feedback with a bad body is 400', async () => {
      const t = await setup()
      const res = await fetch(`${t.base}/api/jobs/${ID}/feedback`, { method: 'POST', headers: { 'x-factory': '1' }, body: 'not json' })
      expect(res.status).toBe(400)
    })

    test('discard does not prompt and marks the job discarded', async () => {
      const t = await setup()
      const res = await t.post(`/api/jobs/${ID}/discard`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { job: Job }).job.stage).toBe('discarded')
      expect(t.spawner.calls).toContainEqual(['killSession', ID])
    })

    test('a legacy job cannot be driven', async () => {
      const t = await setup()
      const res = await t.post('/api/jobs/old-job/approve')
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('v1 job')
    })

    test('GET on an action and POST on a read route are 405', async () => {
      const t = await setup()
      expect((await t.get(`/api/jobs/${ID}/approve`)).status).toBe(405)
      expect((await t.post(`/api/jobs/${ID}/file`)).status).toBe(405)
      expect((await t.post(`/api/jobs/${ID}/bogus`)).status).toBe(404)
    })
  })

  test('a foreign Origin is refused on GET too', async () => {
    const t = await setup()
    expect((await t.get('/api/jobs', { origin: 'http://evil.example' })).status).toBe(403)
  })
})
