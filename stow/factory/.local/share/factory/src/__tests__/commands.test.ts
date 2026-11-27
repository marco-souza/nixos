import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli'
import { approve } from '../commands/approve'
import { retry } from '../commands/run'
import { serveDashboard } from '../commands/dashboard'
import { discard } from '../commands/discard'
import { feedback } from '../commands/feedback'
import { newJob } from '../commands/new'
import type { Cli, Terminal } from '../commands/shared'
import type { Deps } from '../deps'
import { driverCommand } from '../driver'
import { realExec, type ExecResult } from '../exec'
import { Git, GitHub } from '../git'
import { createJob, loadJob, saveJob, type Job } from '../job'
import { jobPaths } from '../paths'
import { TmuxSpawner, type Spawner } from '../spawn'
import { FakeExec, tempRepo } from './helpers'

const ROLES = join(import.meta.dir, 'fixtures', 'roles')
const STREAM = join(import.meta.dir, 'fixtures', 'stream')
const NOW = new Date(2026, 10, 26, 12, 0, 0)
const ID = '261126-x'
const PR = 'https://github.com/o/r/pull/9'

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
beforeEach(() => {
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (cleanups.length) await cleanups.pop()!()
})

/** Records every Spawner call. */
class RecordingSpawner implements Spawner {
  calls: string[][] = []
  async ensureSession(jobId: string, cwd: string, cmd: string) {
    this.calls.push(['ensureSession', jobId, cwd, cmd])
  }
  async start() {
    throw new Error('no agents in these tests')
  }
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
  async respawnDriver(jobId: string, cwd: string, cmd: string) {
    this.calls.push(['respawnDriver', jobId, cwd, cmd])
  }
}

type Rule = { match: string[]; result: Partial<ExecResult> }

/** A bare `git init`: enough for commands that never touch branches (tempRepo costs ~10 git processes). */
async function plainRepo(): Promise<{ repo: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-cmd-')))
  await realExec.run(['git', 'init', '-q', '-b', 'main'], { cwd: root })
  return { repo: root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function setup(
  o: { gh?: Rule[]; exec?: Rule[]; terminal?: Partial<Terminal>; confirm?: boolean; config?: object; branches?: boolean } = {},
) {
  // Worktrees and branches need a commit and an origin.
  const t = o.branches ? await tempRepo() : await plainRepo()
  cleanups.push(t.cleanup)
  if (o.config) writeFileSync(join(t.repo, '.factory.json'), JSON.stringify(o.config))
  const out: string[] = []
  const err: string[] = []
  const questions: string[] = []
  const ghExec = new FakeExec(o.gh)
  const exec = new FakeExec(o.exec)
  const spawner = new RecordingSpawner()
  const handedOver: string[][] = []
  const deps: Deps = {
    exec,
    spawner,
    git: new Git(realExec, t.repo),
    gh: new GitHub(ghExec, t.repo),
    rolesDir: ROLES,
    notify: async () => {},
    now: () => NOW,
    sleep: async () => {},
    log: (line) => out.push(line),
  }
  const terminal: Terminal = {
    tmux: false,
    tty: false,
    handOver: (cmd) => (handedOver.push(cmd), 0),
    ...o.terminal,
  }
  const cli: Cli = {
    cwd: t.repo,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    confirm: (q) => (questions.push(q), o.confirm ?? false),
    terminal,
    deps: () => deps,
  }
  const paths = jobPaths(t.repo, ID)
  return {
    ...t, out, err, questions, ghExec, exec, spawner, deps, cli, terminal, handedOver, paths,
    run: (...argv: string[]) => main([...argv, '--repo', t.repo], cli),
    /** Saves job `ID` with `patch`; a real worktree when `worktree` is set. */
    async job(patch: Partial<Job> = {}, worktree = false): Promise<Job> {
      if (worktree) await deps.git.createWorktree(`factory/${ID}`, paths.worktree, 'main')
      const job = { ...createJob({ id: ID, feature: 'Add the thing', repo: t.repo, slot: 1, now: NOW }), ...patch }
      saveJob(paths.jobFile, job, NOW)
      return job
    },
    load: () => loadJob(paths.jobFile) as Job,
    gh: (...prefix: string[]) => ghExec.calls.filter((c) => c[0] === 'gh' && prefix.every((p, i) => c[i + 1] === p)),
  }
}

const git = async (cwd: string, ...args: string[]) => (await realExec.run(['git', ...args], { cwd })).stdout.trim()

describe('newJob', () => {
  test('new fails before creating anything when gh is not logged in', async () => {
    const t = await setup({ branches: true, gh: [{ match: ['gh', 'auth', 'status'], result: { code: 1 } }] })
    await expect(newJob(t.repo, 'Add dark mode', t.deps, { attach: false })).rejects.toThrow('gh is not logged in')
    expect(existsSync(join(t.repo, '.factory'))).toBe(false)
    expect(await git(t.repo, 'worktree', 'list')).not.toContain('.factory')
    expect(t.spawner.calls).toEqual([])
  })

  test('new fails before creating anything when tmux is missing', async () => {
    const t = await setup({ exec: [{ match: ['tmux', '-V'], result: { code: 127 } }] })
    await expect(newJob(t.repo, 'Add dark mode', t.deps, { attach: false })).rejects.toThrow('tmux is not installed')
    expect(existsSync(join(t.repo, '.factory'))).toBe(false)
  })

  test('new claims the next id when the folder exists', async () => {
    const t = await setup({ branches: true })
    mkdirSync(join(t.repo, '.factory/jobs/261126-add-dark-mode'), { recursive: true })
    const job = await newJob(t.repo, 'Add dark mode', t.deps, { attach: false })
    const id = '261126-add-dark-mode-2'
    expect(job.id).toBe(id)
    const paths = jobPaths(t.repo, id)
    expect(loadJob(paths.jobFile)).toMatchObject({ id, stage: 'requirements', feature: 'Add dark mode', slot: 1 })
    expect(await git(paths.worktree, 'branch', '--show-current')).toBe(`factory/${id}`)
    expect(readFileSync(join(t.repo, '.git/info/exclude'), 'utf8')).toContain('/.factory/')
    expect(t.spawner.calls).toEqual([['ensureSession', id, paths.worktree, driverCommand(id)]])
    expect(t.out).toEqual([
      `✓ job ${id}`,
      `✓ worktree ${paths.worktree}`,
      `✓ tmux session factory-${id}`,
      `Answer the grill: factory attach ${id}`,
    ])
  })

  test('new runs setup in the worktree; a failing command is printed with its output and nothing is left', async () => {
    const t = await setup({
      branches: true,
      config: { setup: ['true', 'npm ci'] },
      exec: [{ match: ['bash', '-c', 'exec 2>&1\nnpm ci'], result: { code: 3, stdout: 'npm ERR! missing lockfile\n' } }],
    })
    await expect(newJob(t.repo, 'Add dark mode', t.deps, { attach: false })).rejects.toThrow('setup: npm ci failed (exit 3)')
    const id = '261126-add-dark-mode'
    const setupCalls = t.exec.calls.filter((c) => c[0] === 'bash')
    expect(setupCalls).toEqual([['bash', '-c', 'exec 2>&1\ntrue'], ['bash', '-c', 'exec 2>&1\nnpm ci']])
    expect(t.out).toEqual([
      `✓ job ${id}`,
      `✓ worktree ${jobPaths(t.repo, id).worktree}`,
      '✗ setup: npm ci failed (exit 3)',
      '    npm ERR! missing lockfile',
      `  removed job ${id}, its worktree and branch`,
    ])
    expect(existsSync(jobPaths(t.repo, id).jobDir)).toBe(false)
    expect(existsSync(jobPaths(t.repo, id).worktree)).toBe(false)
    expect(await git(t.repo, 'branch', '--list', `factory/${id}`)).toBe('')
    expect(t.spawner.calls).toEqual([])
  })

  test('inside tmux, new switches the client to the job session', async () => {
    const t = await setup({ branches: true, terminal: { tmux: true, tty: true } })
    const job = await newJob(t.repo, 'Add dark mode', t.deps, { attach: true, terminal: t.terminal })
    expect(t.exec.calls).toContainEqual(['tmux', 'switch-client', '-t', `=factory-${job.id}`])
    expect(t.handedOver).toEqual([])
  })

  test('outside tmux on a terminal, new attaches; --no-attach only prints how', async () => {
    const t = await setup({ branches: true, terminal: { tty: true } })
    const job = await newJob(t.repo, 'Add dark mode', t.deps, { attach: true, terminal: t.terminal })
    expect(t.handedOver).toEqual([['tmux', 'attach', '-t', `=factory-${job.id}`]])
    const second = await newJob(t.repo, 'Add dark mode', t.deps, { attach: false, terminal: t.terminal })
    expect(t.handedOver).toHaveLength(1)
    expect(t.out.at(-1)).toBe(`Answer the grill: factory attach ${second.id}`)
  })
})

describe('approve and retry', () => {
  test('approve finalizes a job in human review and restarts the driver', async () => {
    const t = await setup()
    await t.job({ stage: 'human-review', waitingFor: 'human-review', pr: PR })
    const job = await approve(t.repo, ID, t.deps)
    expect(job).toMatchObject({ stage: 'finalize', ready: true, waitingFor: null })
    expect(t.load().stage).toBe('finalize')
    expect(t.spawner.calls).toEqual([['respawnDriver', ID, t.paths.worktree, driverCommand(ID)]])
    expect(readFileSync(t.paths.activityLog, 'utf8')).toMatch(/^\d\d:\d\d:\d\d approve: human-review → finalize$/m)
  })

  test('retry resumes the failed stage and restarts the driver', async () => {
    const t = await setup()
    await t.job({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'design', reason: 'boom' })
    expect((await retry(t.repo, ID, t.deps)).stage).toBe('design')
    expect(t.spawner.calls).toEqual([['respawnDriver', ID, t.paths.worktree, driverCommand(ID)]])
  })

  test('a driver tmux could not start is an error, not a success', async () => {
    const t = await setup()
    await t.job({ stage: 'human-review', waitingFor: 'human-review', pr: PR })
    t.deps.spawner = new TmuxSpawner(new FakeExec([
      { match: ['tmux', 'has-session'], result: { code: 1 } },
      { match: ['tmux', 'new-session'], result: { code: 1, stderr: 'no server running on /tmp/tmux-501/default\n' } },
    ]))
    expect(await t.run('approve', ID)).toBe(1)
    expect(t.err).toEqual([`factory: tmux: could not start the driver for ${ID}: no server running on /tmp/tmux-501/default`])
    expect(t.out).toEqual([])
  })

  test('approve where there is nothing to approve fails without a stack trace', async () => {
    const t = await setup()
    await t.job({ stage: 'build', waitingFor: null })
    expect(await t.run('approve', ID)).toBe(1)
    expect(t.err).toEqual([`factory: nothing to approve: ${ID} is in build`])
    expect(t.spawner.calls).toEqual([])
  })
})

describe('feedback', () => {
  const comments = (list: object[]) => ({ stdout: JSON.stringify({ comments: list, reviews: [] }) })

  test('feedback with nothing new exits with "nothing new to send"', async () => {
    const t = await setup({ gh: [{ match: ['gh', 'pr', 'view'], result: comments([]) }] })
    await t.job({ stage: 'human-review', waitingFor: 'human-review', pr: PR })
    expect(await t.run('feedback', ID)).toBe(1)
    expect(t.err).toEqual(['factory: nothing new to send'])
    expect(existsSync(t.paths.feedback(1))).toBe(false)
    expect(t.load().stage).toBe('human-review')
  })

  test('feedback on a done job turns the PR back to draft', async () => {
    const t = await setup({ gh: [{ match: ['gh', 'pr', 'view'], result: comments([]) }] })
    await t.job({ stage: 'done', waitingFor: null, planned: true, pr: PR, trip: 1, cycle: 1 })
    const job = await feedback(t.repo, ID, 'Use Redis for the counter', t.deps)
    expect(t.gh('pr', 'ready')).toEqual([['gh', 'pr', 'ready', PR, '--undo']])
    expect(job).toMatchObject({ stage: 'planning', cycle: 2, trip: 1, feedbackCount: 1, reasonFile: t.paths.feedback(1) })
    expect(t.load().stage).toBe('planning')
    expect(t.spawner.calls).toEqual([
      ['kill', ID, 'driver'],
      ['killAgents', ID],
      ['respawnDriver', ID, t.paths.worktree, driverCommand(ID)],
    ])
  })

  test('a revived done job takes a free slot when another job holds its own; a free slot is kept', async () => {
    const t = await setup({ gh: [{ match: ['gh', 'pr', 'view'], result: comments([]) }] })
    const other = (id: string, slot: number, stage: Job['stage']) =>
      saveJob(jobPaths(t.repo, id).jobFile, { ...createJob({ id, feature: 'x', repo: t.repo, slot, now: NOW }), stage }, NOW)
    await t.job({ stage: 'done', waitingFor: null, planned: true, pr: PR, trip: 1, cycle: 1, slot: 1 })
    other('261126-live1', 1, 'build') // took slot 1 once ours was done
    other('261126-live2', 2, 'review')
    other('261126-old', 3, 'done') // done: holds no slot
    other('261126-gone', 4, 'discarded')
    expect((await feedback(t.repo, ID, 'Use Redis', t.deps)).slot).toBe(3)
    expect(t.load().slot).toBe(3)
    expect((await feedback(t.repo, '261126-old', 'Again', t.deps)).slot).toBe(4)
    other('261126-done5', 5, 'done')
    expect((await feedback(t.repo, '261126-done5', 'Free', t.deps)).slot).toBe(5)
  })

  test('feedback collects PR comments since the last feedback file, verbatim, with the note last', async () => {
    const t = await setup({
      gh: [
        {
          match: ['gh', 'pr', 'view'],
          result: comments([
            { author: { login: 'old' }, body: 'already sent', createdAt: '2026-11-26T08:00:00Z' },
            { author: { login: 'alice' }, body: 'Please `rename` $(this)\n\nand this', createdAt: '2026-11-26T11:00:00Z' },
          ]),
        },
        {
          match: ['gh', 'api'],
          result: { stdout: JSON.stringify([{ user: { login: 'bob' }, body: 'off by one', path: 'src/a.ts', line: 12, created_at: '2026-11-26T11:30:00Z' }]) },
        },
      ],
    })
    await t.job({ stage: 'human-review', waitingFor: 'human-review', pr: PR, feedbackCount: 1, planned: true })
    writeFileSync(t.paths.feedback(1), 'earlier\n')
    utimesSync(t.paths.feedback(1), new Date('2026-11-26T09:00:00Z'), new Date('2026-11-26T09:00:00Z'))
    await feedback(t.repo, ID, 'Also add a test', t.deps)
    expect(readFileSync(t.paths.feedback(2), 'utf8')).toBe(
      [
        `# Feedback 2 for ${ID}`,
        '',
        '## PR comments',
        '',
        '### @alice',
        '',
        'Please `rename` $(this)',
        '',
        'and this',
        '',
        '### @bob on src/a.ts:12',
        '',
        'off by one',
        '',
        '## Note',
        '',
        'Also add a test',
        '',
      ].join('\n'),
    )
    expect(t.gh('pr', 'ready')).toEqual([])
    expect(t.load()).toMatchObject({ stage: 'planning', feedbackCount: 2, cycle: 2 })
  })

  test('feedback without a PR takes the note alone; a discarded job refuses', async () => {
    const t = await setup()
    await t.job({ stage: 'tech-discovery', waitingFor: null })
    await feedback(t.repo, ID, 'Keep it small', t.deps)
    expect(readFileSync(t.paths.feedback(1), 'utf8')).toBe(`# Feedback 1 for ${ID}\n\n## Note\n\nKeep it small\n`)
    expect(t.load()).toMatchObject({ stage: 'requirements', reasonFile: t.paths.feedback(1) })
    expect(t.ghExec.calls).toEqual([])
    await t.job({ stage: 'discarded', waitingFor: null })
    await expect(feedback(t.repo, ID, 'x', t.deps)).rejects.toThrow(`cannot send feedback: ${ID} is discarded`)
  })
})

describe('discard', () => {
  test('discard removes worktree and branch and keeps the job folder', async () => {
    const t = await setup({ branches: true })
    await t.job({ stage: 'build', waitingFor: null, pr: PR }, true)
    expect(await git(t.repo, 'branch', '--list', `factory/${ID}`)).toContain(`factory/${ID}`)
    const job = await discard(t.repo, ID, t.deps)
    expect(job.stage).toBe('discarded')
    expect(existsSync(t.paths.worktree)).toBe(false)
    expect(await git(t.repo, 'branch', '--list', `factory/${ID}`)).toBe('')
    expect(existsSync(t.paths.jobDir)).toBe(true)
    expect(t.load().stage).toBe('discarded')
    expect(t.spawner.calls).toEqual([['killSession', ID]])
    expect(t.gh('pr', 'close')).toEqual([['gh', 'pr', 'close', PR, '--delete-branch']])
  })

  test('a failing step is reported and the rest still runs', async () => {
    const t = await setup({ branches: true, gh: [{ match: ['gh', 'pr', 'close'], result: { code: 1, stderr: 'already merged' } }] })
    await t.job({ stage: 'human-review', waitingFor: 'human-review', pr: PR }, true)
    await discard(t.repo, ID, t.deps)
    expect(t.out.some((l) => l.startsWith('✗ close PR #9: gh pr close') && l.includes('already merged'))).toBe(true)
    expect(existsSync(t.paths.worktree)).toBe(false)
    expect(t.load().stage).toBe('discarded')
  })

  test('on a terminal, discard asks first; no means nothing changes', async () => {
    const t = await setup({ terminal: { tty: true }, confirm: false })
    await t.job({ stage: 'build', waitingFor: null, pr: PR })
    expect(await t.run('discard', ID)).toBe(1)
    expect(t.questions).toEqual([
      `Discard ${ID}? This closes PR #9 and deletes factory/${ID} and its worktree. [y/N]`,
    ])
    expect(t.load().stage).toBe('build')
    expect(t.spawner.calls).toEqual([])
  })

  test('--yes skips the question', async () => {
    const t = await setup({ terminal: { tty: true } })
    await t.job({ stage: 'build', waitingFor: null })
    expect(await t.run('discard', ID, '--yes')).toBe(0)
    expect(t.questions).toEqual([])
    expect(t.load().stage).toBe('discarded')
  })
})

describe('run', () => {
  test('run on a failed job retries, then drives it', async () => {
    const t = await setup()
    await t.job({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'human-review', reason: 'boom', pr: PR })
    expect(await t.run('run', ID)).toBe(0)
    expect(t.load().stage).toBe('human-review')
    expect(t.out).toContain(`${ID}: retrying from human-review`)
    expect(t.out.at(-1)).toBe(`${ID}: next: factory approve ${ID}   or   factory feedback ${ID} "…"`)
    expect(t.spawner.calls).toEqual([])
  })

  test('run on an escalation prints why it cannot retry and what to do instead', async () => {
    const t = await setup()
    await t.job({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'test-planning' })
    expect(await t.run('run', ID)).toBe(1)
    expect(t.err).toEqual([`factory: nothing to retry: ${ID} is in needs-human waiting for escalation`])
    expect(t.out).toEqual([`next: factory approve ${ID}   or   factory feedback ${ID} "…"`])
  })

  test('run on a v1 job refuses', async () => {
    const t = await setup()
    mkdirSync(join(t.repo, '.factory/jobs/003-old'), { recursive: true })
    writeFileSync(join(t.repo, '.factory/jobs/003-old/job.json'), '{"id":"003-old","stage":"review"}')
    expect(await t.run('run', '003-old')).toBe(1)
    expect(t.err).toEqual(['factory: 003-old is a v1 job; v2 cannot drive it'])
  })

  test('run without a tmux session starts the driver in a new one', async () => {
    const t = await setup({ exec: [{ match: ['tmux', 'has-session'], result: { code: 1 } }] })
    await t.job({ stage: 'build', waitingFor: null })
    expect(await t.run('run', ID)).toBe(0)
    expect(t.spawner.calls).toEqual([['respawnDriver', ID, t.paths.worktree, driverCommand(ID)]])
    expect(t.out).toEqual([`✓ driver started in tmux session factory-${ID}`, `next: factory attach ${ID} to watch`])
  })
})

describe('status', () => {
  test('no jobs', async () => {
    const t = await setup()
    expect(await t.run('status')).toBe(0)
    expect(t.out).toEqual(['No factory jobs yet. Start one: factory new "<feature>"'])
  })

  test('the table, then what to type for each job that needs you', async () => {
    const t = await setup()
    await t.job({ stage: 'human-review', waitingFor: 'human-review', waitingSince: NOW.toISOString(), pr: PR, trip: 1 })
    expect(await t.run('status')).toBe(0)
    expect(t.out.join('\n')).toBe(
      [
        '  JOB       STAGE         TRIP  WAITING    PR  AGE',
        '● 261126-x  human-review  1     review 0s  #9  0s',
        '',
        `next: factory approve ${ID}   or   factory feedback ${ID} "…"`,
      ].join('\n'),
    )
  })

  test('one job: header, pipeline, what it waits for, running agents, activity, next', async () => {
    const t = await setup()
    await t.job({ stage: 'needs-human', waitingFor: 'failure', resumeStage: 'design', reason: 'designer: exited with code 3', running: ['tech-discoverer'] })
    mkdirSync(t.paths.jobDir, { recursive: true })
    writeFileSync(t.paths.activityLog, Array.from({ length: 12 }, (_, i) => `10:00:${String(i).padStart(2, '0')} line ${i}`).join('\n') + '\n')
    expect(await t.run('status', ID)).toBe(0)
    expect(t.out.join('\n')).toBe(
      [
        `${ID}  Add the thing`,
        'needs-human · cycle 1',
        'Discovery ✗ design ─ Building ○ ─ Validation ○ ─ Deploy ○',
        '',
        'Needs you: Failed: designer: exited with code 3',
        'Running: tech-discoverer',
        '',
        ...Array.from({ length: 10 }, (_, i) => `  10:00:${String(i + 2).padStart(2, '0')} line ${i + 2}`),
        '',
        `next: factory run ${ID} to retry   or   factory discard ${ID}`,
      ].join('\n'),
    )
  })

  test('--json prints the jobs, pretty', async () => {
    const t = await setup()
    const job = await t.job()
    expect(await t.run('status', '--json')).toBe(0)
    expect(t.out.join('\n')).toBe(JSON.stringify([{ ...job, updatedAt: NOW.toISOString() }], null, 2))
    t.out.length = 0
    expect(await t.run('status', ID, '--json')).toBe(0)
    expect(JSON.parse(t.out.join('\n')).id).toBe(ID)
  })

  test('an unknown job id', async () => {
    const t = await setup()
    expect(await t.run('status', 'nope')).toBe(1)
    expect(t.err).toEqual(['factory: no job nope (see: factory status)'])
  })
})

describe('logs', () => {
  async function withLogs() {
    const t = await setup()
    await t.job({ stage: 'build', waitingFor: null })
    mkdirSync(t.paths.logsDir, { recursive: true })
    const claude = readFileSync(join(STREAM, 'claude.jsonl'), 'utf8')
    const pi = readFileSync(join(STREAM, 'pi.jsonl'), 'utf8')
    writeFileSync(join(t.paths.logsDir, 'planner-1.log'), 'old run\n')
    writeFileSync(join(t.paths.logsDir, 'planner-2.log'), claude)
    writeFileSync(join(t.paths.logsDir, 'builder-backend-1.log'), pi)
    utimesSync(join(t.paths.logsDir, 'planner-2.log'), new Date(2026, 10, 26, 9), new Date(2026, 10, 26, 9))
    return t
  }

  test('a role: its latest log, formatted by the log format', async () => {
    const t = await withLogs()
    expect(await t.run('logs', ID, 'planner')).toBe(0)
    expect(t.out[0]).toBe('logs/planner-2.log')
    expect(t.out).toContain('▸ Bash  ls -la /tmp/work')
    expect(t.out).toContain('✓ done in 3m12s · $0.42')
  })

  test('no role: the latest log of any role; pi logs read as pi', async () => {
    const t = await withLogs()
    expect(await t.run('logs', ID)).toBe(0)
    expect(t.out).toEqual(['logs/builder-backend-1.log', "I'll list the files.", '▸ bash  ls -la', '▸ read  missing.txt',
      '✗ read: ENOENT: no such file', 'There are two files: a.txt and b.md.', '✓ done'])
  })

  test('only the last 200 lines', async () => {
    const t = await setup()
    await t.job({ stage: 'build', waitingFor: null })
    mkdirSync(t.paths.logsDir, { recursive: true })
    writeFileSync(join(t.paths.logsDir, 'planner-1.log'), Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n')
    expect(await t.run('logs', ID)).toBe(0)
    expect(t.out).toHaveLength(201)
    expect(t.out[1]).toBe('line 50')
  })

  test('-f follows the log until the agent is done', async () => {
    const t = await withLogs()
    const file = join(t.paths.logsDir, 'planner-2.log')
    let ticks = 0
    t.deps.sleep = async () => {
      ticks++
      if (ticks === 1) writeFileSync(file, `${readFileSync(file, 'utf8')}not json, shown as is\n`)
      if (ticks === 2) {
        mkdirSync(t.paths.doneDir, { recursive: true })
        writeFileSync(join(t.paths.doneDir, 'planner-2'), '0\n')
      }
    }
    expect(await t.run('logs', ID, 'planner', '-f')).toBe(0)
    expect(t.out.at(-1)).toBe('not json, shown as is')
  })

  test('no logs yet', async () => {
    const t = await setup()
    await t.job()
    expect(await t.run('logs', ID)).toBe(1)
    expect(t.err).toEqual([`factory: no logs for ${ID} yet`])
    expect(await t.run('logs', ID, 'planner')).toBe(1)
    expect(t.err.at(-1)).toBe(`factory: no planner logs for ${ID}`)
  })
})

describe('cli', () => {
  test('unknown command prints help hint and exits 1', async () => {
    const t = await setup()
    expect(await main(['frobnicate'], t.cli)).toBe(1)
    expect(t.err).toEqual(['factory: unknown command "frobnicate" (see: factory help)'])
  })

  test('an unknown option is an error', async () => {
    const t = await setup()
    expect(await main(['status', '--bogus'], t.cli)).toBe(1)
    expect(t.err).toEqual(['factory: unknown option --bogus for status (see: factory help)'])
  })

  test('-- ends the options, so a feature can start with a dash', async () => {
    const t = await setup({ branches: true })
    expect(await main(['new', '--no-attach', '--repo', t.repo, '--', '-x feature'], t.cli)).toBe(0)
    const [id] = readdirSync(join(t.repo, '.factory/jobs'))
    expect(loadJob(jobPaths(t.repo, id!).jobFile)).toMatchObject({ feature: '-x feature' })
  })

  test('help lists every command in order, each with an example', async () => {
    const t = await setup()
    expect(await main(['help'], t.cli)).toBe(0)
    const text = t.out.join('\n')
    const order = ['new', 'status', 'attach', 'logs', 'approve', 'feedback', 'run', 'discard', 'dashboard', 'help']
    const at = order.map((c) => text.indexOf(`\n  ${c}`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const c of order) expect(text).toContain(`factory ${c}`)
    expect(text).not.toMatch(/\btail\b/)
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(80)
    t.out.length = 0
    expect(await main([], t.cli)).toBe(0)
    expect(t.out.join('\n')).toBe(text)
  })

  test('errors never show a stack trace unless FACTORY_DEBUG=1', async () => {
    const t = await setup()
    expect(await t.run('approve', 'nope')).toBe(1)
    expect(t.err).toEqual(['factory: no job nope (see: factory status)'])
    process.env.FACTORY_DEBUG = '1'
    try {
      expect(await t.run('approve', 'nope')).toBe(1)
      expect(t.err.at(-1)).toContain('at ')
    } finally {
      delete process.env.FACTORY_DEBUG
    }
  })

  test('the dashboard serves on the given port and rejects a bad one', async () => {
    const t = await setup()
    await t.job()
    const server = serveDashboard({ pos: [], flags: { port: '0' } }, t.cli, t.repo)
    try {
      expect(t.out).toEqual([`Factory dashboard: http://127.0.0.1:${server.port}`])
      const body = (await (await fetch(`http://127.0.0.1:${server.port}/api/jobs`)).json()) as { jobs: { id: string }[] }
      expect(body.jobs.map((j) => j.id)).toEqual([ID])
    } finally {
      server.stop(true)
    }
    expect(await t.run('dashboard', '--port', '70000')).toBe(1)
    expect(t.err).toEqual(['factory: not a port: 70000'])
  })

  test('attach needs the job session', async () => {
    const t = await setup({ exec: [{ match: ['tmux', 'has-session'], result: { code: 1 } }] })
    await t.job()
    expect(await t.run('attach', ID)).toBe(1)
    expect(t.err).toEqual([`factory: no tmux session factory-${ID} (start the driver: factory run ${ID})`])
  })

  test('attach switches inside tmux and attaches outside', async () => {
    const t = await setup({ terminal: { tmux: true } })
    await t.job()
    expect(await t.run('attach', ID)).toBe(0)
    expect(t.exec.calls).toContainEqual(['tmux', 'switch-client', '-t', `=factory-${ID}`])
    t.terminal.tmux = false
    t.terminal.tty = true
    expect(await t.run('attach', ID)).toBe(0)
    expect(t.handedOver).toEqual([['tmux', 'attach', '-t', `=factory-${ID}`]])
  })
})
