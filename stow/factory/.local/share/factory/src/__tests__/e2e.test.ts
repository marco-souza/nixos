import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { approve } from '../commands/approve'
import { feedback } from '../commands/feedback'
import { newJob } from '../commands/new'
import type { Deps } from '../deps'
import { runJob } from '../driver'
import { realExec, type Exec, type ExecResult } from '../exec'
import { Git, GitHub } from '../git'
import { loadJob, type Job } from '../job'
import { jobPaths, PACKAGE_DIR } from '../paths'
import { shq } from '../shell'
import { InlineSpawner } from '../spawn'
import { tempRepo } from './helpers'

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'fake-agent.ts')
const PR = 'https://github.com/o/r/pull/1'

/** Real `claude`, `pi`, `gh` and `tmux` must never run: first on PATH for every process the e2e starts, they fail. */
const STUBS = ['claude', 'pi', 'gh', 'tmux']
const stubMessage = (name: string) => `e2e: real ${name} must not run`

/**
 * gh is answered in process and recorded; tmux only answers the presence check. A run script must start the fake
 * agent. Everything else (git, bash, bun, hooks) runs for real, with the stubs first on PATH.
 */
class E2eExec implements Exec {
  gh: string[][] = []
  /** gh and tmux calls the fakes don't answer; afterEach asserts there are none. */
  unexpected: string[] = []
  body = ''
  private open = false
  constructor(private path: string) {}

  async run(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Promise<ExecResult> {
    if (cmd[0] === 'tmux') return cmd[1] === '-V' && cmd.length === 2 ? ok('tmux 3.5\n') : this.refuse(cmd)
    if (cmd[0] === 'gh') return this.fakeGh(cmd)
    // A `bash -c` is a hook from .factory.json; any other bash runs an agent's run script.
    if (cmd[0] === 'bash' && cmd[1] !== '-c' && !readFileSync(cmd[1]!, 'utf8').includes(shq(FAKE_AGENT))) {
      throw new Error(`e2e: ${basename(cmd[1]!)} does not run the fake agent; a real agent must not run`)
    }
    return realExec.run(cmd, { ...opts, env: { ...opts.env, PATH: this.path } })
  }

  private fakeGh(cmd: string[]): ExecResult {
    const args = cmd.slice(1)
    this.gh.push(args)
    const flag = (name: string) => args[args.indexOf(name) + 1]!
    const [a, b] = args
    if (a === 'auth' && b === 'status') return ok()
    if (a === 'repo' && b === 'view') return ok('o/r\n')
    if (a === 'api') return ok('[]')
    if (a === 'pr' && b === 'list') return ok(JSON.stringify(this.open ? [{ url: PR }] : []))
    if (a === 'pr' && b === 'create') {
      this.open = true
      this.body = readFileSync(flag('--body-file'), 'utf8')
      return ok(`${PR}\n`)
    }
    if (a === 'pr' && b === 'view' && flag('--json') === 'body') return ok(this.body)
    if (a === 'pr' && b === 'view' && flag('--json') === 'comments,reviews') return ok('{"comments":[],"reviews":[]}')
    if (a === 'pr' && b === 'edit' && args.includes('--body-file')) {
      this.body = readFileSync(flag('--body-file'), 'utf8')
      return ok()
    }
    if (a === 'pr' && ((b === 'edit' && args.includes('--title')) || b === 'ready')) return ok()
    return this.refuse(cmd)
  }

  private refuse(cmd: string[]): ExecResult {
    this.unexpected.push(cmd.join(' '))
    return { code: 1, stdout: '', stderr: `e2e: unexpected call: ${cmd.join(' ')}` }
  }

  calls(...prefix: string[]): string[][] {
    return this.gh.filter((c) => prefix.every((p, i) => c[i] === p))
  }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

const execs: E2eExec[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const e of execs.splice(0)) expect(e.unexpected).toEqual([])
  } finally {
    while (cleanups.length) await cleanups.pop()!()
  }
})

/**
 * A real repo with a bare origin, hooks that log to a file, and `factory new` already run. Agents are fake-agent.ts
 * processes run inline, answering from `scenario`.
 */
async function setup(scenario: Record<string, string[]> = {}) {
  const t = await tempRepo()
  cleanups.push(t.cleanup)
  const root = dirname(t.repo)
  const hookLog = join(root, 'hooks.log')
  writeFileSync(
    join(t.repo, '.factory.json'),
    JSON.stringify({
      hooks: {
        prOpened: `echo "prOpened $PR" >> ${shq(hookLog)}`,
        qaUrl: 'echo "https://qa.example/$JOB"',
        qaReady: `echo "qaReady $SHA" >> ${shq(hookLog)}`,
      },
    }),
  )
  const scenarioFile = join(root, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(scenario))
  const stubs = join(root, 'stubs')
  mkdirSync(stubs)
  for (const name of STUBS) writeFileSync(join(stubs, name), `#!/bin/sh\necho '${stubMessage(name)}' >&2\nexit 99\n`, { mode: 0o755 })
  const exec = new E2eExec(`${stubs}${delimiter}${process.env.PATH ?? ''}`)
  execs.push(exec)
  const git = async (cwd: string, ...args: string[]) => {
    const r = await exec.run(['git', ...args], { cwd })
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const notes: string[] = []
  const logs: string[] = []
  let slept = 0
  const deps: Deps = {
    exec,
    spawner: new InlineSpawner(exec),
    git: new Git(exec, t.repo),
    gh: new GitHub(exec, t.repo),
    rolesDir: join(PACKAGE_DIR, 'roles'),
    commandFor: (role, files) => [process.execPath, FAKE_AGENT, role, files.task, scenarioFile].map(shq).join(' '),
    notify: async (n) => {
      notes.push(n.message)
    },
    now: () => new Date(Date.now() + slept),
    sleep: async (ms) => {
      slept += ms
    },
    log: (line) => logs.push(line),
  }
  const { id } = await newJob(t.repo, 'Add rate limiting', deps, { attach: false })
  const paths = jobPaths(t.repo, id)
  return {
    ...t, exec, deps, notes, logs, id, paths, git,
    run: () => runJob(t.repo, id, deps),
    load: () => loadJob(paths.jobFile) as Job,
    hooks: () => (existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n') : []),
    origin: (...args: string[]) => git(t.origin, ...args),
    trips: () => readdirSync(paths.jobDir).filter((f) => /^trip-\d+$/.test(f)).sort(),
    task: (name: string) => readFileSync(join(paths.runDir, `${name}.task.md`), 'utf8'),
  }
}

describe('factory end to end (real git, real roles, inline fake agents)', () => {
  test('happy path: new → human-review → approve → done', async () => {
    const t = await setup()
    expect(t.logs).toContain(`Answer the grill: factory attach ${t.id}`)
    // main moves on while the job runs, so the rebase has something to do.
    writeFileSync(join(t.repo, 'main.txt'), 'main\n')
    await t.git(t.repo, 'add', 'main.txt')
    await t.git(t.repo, 'commit', '-q', '-m', 'main moves on')
    await t.git(t.repo, 'push', '-q', 'origin', 'main')

    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'human-review', waitingFor: 'human-review', pr: PR, cycle: 1, trip: 1, running: [] })
    expect(t.notes).toEqual([`Answer the grill: factory attach ${t.id}`, `Review the PR: ${PR}`])

    await approve(t.repo, t.id, t.deps)
    expect(await t.run()).toBe('done')
    const job = t.load()
    expect(job.stage).toBe('done')

    const files = (await t.origin('ls-tree', '-r', '--name-only', job.branch)).split('\n')
    for (const dir of ['requirements', 'tech-discovery', 'design-docs', 'specs', 'test-plans']) {
      expect(files).toContain(`docs/${dir}/${t.id}.md`)
    }
    expect(files).toContain('main.txt')
    expect(files).toContain('src/t1.txt')
    expect(files).toContain('src/t2.txt')
    expect((await t.origin('log', '--format=%s', job.branch)).split('\n')).toEqual([
      `docs: test plan for ${t.id}`,
      `feat: t2 for ${t.id} (cycle 1 trip 1)`,
      `feat: t1 for ${t.id} (cycle 1 trip 1)`,
      `docs: spec for ${t.id}`,
      `docs: design for ${t.id}`,
      `docs: tech discovery for ${t.id}`,
      `docs: requirements for ${t.id}`,
      'main moves on',
      'init',
    ])
    expect(await t.origin('ls-tree', '--name-only', `factory-proof/${t.id}`)).toBe(
      'ac1-e2e-requests-over-the-limit-get-a-429.txt\nac2-e2e-the-limit-is-configurable.txt',
    )

    expect(t.exec.calls('pr', 'create')).toHaveLength(1)
    expect(t.exec.calls('pr', 'create')[0]).toContain('--draft')
    expect(t.exec.calls('pr', 'edit', PR, '--body-file').length).toBeGreaterThan(0)
    expect(t.exec.calls('pr', 'edit', PR, '--title')).toEqual([['pr', 'edit', PR, '--title', 'Add rate limiting']])
    expect(t.exec.calls('pr', 'ready')).toEqual([['pr', 'ready', PR]])
    // The status block, now at Done, stays on top of the summarizer's body.
    expect(t.exec.body).toContain('✅ **Done**')
    expect(t.exec.body).toContain('<!-- /factory:status -->\n\nLimits requests per client.\n\n## Proof')
    // QA waited on the rebased head, the one on origin.
    expect(t.hooks()).toEqual([`prOpened ${PR}`, `qaReady ${await t.origin('rev-parse', job.branch)}`])
    expect(t.task('validator-e2e-1')).toContain(`Target: https://qa.example/${t.id}`)
  }, 20_000)

  test('build-judge CHANGES twice then APPROVE', async () => {
    const t = await setup({ 'build-judge': ['CHANGES', 'CHANGES', 'APPROVE'] })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'human-review', cycle: 1, trip: 3 })
    expect(job.trips.map((r) => r.buildJudge)).toEqual(['CHANGES', 'CHANGES', 'APPROVE'])
    expect(t.trips()).toEqual(['trip-1', 'trip-2', 'trip-3'])
    expect(t.task('planner-2')).toContain(`Inputs: ${join(t.paths.tripDir(1), 'build-judge.md')}`)
    expect(t.task('planner-3')).toContain(`Inputs: ${join(t.paths.tripDir(2), 'build-judge.md')}`)
    const log = await t.origin('log', '--format=%s', job.branch)
    for (const trip of [1, 2, 3]) expect(log).toContain(`feat: t2 for ${t.id} (cycle 1 trip ${trip})`)
  }, 20_000)

  test('validation ENV once then PASS', async () => {
    const t = await setup({ 'validation-judge': ['ENV', 'PASS'] })
    expect(await t.run()).toBe('waiting')
    const job = t.load()
    expect(job).toMatchObject({ stage: 'human-review', trip: 1, envRetries: 1 })
    expect(job.trips).toHaveLength(1)
    expect(job.trips[0]).toMatchObject({ validations: { e2e: 'PASS' }, validationJudge: 'PASS' })
    expect(t.trips()).toEqual(['trip-1'])
    // QA was waited on again before the second validation.
    expect(t.hooks().filter((l) => l.startsWith('qaReady'))).toHaveLength(2)
    for (const f of ['validation-e2e.env1.md', 'validation-judge.env1.md', 'validation-e2e.md', 'validation-judge.md']) {
      expect(existsSync(join(t.paths.tripDir(1), f))).toBe(true)
    }
  }, 20_000)

  test('feedback on done', async () => {
    const t = await setup()
    expect(await t.run()).toBe('waiting')
    await approve(t.repo, t.id, t.deps)
    expect(await t.run()).toBe('done')

    await feedback(t.repo, t.id, 'Also limit by API key.', t.deps)
    expect(t.load()).toMatchObject({ stage: 'planning', cycle: 2, trip: 1 })
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({ stage: 'human-review', cycle: 2, trip: 1 })
    expect(t.task('planner-2')).toContain(`Inputs: ${t.paths.feedback(1)}`)
    await approve(t.repo, t.id, t.deps)
    expect(await t.run()).toBe('done')

    expect(t.exec.calls('pr', 'ready')).toEqual([['pr', 'ready', PR], ['pr', 'ready', PR, '--undo'], ['pr', 'ready', PR]])
    expect(t.trips()).toEqual(['trip-1', 'trip-2'])
    expect(await t.origin('log', '--format=%s', `factory/${t.id}`)).toContain(`feat: t1 for ${t.id} (cycle 2 trip 1)`)
  }, 20_000)

  test('without commandFor a run fails fast and no real agent starts', async () => {
    const t = await setup()
    delete t.deps.commandFor
    expect(await t.run()).toBe('waiting')
    expect(t.load()).toMatchObject({
      stage: 'needs-human', resumeStage: 'requirements', running: [],
      reason: 'e2e: requirements-1.sh does not run the fake agent; a real agent must not run',
    })
    // The run script would have started the real grill; it never ran.
    expect(readFileSync(join(t.paths.runDir, 'requirements-1.sh'), 'utf8')).toContain('\nclaude "$(cat ')
    expect(existsSync(join(t.paths.doneDir, 'requirements-1'))).toBe(false)
    expect(existsSync(join(t.paths.logsDir, 'requirements-1.log'))).toBe(false)
    // Whatever gets past that guard finds the stubs first on PATH.
    for (const name of STUBS) {
      expect(await t.exec.run(['bash', '-c', `${name} -p hi`])).toEqual({ code: 99, stdout: '', stderr: `${stubMessage(name)}\n` })
    }
  })
})
