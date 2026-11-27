import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { makeDeps, type Deps } from '../deps'
import { driverCommand, REQUIRED_ROLES, runJob } from '../driver'
import { realExec, type Exec, type ExecResult } from '../exec'
import { Git, GitHub } from '../git'
import { createJob, loadJob, saveJob, type Job, type Stage } from '../job'
import { acquireLock, LockError } from '../lock'
import { applyCommand } from '../machine'
import { CLI_PATH, jobPaths } from '../paths'
import { InlineSpawner, TmuxSpawner, writeRunScript, type SpawnRequest, type Spawner } from '../spawn'
import { tempRepo } from './helpers'

const ROLES = join(import.meta.dir, 'fixtures', 'roles')
const ID = '261126-x'
const PR = 'https://github.com/o/r/pull/1'

const SPEC = `# Spec

## Acceptance criteria
1. It works.
2. It is fast.

## Tasks
### T1 Backend
Specialist: backend
### T2 Frontend
Specialist: frontend

Lenses: product, code, security

## Run
T1, T2
`

/** A valid output for each role. */
function canned(role: string, task: string, output: string): string {
  if (role === 'requirements') return '# Req\n\n## Intent\nx\n\n## Requirements\nx\n\n## Decisions\nx\n'
  if (role === 'tech-discoverer') return '## Findings\nx\n\n## Risks\nx\n'
  if (role === 'designer') return '## Approach\nx\n\n## Alternatives\nx\n\n## Questions for the human\nNone\n'
  if (role === 'planner') return SPEC
  if (role.startsWith('builder-')) {
    const id = /^Assignment: Task (T\d+)/m.exec(task)![1]
    const rest = existsSync(output) ? readFileSync(output, 'utf8').split('\n').slice(1).join('\n') : '# Build\n'
    return `STATUS: READY\n${rest}\n## ${id}\nDone.\n`
  }
  if (role === 'build-judge') return 'VERDICT: APPROVE\n'
  if (role === 'test-planner') return '## Cases\n- one\n\nValidators: e2e, user\n'
  if (role === 'resolver') return 'STATUS: READY\n'
  if (role === 'summarizer') return '# Add the thing\n\nIt adds the thing.\n'
  return 'VERDICT: PASS\n' // discovery-reviewer, reviewers, validators, validation-judge
}

/** One spawn of a role: `output: null` writes nothing, `hang` never finishes. */
type Step = { output?: string | null; exit?: number; hang?: boolean }

/** Writes each role's output when started and its done file the first time the driver polls the window. */
class FakeSpawner implements Spawner {
  requests: SpawnRequest[] = []
  private started = 0
  private counts: Record<string, number> = {}
  private pending = new Map<string, { req: SpawnRequest; step: Step }>()
  /** The k-th start (1-based) throws, like a failing `tmux new-window`. */
  failStart = 0
  constructor(private events: string[], private script: Record<string, Step[]> = {}) {}

  async ensureSession(): Promise<void> {}

  async start(req: SpawnRequest): Promise<void> {
    if (++this.started === this.failStart) throw new Error(`tmux new-window ${req.window}: no space for new pane`)
    this.events.push(`start ${req.window}`)
    this.requests.push(req)
    const taskFile = req.scriptFile.replace(/\.sh$/, '.task.md')
    const task = readFileSync(taskFile, 'utf8')
    const output = /^Output: (.+)$/m.exec(task)![1]
    const role = basename(taskFile).replace(/-\d+\.task\.md$/, '')
    const k = (this.counts[role] = (this.counts[role] ?? 0) + 1)
    const step = this.script[role]?.[k - 1] ?? {}
    if (step.output !== null) {
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, step.output ?? canned(role, task, output))
    }
    this.pending.set(req.window, { req, step })
  }

  async isAlive(_jobId: string, window: string): Promise<boolean> {
    this.events.push(`wait ${window}`)
    const p = this.pending.get(window)
    if (!p) return false
    if (p.step.hang) return true
    writeFileSync(p.req.doneFile, `${p.step.exit ?? 0}\n`)
    this.pending.delete(window)
    return false
  }

  async kill(_jobId: string, window: string): Promise<void> {
    this.events.push(`kill ${window}`)
    this.pending.delete(window)
  }

  async killAgents(): Promise<void> {}
  async killSession(): Promise<void> {}
  async respawnDriver(): Promise<void> {}

  windows(prefix: string): string[] {
    return this.requests.map((r) => r.window).filter((w) => w.startsWith(prefix))
  }
}

/**
 * gh is answered in process; git too unless `realGit` (process spawns cost ~30 ms each here, so only
 * the happy path pays for real commits and pushes). Records every call, and pushes and gh calls as events.
 */
class TestExec implements Exec {
  calls: string[][] = []
  bodies: string[] = []
  openPr: string | null = null
  prBody = 'Old body\n'
  conflict = false
  constructor(private events: string[], private realGit: boolean) {}

  async run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string }): Promise<ExecResult> {
    this.calls.push(cmd)
    const ok = (stdout = '', code = 0) => ({ code, stdout, stderr: '' })
    if (cmd[0] === 'git') {
      if (cmd[1] === 'push') this.events.push(cmd.includes('--force-with-lease') ? 'push --force-with-lease' : 'push')
      if (this.realGit) return realExec.run(cmd, opts)
      if (cmd.includes('--cached')) return ok('', 1) // something is staged
      if (cmd[1] === 'rebase' && cmd[2] !== '--abort') return ok('', this.conflict ? 1 : 0)
      if (cmd.includes('commit-tree')) return ok('5ha\n')
      if (cmd[1] === 'rev-parse') return ok('head\n')
      return ok()
    }
    if (cmd[0] !== 'gh') return realExec.run(cmd, opts)
    this.events.push(cmd.slice(0, 3).join(' '))
    const [, a, b] = cmd
    if (a === 'pr' && b === 'list') return ok(JSON.stringify(this.openPr ? [{ url: this.openPr }] : []))
    if (a === 'pr' && b === 'create') {
      this.openPr = PR
      return ok(`${PR}\n`)
    }
    if (a === 'pr' && b === 'view') return ok(`${this.prBody}\n`)
    if (a === 'pr' && b === 'edit' && cmd[4] === '--body-file') this.bodies.push((this.prBody = readFileSync(cmd[5], 'utf8')))
    if (a === 'repo' && b === 'view') return ok('o/r\n')
    return ok()
  }

  gh(...prefix: string[]): string[][] {
    return this.calls.filter((c) => c[0] === 'gh' && prefix.every((p, i) => c[i + 1] === p))
  }

  git(...prefix: string[]): string[][] {
    return this.calls.filter((c) => c[0] === 'git' && prefix.every((p, i) => c[i + 1] === p))
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const DISCOVERY: Stage[] = ['requirements', 'tech-discovery', 'design', 'discovery-review']

/** A job sitting at `stage`, as the driver would have left it. */
function atStage(stage: Stage): Partial<Job> {
  const patch: Partial<Job> = {
    stage,
    waitingFor: stage === 'requirements' ? 'requirements' : null,
    pr: stage === 'requirements' ? null : PR,
  }
  if (DISCOVERY.includes(stage)) return patch
  return {
    ...patch,
    planned: stage !== 'planning',
    trip: 1,
    discovery: [{ n: 1, verdict: 'PASS' }],
    trips: [{ cycle: 1, trip: 1, reviews: {}, buildJudge: null, validations: {}, validationJudge: null }],
  }
}

async function fakeRepo(): Promise<{ repo: string; origin: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-driver-')))
  mkdirSync(join(root, 'repo'))
  return { repo: join(root, 'repo'), origin: '', cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function setup(
  o: { stage?: Stage; feature?: string; patch?: Partial<Job>; script?: Record<string, Step[]>; config?: object; realGit?: boolean } = {},
) {
  const t = o.realGit ? await tempRepo() : await fakeRepo()
  cleanups.push(t.cleanup)
  const events: string[] = []
  const exec = new TestExec(events, !!o.realGit)
  const spawner = new FakeSpawner(events, o.script)
  const paths = jobPaths(t.repo, ID)
  if (o.realGit) await new Git(realExec, t.repo).createWorktree(`factory/${ID}`, paths.worktree, 'main')
  else mkdirSync(paths.worktree, { recursive: true })
  if (o.config) writeFileSync(join(t.repo, '.factory.json'), JSON.stringify(o.config))
  let clock = Date.parse('2026-11-26T10:00:00Z')
  const created = createJob({ id: ID, feature: o.feature ?? 'Add the thing', repo: t.repo, slot: 1, now: new Date(clock) })
  saveJob(paths.jobFile, { ...created, ...atStage(o.stage ?? 'tech-discovery'), ...o.patch }, new Date(clock))
  const notes: { title: string; message: string }[] = []
  const logs: string[] = []
  const deps: Deps = {
    exec,
    spawner,
    git: new Git(exec, t.repo),
    gh: new GitHub(exec, t.repo),
    rolesDir: ROLES,
    notify: async (n) => {
      notes.push(n)
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms
    },
    log: (line) => logs.push(line),
  }
  const doc = (dir: string) => join(paths.worktree, 'docs', dir, `${ID}.md`)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const originLog = async () =>
    (await realExec.run(['git', 'log', `factory/${ID}`, '--format=%s'], { cwd: t.origin })).stdout.trim().split('\n')
  return {
    ...t, events, exec, spawner, paths, deps, notes, logs, doc, write, originLog,
    run: () => runJob(t.repo, ID, deps),
    load: () => loadJob(paths.jobFile) as Job,
    activity: () => readFileSync(paths.activityLog, 'utf8'),
    task: (window: string) => {
      const req = spawner.requests.find((r) => r.window === window)!
      return readFileSync(req.scriptFile.replace(/\.sh$/, '.task.md'), 'utf8')
    },
  }
}

describe('runJob', () => {
  test('happy path from tech-discovery to human-review', async () => {
    const t = await setup({ realGit: true })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job.stage).toBe('human-review')
    expect(job.running).toEqual([])
    expect(job.trips).toEqual([
      {
        cycle: 1, trip: 1, reviews: { product: 'PASS', code: 'PASS', security: 'PASS' }, buildJudge: 'APPROVE',
        validations: { e2e: 'PASS', user: 'PASS' }, validationJudge: 'PASS', built: ['T1', 'T2'],
      },
    ])
    // tech-discovery → design → … → validation-judge → human-review: 12 transitions.
    expect(t.exec.gh('pr', 'edit')).toHaveLength(12)
    expect(t.exec.bodies.at(-1)).toContain('<!-- factory:status -->')
    expect(t.exec.bodies.at(-1)).toContain('Waiting for your review')
    expect(t.exec.bodies.at(-1)).toContain(`[spec](https://github.com/o/r/blob/factory/${ID}/docs/specs/${ID}.md)`)
    expect(t.exec.bodies.at(-1)).toEndWith('Old body\n')
    // A push after each builder, before the next one starts.
    const from = t.events.indexOf('start builder-backend')
    const to = t.events.findIndex((e) => e.startsWith('start reviewer-'))
    expect(t.events.slice(from, to).filter((e) => /^(start|push)/.test(e))).toEqual([
      'start builder-backend', 'push', 'start builder-frontend', 'push',
    ])
    expect(t.events).toContain('push --force-with-lease')
    expect(await t.originLog()).toEqual([
      `docs: test plan for ${ID}`, `docs: spec for ${ID}`, `docs: design for ${ID}`, `docs: tech discovery for ${ID}`, 'init',
    ])
    expect(t.task('test-planner')).toContain('Enabled validators: e2e, user')
    expect(t.task('validator-e2e')).toContain('Target: http://localhost:5110')
    expect(t.task('validator-user')).toContain('Target: http://localhost:5111')
    expect(t.task('reviewer-code')).not.toContain('Target:')
    expect(t.task('build-judge')).toContain(
      `Inputs: ${['code', 'product', 'security'].map((l) => join(t.paths.tripDir(1), `review-${l}.md`)).join(', ')}`,
    )
    expect(t.notes).toEqual([{ title: `${ID} needs you`, message: `Review the PR: ${PR}` }])
    expect(t.logs.every((l) => l.startsWith(`${ID}: `))).toBe(true)
    expect(t.logs.at(-1)).toBe(`${ID}: next: factory approve ${ID}   or   factory feedback ${ID} "…"`)
  }, 30_000)

  test('every transition is in activity.log', async () => {
    const t = await setup()
    await t.run()
    const log = t.activity()
    const stages = [
      'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge',
      'test-planning', 'rebase', 'qa-wait', 'validation', 'validation-judge', 'human-review',
    ]
    let at = 0
    for (let i = 1; i < stages.length; i++) {
      const k = log.indexOf(`${stages[i - 1]} → ${stages[i]}`, at)
      expect(k).toBeGreaterThanOrEqual(at)
      at = k
    }
    expect(log).toContain('review → build-judge (all PASS)')
    expect(log).toContain('discovery-review → planning (PASS)')
    expect(log).toMatch(/^\d\d:\d\d:\d\d start tech-discoverer \(claude haiku\)$/m)
  })

  test('missing output then valid output proceeds', async () => {
    const t = await setup({ script: { 'tech-discoverer': [{ output: null }] } })
    expect(await t.run()).toBe('waiting')
    expect(t.load().stage).toBe('human-review')
    expect(t.spawner.windows('tech-discoverer')).toEqual(['tech-discoverer', 'tech-discoverer-2'])
    expect(t.activity()).toContain(`tech-discoverer: no output at docs/tech-discovery/${ID}.md`)
  })

  test('two failures go to needs-human naming the role', async () => {
    const t = await setup({ script: { designer: [{ output: '## Approach\nonly\n' }, { exit: 3 }] } })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'design', running: [] })
    expect(job.reason).toBe('designer: exited with code 3')
    expect(t.activity()).toContain(`designer: docs/design-docs/${ID}.md: missing "## Alternatives"`)
    expect(t.notes).toEqual([{ title: `${ID} needs you`, message: 'Failed: designer: exited with code 3' }])
    // The failed windows stay open for inspection.
    expect(t.events.filter((e) => e.startsWith('kill designer'))).toEqual([])
  })

  test('timeout kills the window and counts as a failure', async () => {
    const t = await setup({ script: { 'tech-discoverer': [{ hang: true }, { hang: true }] } })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job.reason).toBe('tech-discoverer: timed out after 15 min')
    expect(job.running).toEqual([])
    expect(t.events.filter((e) => e.startsWith('kill'))).toEqual(['kill tech-discoverer', 'kill tech-discoverer-2'])
  })

  test('BLOCKED build goes to needs-human with the BLOCKED line', async () => {
    const blocked = 'STATUS: BLOCKED\n# Build\n\n## T1 Backend\nTried.\n\n### Blocked\nThe spec needs a migration nobody approved.\n'
    const t = await setup({ stage: 'planning', script: { 'builder-backend': [{ output: blocked }] } })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'build' })
    expect(job.reason).toBe('builder-backend: T1 blocked: The spec needs a migration nobody approved.')
    expect(t.spawner.windows('builder-')).toEqual(['builder-backend'])
    expect(job.trips[0].built ?? []).toEqual([])
  })

  test('retry after BLOCKED re-runs the blocked task, not the ones built before it', async () => {
    const t = await setup({ stage: 'build' })
    t.write(t.doc('specs'), SPEC)
    t.write(join(t.paths.tripDir(1), 'build.md'), 'STATUS: BLOCKED\n# Build\n\n## T1\nDone.\n\n## T2\n### Blocked\nNo.\n')
    const job = t.load()
    saveJob(t.paths.jobFile, { ...job, trips: [{ ...job.trips[0], built: ['T1'] }] }, new Date())
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('builder-')).toEqual(['builder-frontend'])
    expect(t.activity()).toContain('skip T1: already built')
    expect(t.load().trips[0].built).toEqual(['T1', 'T2'])
  })

  test('build resume follows the trip record, not the order of sections in build.md', async () => {
    const t = await setup({ stage: 'build' })
    t.write(t.doc('specs'), SPEC.replace('T1, T2', 'T2, T1'))
    t.write(join(t.paths.tripDir(1), 'build.md'), 'STATUS: BLOCKED\n# Build\n\n## T1\n### Blocked\nNo.\n\n## T2\nDone.\n')
    const job = t.load()
    saveJob(t.paths.jobFile, { ...job, trips: [{ ...job.trips[0], built: ['T2'] }] }, new Date())
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('builder-')).toEqual(['builder-backend'])
    expect(t.load()).toMatchObject({ stage: 'human-review' })
    expect(t.load().trips[0].built).toEqual(['T2', 'T1'])
  })

  test('an unknown specialist is noted once and built by builder-general', async () => {
    const t = await setup({ stage: 'build' })
    t.write(t.doc('specs'), SPEC.replace('Specialist: frontend', 'Specialist: quantum'))
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('builder-')).toEqual(['builder-backend', 'builder-general'])
    expect(t.activity().match(/T2: unknown specialist "quantum" → builder-general/g)).toHaveLength(1)
  })

  test('a role that cannot run fails the stage before any agent starts', async () => {
    const t = await setup({ stage: 'review', config: { defaultHarness: 'pi' } })
    t.write(t.doc('specs'), SPEC.replace('Lenses: product, code, security', 'Lenses: code, ui'))
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', reason: 'role reviewer-ui needs a browser; run it on claude' })
    expect(t.spawner.requests).toEqual([])
  })

  test('review lenses all start before the first wait', async () => {
    const t = await setup({ stage: 'review' })
    t.write(t.doc('specs'), SPEC)
    await t.run()
    const starts = t.events.flatMap((e, i) => (e.startsWith('start reviewer-') ? [i] : []))
    const firstWait = t.events.findIndex((e) => e.startsWith('wait reviewer-'))
    expect(starts).toHaveLength(3)
    expect(Math.max(...starts)).toBeLessThan(firstWait)
  })

  test('resume skips lenses whose review already passed its check', async () => {
    const t = await setup({ stage: 'review' })
    t.write(t.doc('specs'), SPEC)
    t.write(join(t.paths.tripDir(1), 'review-product.md'), 'VERDICT: PASS\n')
    t.write(join(t.paths.tripDir(1), 'review-code.md'), 'VERDICT: CHANGES\n\nNits.\n')
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('reviewer-')).toEqual(['reviewer-security'])
    expect(t.load().trips[0].reviews).toEqual({ product: 'PASS', code: 'CHANGES', security: 'PASS' })
    expect(t.activity()).toContain('review → build-judge (code CHANGES, others PASS)')
  })

  test('requirements notifies, opens a draft PR after the first push and runs the hooks', async () => {
    const t = await setup({
      stage: 'requirements',
      feature: `${'Make the thing '.repeat(8)}work`,
      config: { hooks: { prOpened: 'echo "$PR" > opened.txt', qaUrl: 'echo noise; echo https://qa.example/$JOB' } },
    })
    expect(await t.run()).toBe('waiting')
    expect(t.notes[0]).toEqual({ title: `${ID} needs you`, message: `Answer the grill: factory attach ${ID}` })
    const create = t.exec.gh('pr', 'create')
    expect(create).toHaveLength(1)
    const title = create[0][create[0].indexOf('--title') + 1]
    expect(title).toBe(`[factory] ${'Make the thing '.repeat(8)}work`.slice(0, 72))
    expect(t.events.indexOf('push')).toBeLessThan(t.events.indexOf('gh pr create'))
    expect(readFileSync(join(t.paths.worktree, 'opened.txt'), 'utf8')).toBe(`${PR}\n`)
    expect(existsSync(join(t.paths.jobDir, 'prOpened.ok'))).toBe(true)
    const job = t.load()
    expect(job).toMatchObject({ pr: PR, qaUrl: `https://qa.example/${ID}`, stage: 'human-review' })
    expect(t.task('validator-e2e')).toContain(`Target: https://qa.example/${ID}`)
    expect(t.task('reviewer-code')).not.toContain('Target:')
    expect(t.exec.git('commit')[0]).toEqual(['git', 'commit', '-m', `docs: requirements for ${ID}`])
    // The grill is killed once its doc passes the check.
    expect(t.events).toContain('kill requirements')
  })

  test('resume does not create a second PR', async () => {
    const t = await setup({ stage: 'requirements' })
    t.exec.openPr = PR
    expect(await t.run()).toBe('waiting')
    expect(t.exec.gh('pr', 'create')).toEqual([])
    expect(t.load().pr).toBe(PR)
  })

  test('a retry after a failed push does not grill the human again', async () => {
    const t = await setup({ stage: 'requirements' })
    const run = t.exec.run.bind(t.exec)
    let pushes = 0
    t.exec.run = async (cmd, opts) => (cmd[1] === 'push' && pushes++ === 0 ? { code: 1, stdout: '', stderr: 'offline' } : run(cmd, opts))
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', resumeStage: 'requirements' })
    saveJob(t.paths.jobFile, applyCommand(t.load(), { kind: 'retry' }, new Date()), new Date())
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('requirements')).toEqual(['requirements'])
    expect(t.load()).toMatchObject({ stage: 'human-review', pr: PR })
  })

  test('a requirements doc from an earlier visit does not end the grill', async () => {
    const t = await setup({ stage: 'requirements', patch: { pr: PR }, script: { requirements: [{ output: null }] } })
    t.write(t.doc('requirements'), canned('requirements', '', ''))
    await Bun.sleep(20) // older than the visit, also with coarse file timestamps
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('requirements')).toEqual(['requirements', 'requirements-2'])
    // The first grill ran until it exited instead of being dropped while the human was in it.
    expect(t.events.indexOf('wait requirements')).toBeGreaterThan(-1)
    expect(t.events.indexOf('wait requirements')).toBeLessThan(t.events.indexOf('start requirements-2'))
    expect(t.activity()).toContain(`requirements: docs/requirements/${ID}.md was not written`)
  })

  test('ASK sends the job back through requirements and re-runs the discovery steps', async () => {
    const t = await setup({
      stage: 'discovery-review',
      script: { 'discovery-reviewer': [{ output: 'VERDICT: ASK\n\n## Questions\n- Which one?\n' }] },
    })
    t.write(t.doc('requirements'), canned('requirements', '', ''))
    t.write(t.doc('tech-discovery'), canned('tech-discoverer', '', ''))
    t.write(t.doc('design-docs'), canned('designer', '', ''))
    await Bun.sleep(20) // older than the visit, also with coarse file timestamps
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.requests.map((r) => r.window).slice(0, 5)).toEqual([
      'discovery-reviewer', 'requirements', 'tech-discoverer', 'designer', 'discovery-reviewer-2',
    ])
    expect(t.task('requirements')).toContain(`Inputs: ${t.paths.discoveryReview(1)}`)
    expect(t.load()).toMatchObject({ stage: 'human-review', discoveryLoops: 1 })
  })

  test('REWORK gives the discovery review to the step it reruns', async () => {
    const t = await setup({
      stage: 'discovery-review',
      script: { 'discovery-reviewer': [{ output: 'VERDICT: REWORK design\n\nThe design ignores the cache.\n' }] },
    })
    expect(await t.run()).toBe('waiting')
    expect(t.task('designer')).toContain(`Inputs: ${t.paths.discoveryReview(1)}`)
    expect(t.task('designer')).toContain('Assignment: Rework the design doc')
  })

  test('designer questions go to the human without the reviewer', async () => {
    const questions = '## Approach\nx\n\n## Alternatives\nx\n\n## Questions for the human\n- Cache or not?\n'
    const t = await setup({ stage: 'design', script: { designer: [{ output: questions }] } })
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.requests.map((r) => r.window).slice(0, 3)).toEqual(['designer', 'requirements', 'tech-discoverer'])
    expect(t.task('requirements')).toContain(`Inputs: ${t.doc('design-docs')}`)
  })

  test('build-judge CHANGES starts a new trip that re-runs the planner', async () => {
    const t = await setup({ stage: 'review', script: { 'build-judge': [{ output: 'VERDICT: CHANGES\n\nFix T2.\n' }] } })
    t.write(t.doc('specs'), SPEC)
    await Bun.sleep(20) // older than the trip-2 planning visit, also with coarse file timestamps
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'human-review', trip: 2 })
    expect(job.trips.map((r) => r.buildJudge)).toEqual(['CHANGES', 'APPROVE'])
    expect(t.spawner.windows('planner')).toEqual(['planner'])
    expect(t.task('planner')).toContain(`Inputs: ${join(t.paths.tripDir(1), 'build-judge.md')}`)
    expect(existsSync(join(t.paths.tripDir(2), 'build.md'))).toBe(true)
    expect(t.spawner.windows('test-planner')).toEqual(['test-planner'])
  })

  test('validation ENV moves the trip validation files aside and validates again', async () => {
    const t = await setup({ stage: 'validation', script: { 'validation-judge': [{ output: 'VERDICT: ENV\n\nQA is down.\n' }] } })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'human-review', envRetries: 1, trip: 1 })
    expect(job.trips[0].validations).toEqual({ e2e: 'PASS', user: 'PASS' })
    expect(t.spawner.windows('validator-e2e')).toEqual(['validator-e2e', 'validator-e2e-2'])
    for (const f of ['validation-e2e.env1.md', 'validation-user.env1.md', 'validation-judge.env1.md', 'validation-judge.md']) {
      expect(existsSync(join(t.paths.tripDir(1), f))).toBe(true)
    }
  })

  test('qa-wait timeout goes to needs-human', async () => {
    const t = await setup({ stage: 'qa-wait', config: { hooks: { qaReady: 'exit 1' }, qaPollSec: 300 } })
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', reason: 'QA env not ready after 20 min', resumeStage: 'qa-wait' })
  })

  test('rebase conflict runs the resolver, then force-pushes', async () => {
    const t = await setup({ stage: 'rebase' })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    t.exec.conflict = true
    expect(await t.run()).toBe('waiting')
    expect(t.exec.git('rebase', '--abort')).toHaveLength(1)
    expect(t.spawner.windows('resolver')).toEqual(['resolver'])
    expect(t.task('resolver')).toContain(`Assignment: Rebase factory/${ID} onto origin/main`)
    expect(t.events.indexOf('push --force-with-lease')).toBeGreaterThan(t.events.indexOf('start resolver'))
  })

  test('a clean rebase force-pushes without the resolver', async () => {
    const t = await setup({ stage: 'rebase' })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.windows('resolver')).toEqual([])
    expect(t.exec.git('push', '--force-with-lease')).toEqual([['git', 'push', '--force-with-lease', '-u', 'origin', `factory/${ID}`]])
  })

  test('finalize pushes proof, writes the PR from pr.md and marks it ready', async () => {
    const t = await setup({ stage: 'finalize', patch: { ready: true } })
    t.write(t.doc('specs'), SPEC)
    t.write(join(t.paths.proofDir, 'ac1-works.png'), 'png')
    t.write(join(t.paths.proofDir, 'ac2-fast.txt'), '$ bench\nfast\n')
    expect(await t.run()).toBe('done')
    const sha = '5ha'
    expect(t.exec.calls.some((c) => c.join(' ') === `git push --force origin ${sha}:refs/heads/factory-proof/${ID}`)).toBe(true)
    expect(t.exec.gh('pr', 'edit', PR, '--title')).toEqual([['gh', 'pr', 'edit', PR, '--title', 'Add the thing']])
    const body = t.exec.bodies[0]
    expect(body.startsWith('It adds the thing.')).toBe(true)
    expect(body).toContain(`![ac1-works.png](https://github.com/o/r/blob/${sha}/ac1-works.png?raw=true)`)
    expect(body).toContain(`[ac2-fast.txt](https://github.com/o/r/blob/${sha}/ac2-fast.txt?raw=true)`)
    expect(t.exec.gh('pr', 'ready')).toEqual([['gh', 'pr', 'ready', PR]])
    expect(t.load().stage).toBe('done')
  })

  test('finalize leaves a draft with the gaps when proof is missing', async () => {
    const t = await setup({ stage: 'finalize', patch: { ready: true } })
    t.write(t.doc('specs'), SPEC)
    t.write(join(t.paths.proofDir, 'ac1-works.png'), 'png')
    expect(await t.run()).toBe('done')
    expect(t.exec.bodies[0].startsWith('## Open\n\n- No proof for acceptance criteria 2.')).toBe(true)
    expect(t.exec.gh('pr', 'ready')).toEqual([])
  })

  test('a failed job approved anyway: the draft opens with the reason it stopped', async () => {
    const t = await setup({ stage: 'finalize', patch: { ready: false, stoppedReason: 'trip cap (3) reached' } })
    t.write(t.doc('specs'), SPEC)
    expect(await t.run()).toBe('done')
    expect(t.exec.bodies[0].startsWith([
      '## Open',
      '',
      '- The job stopped: trip cap (3) reached',
      '- No proof for acceptance criteria 1, 2.',
      '- Approved without a clean pass: the job had stopped for the human.',
    ].join('\n'))).toBe(true)
    expect(t.exec.gh('pr', 'ready')).toEqual([])
  })

  test('commandFor replaces the harness command; the run files stay the same', async () => {
    const t = await setup({ stage: 'test-planning' })
    const seen: string[] = []
    t.deps.commandFor = (role, files) => {
      seen.push(`${role} ${files.harness} ${basename(files.system)} ${basename(files.task)}`)
      return `fake ${role}`
    }
    expect(await t.run()).toBe('waiting')
    expect(seen[0]).toBe('test-planner claude test-planner-1.system.md test-planner-1.task.md')
    const req = t.spawner.requests[0]!
    expect(req).toMatchObject({ command: 'fake test-planner', tail: 'claude', interactive: false })
    expect(req.scriptFile).toBe(join(t.paths.runDir, 'test-planner-1.sh'))
    expect(req.logFile).toBe(join(t.paths.logsDir, 'test-planner-1.log'))
    expect(req.doneFile).toBe(join(t.paths.doneDir, 'test-planner-1'))
    expect(t.spawner.requests.every((r) => r.command === `fake ${r.window.replace(/-\d+$/, '')}`)).toBe(true)
  })

  test('feature text with $(…) and quotes appears only in the task file', async () => {
    const feature = `Add "quotes", 'single' $(rm -rf ~) and \`whoami\` \\ end`
    const t = await setup({ feature })
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.requests.length).toBeGreaterThan(10)
    for (const req of t.spawner.requests) {
      expect(req.command).not.toContain('rm -rf')
      expect(req.command).not.toContain('whoami')
      expect(writeRunScript(req)).not.toContain('rm -rf')
      expect(t.task(req.window)).toContain(`Request: ${feature}`)
    }
  })

  test('v1 job refuses to run', async () => {
    const t = await setup()
    writeFileSync(t.paths.jobFile, JSON.stringify({ id: ID, feature: 'old', stage: 'review' }))
    await expect(t.run()).rejects.toThrow('not a factory v2 job')
    expect(existsSync(join(t.paths.jobDir, 'driver.lock'))).toBe(false)
    expect(t.spawner.requests).toEqual([])
  })

  test('a second driver on the same job refuses', async () => {
    const t = await setup()
    const release = acquireLock(t.paths.jobDir)
    await expect(t.run()).rejects.toThrow(LockError)
    release()
    expect(t.spawner.requests).toEqual([])
  })

  test('a job already waiting returns without spawning or notifying', async () => {
    const t = await setup({ stage: 'human-review', patch: { waitingFor: 'human-review' } })
    expect(await t.run()).toBe('waiting')
    expect(t.spawner.requests).toEqual([])
    expect(t.notes).toEqual([])
  })

  test('leftover agent windows from a dead driver are killed', async () => {
    const t = await setup({ stage: 'human-review', patch: { waitingFor: 'human-review', running: ['reviewer-code'] } })
    t.spawner.isAlive = async () => true
    await t.run()
    expect(t.events).toContain('kill reviewer-code')
    expect(t.load().running).toEqual([])
  })

  test('a failing PR status edit is logged and the job goes on', async () => {
    const t = await setup()
    const run = t.exec.run.bind(t.exec)
    t.exec.run = async (cmd, opts) => (cmd[0] === 'gh' && cmd[2] === 'edit' ? { code: 1, stdout: '', stderr: 'boom' } : run(cmd, opts))
    expect(await t.run()).toBe('waiting')
    expect(t.load().stage).toBe('human-review')
    expect(t.activity()).toContain('PR status update failed')
  })

  test('a failing prOpened hook stops the job, and a retry runs it again', async () => {
    const hook = 'test -f qa.ok || { echo "no QA env free" >&2; exit 3; }; echo "$PR" > opened.txt'
    const t = await setup({ stage: 'requirements', config: { hooks: { prOpened: hook } } })
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({
      stage: 'needs-human', resumeStage: 'requirements', pr: PR, reason: 'hook prOpened failed (exit 3): no QA env free',
    })
    expect(existsSync(join(t.paths.jobDir, 'prOpened.ok'))).toBe(false)
    writeFileSync(join(t.paths.worktree, 'qa.ok'), '')
    saveJob(t.paths.jobFile, applyCommand(t.load(), { kind: 'retry' }, new Date()), new Date())
    expect(await t.run()).toBe('waiting')
    expect(t.load().stage).toBe('human-review')
    expect(readFileSync(join(t.paths.worktree, 'opened.txt'), 'utf8')).toBe(`${PR}\n`)
    expect(existsSync(join(t.paths.jobDir, 'prOpened.ok'))).toBe(true)
    expect(t.exec.gh('pr', 'create')).toHaveLength(1)
    expect(t.spawner.windows('requirements')).toEqual(['requirements'])
  })

  test('qa-wait asks the qaUrl hook again when there is no QA env yet', async () => {
    const t = await setup({ stage: 'qa-wait', config: { hooks: { qaUrl: 'echo https://qa.example/late' } } })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    expect(await t.run()).toBe('waiting')
    expect(t.load().qaUrl).toBe('https://qa.example/late')
    expect(t.task('validator-e2e')).toContain('Target: https://qa.example/late')
  })

  test('browser builders and reviewers use their local port even with a QA env; validators use the QA env', async () => {
    const t = await setup({ stage: 'build', patch: { qaUrl: 'https://qa.example/x' } })
    t.write(t.doc('specs'), SPEC.replace('Lenses: product, code, security', 'Lenses: product, ux, ui'))
    expect(await t.run()).toBe('waiting')
    expect(t.load().stage).toBe('human-review')
    expect(t.task('builder-frontend')).toContain('Target: http://localhost:5110')
    expect(t.task('reviewer-ux')).toContain('Target: http://localhost:5111')
    expect(t.task('reviewer-ui')).toContain('Target: http://localhost:5112')
    expect(t.task('validator-e2e')).toContain('Target: https://qa.example/x')
    expect(t.task('validator-user')).toContain('Target: https://qa.example/x')
  })

  test('a failing qaUrl hook in qa-wait is noted and validation goes on locally', async () => {
    const t = await setup({ stage: 'qa-wait', config: { hooks: { qaUrl: 'echo down >&2; exit 2' } } })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'human-review', qaUrl: null })
    expect(t.activity()).toContain('hook qaUrl failed (exit 2): down')
    expect(t.task('validator-e2e')).toContain('Target: http://localhost:5110')
  })

  test('a judge escalation puts its questions below the status block until the pause ends', async () => {
    const escalate = 'VERDICT: ESCALATE\n\nRisky.\n\n## Questions\n- Ship without a migration?\n- Who owns the cache?\n\n## Notes\nx\n'
    const t = await setup({ stage: 'review', script: { 'build-judge': [{ output: escalate }] } })
    t.write(t.doc('specs'), SPEC)
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', waitingFor: 'escalation' })
    const paused = t.exec.prBody
    expect(paused).toContain(
      '<!-- /factory:status -->\n\n<!-- factory:decision -->\n## ⏸ Needs your decision\n\n- Ship without a migration?\n- Who owns the cache?\n<!-- /factory:decision -->\n\nOld body',
    )
    expect(paused).not.toContain('## Notes')
    saveJob(t.paths.jobFile, applyCommand(t.load(), { kind: 'approve' }, new Date()), new Date())
    expect(await t.run()).toBe('waiting')
    expect(t.load().stage).toBe('human-review')
    expect(t.exec.prBody).not.toContain('factory:decision')
    expect(t.exec.prBody).not.toContain('Needs your decision')
    expect(t.exec.prBody).toEndWith('<!-- /factory:status -->\n\nOld body\n')
  })

  test('the second ENV pause names the validators evidence in the PR body', async () => {
    const env = { output: 'VERDICT: ENV\n\nQA is down.\n' }
    const t = await setup({ stage: 'validation', script: { 'validation-judge': [env, env] } })
    t.write(t.doc('test-plans'), canned('test-planner', '', ''))
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', capHit: 'env' })
    expect(t.exec.prBody).toContain(
      `## ⏸ Needs your decision\n\nQA environment failed twice; validators' evidence: .factory/jobs/${ID}/trip-1/validation-judge.md`,
    )
  })

  test('a headless step that writes nothing does not pass on an earlier visit doc', async () => {
    const t = await setup({
      stage: 'review',
      script: { 'build-judge': [{ output: 'VERDICT: CHANGES\n\nFix T2.\n' }], planner: [{ output: null }, { output: null }] },
    })
    t.write(t.doc('specs'), SPEC)
    await Bun.sleep(20) // older than the trip-2 planning visit, also with coarse file timestamps
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({
      stage: 'needs-human', resumeStage: 'planning', trip: 2, reason: `planner: docs/specs/${ID}.md was not written`,
    })
    expect(t.spawner.windows('planner')).toEqual(['planner', 'planner-2'])
  })

  test('a start that fails mid-group kills the agents already started', async () => {
    const t = await setup({ stage: 'review' })
    t.write(t.doc('specs'), SPEC)
    t.spawner.failStart = 2
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({
      stage: 'needs-human', resumeStage: 'review', running: [], reason: 'tmux new-window reviewer-code: no space for new pane',
    })
    expect(t.events).toEqual(['start reviewer-product', 'kill reviewer-product', 'gh pr view', 'gh repo view', 'gh pr edit'])
  })

  test('a failing push is a failure with the git error', async () => {
    const t = await setup()
    const run = t.exec.run.bind(t.exec)
    t.exec.run = async (cmd, opts) => (cmd[1] === 'push' ? { code: 1, stdout: '', stderr: 'rejected' } : run(cmd, opts))
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'needs-human', resumeStage: 'tech-discovery' })
    expect(t.load().reason).toContain('git push -u origin factory/261126-x failed (exit 1): rejected')
  })
})

describe('driver helpers', () => {
  test('REQUIRED_ROLES names every role the driver spawns', () => {
    expect(REQUIRED_ROLES).toHaveLength(25)
    expect(REQUIRED_ROLES).toContain('builder-general')
    expect(REQUIRED_ROLES).toContain('reviewer-ui')
    expect(REQUIRED_ROLES).toContain('validator-capacity')
  })

  test('driverCommand runs this bun on the CLI, quoted, driving in the window', () => {
    expect(driverCommand(ID)).toBe(`'${process.execPath}' '${CLI_PATH}' run '${ID}' --here`)
  })

  test('makeDeps picks the spawner', () => {
    expect(makeDeps('/r', { inline: true }).spawner).toBeInstanceOf(InlineSpawner)
    expect(makeDeps('/r').spawner).toBeInstanceOf(TmuxSpawner)
  })
})
