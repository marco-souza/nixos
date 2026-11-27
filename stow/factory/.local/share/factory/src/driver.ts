import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { KNOWN_VALIDATORS, loadConfig, type FactoryConfig } from './config'
import type { Deps } from './deps'
import { checkOutput, LENSES, SPECIALISTS, type OutputKind } from './handoff'
import { buildCommand, renderTaskPrompt, resolveHarness } from './harness'
import { appendActivity, loadJob, saveJob, type Job } from './job'
import { acquireLock } from './lock'
import { isWaiting, route, type Outcome } from './machine'
import { CLI_PATH, jobPaths, type JobPaths } from './paths'
import { mergeDecision, mergeStatus, renderStatus } from './prbody'
import { loadRole } from './roles'
import { shq } from './shell'
import { readExitCode, waitForFile, type SpawnRequest } from './spawn'
import { docLinks, STAGES, type AgentResult, type AgentSpec, type Ctx } from './stages'
import { nextHint, whatFor } from './ui'

export type { Deps } from './deps'

export const REQUIRED_ROLES: string[] = [
  'requirements', 'tech-discoverer', 'designer', 'discovery-reviewer', 'planner',
  ...SPECIALISTS.map((s) => `builder-${s}`),
  ...LENSES.map((l) => `reviewer-${l}`),
  'build-judge', 'test-planner',
  ...KNOWN_VALIDATORS.map((v) => `validator-${v}`),
  'validation-judge', 'resolver', 'summarizer',
]

const POLL_MS = 2000

/** Outputs whose path every visit of their stage reuses: only a write during the current visit counts. */
const REUSED: OutputKind[] = ['requirements', 'tech-discovery', 'design', 'spec', 'test-plan', 'pr']

/** The command a tmux driver window runs: `--here` drives the job in that window. */
export function driverCommand(id: string): string {
  return `${shq(process.execPath)} ${shq(CLI_PATH)} run ${shq(id)} --here`
}

/** Runs the job until it waits on the human, is done or is discarded. */
export async function runJob(repo: string, id: string, deps: Deps): Promise<'waiting' | 'done' | 'discarded'> {
  const paths = jobPaths(repo, id)
  if (!existsSync(paths.jobFile)) throw new Error(`no job ${id} in ${paths.jobsDir}`)
  const release = acquireLock(paths.jobDir)
  try {
    const job = loadJob(paths.jobFile)
    if ('legacy' in job) throw new Error(`${id} is a v1 job; v2 cannot drive it`)
    const c = context(repo, paths, loadConfig(repo), deps, job)
    await stopLeftovers(c)
    let moved = false
    while (!isWaiting(c.job)) {
      await step(c)
      moved = true
    }
    return await stop(c, moved)
  } finally {
    release()
  }
}

/** Run the current stage, route its outcome, save, log, update the PR. */
async function step(c: Ctx): Promise<void> {
  const from = c.job.stage
  enterVisit(c)
  if (from === 'requirements') {
    c.deps.log(`${c.job.id}: answer the grill: factory attach ${c.job.id}`)
    await c.deps.notify({ title: `${c.job.id} needs you`, message: `Answer the grill: factory attach ${c.job.id}` })
  }
  let outcome: Outcome
  try {
    outcome = await STAGES[from]!(c)
  } catch (e) {
    // A git, gh, hook or config error stops the job for the human with the exact message.
    outcome = { kind: 'failed', stage: from, reason: (e as Error).message }
  }
  const next = route(c.job, outcome, { maxTrips: c.cfg.maxTrips, maxDiscoveryLoops: c.cfg.maxDiscoveryLoops }, c.deps.now())
  c.update(next)
  c.note(`${from} → ${next.stage}${detail(outcome, next)}`)
  await updatePr(c)
}

async function stop(c: Ctx, moved: boolean): Promise<'waiting' | 'done' | 'discarded'> {
  const job = c.job
  if (job.stage === 'discarded') return 'discarded'
  if (job.stage === 'done') {
    c.deps.log(`${job.id}: done${job.pr ? ` ${job.pr}` : ''}`)
    return 'done'
  }
  const why = whatFor(job) ?? job.stage
  if (moved) await c.deps.notify({ title: `${job.id} needs you`, message: why })
  c.deps.log(`${job.id}: ${why}`)
  const hint = nextHint(job)
  if (hint) c.deps.log(`${job.id}: next: ${hint}`)
  return 'waiting'
}

/** ` (verdicts or reason)` for a transition line. */
function detail(o: Outcome, next: Job): string {
  const parts: string[] = []
  if (o.kind === 'failed') parts.push(o.reason)
  else if (o.stage === 'review' || o.stage === 'validation') {
    const t = next.trips[next.trips.length - 1]
    parts.push(verdicts(o.stage === 'review' ? t?.reviews : t?.validations))
  } else if (o.verdict) parts.push(o.reworkStep ? `${o.verdict} ${o.reworkStep}` : o.verdict)
  else if (o.humanQuestions) parts.push('questions for the human')
  if (o.kind === 'done' && next.stage === 'needs-human' && next.reason) parts.push(next.reason)
  const s = parts.filter(Boolean).join('; ')
  return s ? ` (${s})` : ''
}

function verdicts(rec: Record<string, string> = {}): string {
  const all = Object.entries(rec)
  const odd = all.filter(([, v]) => v !== 'PASS')
  if (!all.length) return ''
  if (!odd.length) return 'all PASS'
  return [...odd.map(([k, v]) => `${k} ${v}`), ...(odd.length < all.length ? ['others PASS'] : [])].join(', ')
}

/** The PR's status block (and an escalation's decision section), refreshed on every transition. Cosmetic: a failure is noted, never fatal. */
async function updatePr(c: Ctx): Promise<void> {
  const pr = c.job.pr
  if (!pr) return
  try {
    const body = mergeStatus((await c.deps.gh.viewBody(pr)).trimEnd(), renderStatus(c.job, c.cfg, await docLinks(c)))
    const file = join(c.paths.jobDir, 'pr-body.md')
    writeFileSync(file, `${mergeDecision(body, decision(c)).trimEnd()}\n`)
    await c.deps.gh.editBody(pr, file)
  } catch (e) {
    c.note(`PR status update failed: ${(e as Error).message}`)
  }
}

/** What an escalation pause asks the human, for the top of the PR body; null when the job isn't in one. */
function decision(c: Ctx): string | null {
  const job = c.job
  if (job.stage !== 'needs-human' || job.waitingFor !== 'escalation') return null
  const head = '## ⏸ Needs your decision'
  const where = (file: string | null) => (file ? relative(c.repo, file) : 'the trip folder')
  if (job.capHit === 'env') return `${head}\n\nQA environment failed twice; validators' evidence: ${where(job.reasonFile)}`
  const file = job.questionsFile ?? job.reasonFile
  const questions = file && existsSync(file) ? questionsOf(readFileSync(file, 'utf8')) : ''
  return `${head}\n\n${questions || `See ${where(file)}.`}`
}

/** The body of a judge file's `## Questions` section. */
function questionsOf(text: string): string {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.replace(/:?\s*$/, '') === '## Questions')
  if (at < 0) return ''
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

function context(repo: string, paths: JobPaths, cfg: FactoryConfig, deps: Deps, job: Job): Ctx {
  let nameWithOwner: Promise<string | null> | null = null
  const c: Ctx = {
    repo, paths, cfg, deps, job,
    update(patch) {
      c.job = { ...c.job, ...(typeof patch === 'function' ? patch(c.job) : patch) }
      saveJob(paths.jobFile, c.job, deps.now())
    },
    note(line) {
      appendActivity(paths.activityLog, line, deps.now())
      deps.log(`${c.job.id}: ${line}`)
    },
    spawn: (specs) => runAgents(c, specs),
    nameWithOwner: () => (nameWithOwner ??= deps.gh.nameWithOwner().catch(() => null)),
  }
  return c
}

/** Agents a dead driver left running would race the ones this driver starts. */
async function stopLeftovers(c: Ctx): Promise<void> {
  if (!c.job.running.length) return
  for (const w of c.job.running) {
    if (await c.deps.spawner.isAlive(c.job.id, w)) {
      await c.deps.spawner.kill(c.job.id, w)
      c.note(`stopped ${w}, left running by an earlier driver`)
    }
  }
  c.update({ running: [] })
}

// A visit is one stay in a stage. Its marker file's mtime is when the visit began; its content says which visit.
const visitFile = (c: Ctx) => join(c.paths.runDir, 'visit')
const visitKey = (j: Job) => `${j.stage} cycle ${j.cycle} trip ${j.trip} loop ${j.discoveryLoops}\n`

function enterVisit(c: Ctx): void {
  const file = visitFile(c)
  const key = visitKey(c.job)
  if (existsSync(file) && readFileSync(file, 'utf8') === key) return
  mkdirSync(c.paths.runDir, { recursive: true })
  writeFileSync(file, key)
}

function writtenThisVisit(c: Ctx, file: string): boolean {
  const marker = visitFile(c)
  return existsSync(file) && existsSync(marker) && statSync(file).mtimeMs >= statSync(marker).mtimeMs
}

/** A path relative to the job folder or the worktree, for log lines. */
function show(c: Ctx, file: string): string {
  const inJob = relative(c.paths.jobDir, file)
  return inJob.startsWith('..') ? relative(c.job.worktree, file) : inJob
}

function inspect(c: Ctx, s: AgentSpec): AgentResult {
  if (!existsSync(s.output)) return { ok: false, problem: `no output at ${show(c, s.output)}` }
  const text = readFileSync(s.output, 'utf8')
  const r = s.check ? s.check(text) : checkOutput(s.kind, text, c.cfg)
  return r.ok ? { ok: true, verdict: r.verdict, text } : { ok: false, problem: `${show(c, s.output)}: ${r.problem}` }
}

/** An output already there counts as done when it passes its check, isn't BLOCKED, and (at a reused path) is from this visit. */
function reusable(c: Ctx, s: AgentSpec): AgentResult | null {
  if (s.resume === false || !existsSync(s.output)) return null
  const r = inspect(c, s)
  if (!r.ok || r.verdict === 'BLOCKED') return null
  if (REUSED.includes(s.kind) && !writtenThisVisit(c, s.output)) return null
  return r
}

async function runAgents(c: Ctx, specs: AgentSpec[]): Promise<AgentResult[]> {
  const skipped = specs.map((s) => reusable(c, s))
  // A role or harness error fails the stage before any agent starts, so none is left running.
  for (const [i, s] of specs.entries()) if (!skipped[i]) resolveHarness(loadRole(c.deps.rolesDir, s.role), c.cfg)
  const first: (Attempt | null)[] = []
  try {
    for (const [i, s] of specs.entries()) {
      const r = skipped[i]
      if (r?.ok) c.note(`skip ${s.role}: ${show(c, s.output)} is already done${r.verdict ? ` (${r.verdict})` : ''}`)
      first.push(r ? null : await startAgent(c, s))
    }
  } catch (e) {
    // Never leave half a group running: stop the agents this group already started.
    const started = first.flatMap((a) => (a ? [a.window] : []))
    for (const w of started) {
      await c.deps.spawner.kill(c.job.id, w)
      c.note(`stopped ${w}: the rest of its group could not start`)
    }
    c.update((j) => ({ running: j.running.filter((w) => !started.includes(w)) }))
    throw e
  }
  // allSettled: never return while an agent is still being waited on.
  const settled = await Promise.allSettled(
    specs.map(async (s, i): Promise<AgentResult> => {
      let r = skipped[i] ?? (await finishAgent(c, first[i]!))
      if (!r.ok) {
        r = await finishAgent(c, await startAgent(c, s))
        if (!r.ok) r = { ok: false, problem: `${s.role}: ${r.problem}` }
      }
      s.onResult?.(r)
      return r
    }),
  )
  const error = settled.find((x): x is PromiseRejectedResult => x.status === 'rejected')
  if (error) throw error.reason
  return settled.map((x) => (x as PromiseFulfilledResult<AgentResult>).value)
}

interface Attempt {
  spec: AgentSpec
  window: string
  req: SpawnRequest
  interactive: boolean
  timeoutMin: number
}

/** Attempt numbers count every spawn of a role in this job: retries, loops and trips. */
function nextAttempt(runDir: string, role: string): number {
  const re = new RegExp(`^${role}-(\\d+)\\.task\\.md$`)
  let n = 0
  for (const f of readdirSync(runDir)) n = Math.max(n, Number(re.exec(f)?.[1] ?? 0))
  return n + 1
}

async function startAgent(c: Ctx, s: AgentSpec): Promise<Attempt> {
  const role = loadRole(c.deps.rolesDir, s.role)
  const h = resolveHarness(role, c.cfg)
  const { paths, job } = c
  for (const d of [paths.runDir, paths.logsDir, paths.doneDir, dirname(s.output)]) mkdirSync(d, { recursive: true })
  const n = nextAttempt(paths.runDir, s.role)
  const base = join(paths.runDir, `${s.role}-${n}`)
  const files = { system: `${base}.system.md`, task: `${base}.task.md` }
  writeFileSync(files.system, `${role.body}\n`)
  const prompt = renderTaskPrompt({ job, paths, cfg: c.cfg, assignment: s.assignment, output: s.output, inputs: s.inputs ?? [], target: s.target ?? null })
  writeFileSync(files.task, `${prompt}\n`)
  // ASCII only: tmux targets and terminals handle it everywhere. The dashboard maps logs to windows the same way.
  const window = n === 1 ? s.role : `${s.role}-${n}`
  const req: SpawnRequest = {
    jobId: job.id,
    window,
    cwd: job.worktree,
    command: c.deps.commandFor ? c.deps.commandFor(s.role, { ...files, harness: h.harness }) : buildCommand(role, h, files, paths.jobDir),
    scriptFile: `${base}.sh`,
    logFile: join(paths.logsDir, `${s.role}-${n}.log`),
    doneFile: join(paths.doneDir, `${s.role}-${n}`),
    interactive: role.interactive,
    tail: role.interactive ? null : h.harness,
  }
  c.update((j) => ({ running: [...j.running, window] }))
  c.note(`start ${window} (${h.harness}${h.model ? ` ${h.model}` : ''})`)
  try {
    await c.deps.spawner.start(req)
  } catch (e) {
    c.update((j) => ({ running: j.running.filter((w) => w !== window) }))
    throw e
  }
  return { spec: s, window, req, interactive: role.interactive, timeoutMin: h.timeoutMin }
}

/** Waits for the attempt's done file (or, interactive, a valid new output), then checks it. */
async function finishAgent(c: Ctx, a: Attempt): Promise<AgentResult> {
  const { deps } = c
  const id = c.job.id
  const outputReady = () => a.interactive && writtenThisVisit(c, a.spec.output) && inspect(c, a.spec).ok
  let gone = false
  const state = await waitForFile(() => gone || existsSync(a.req.doneFile) || outputReady(), {
    // Interactive roles have no timeout: a human is answering.
    timeoutMs: a.interactive ? Infinity : a.timeoutMin * 60_000,
    pollMs: POLL_MS,
    now: () => deps.now().getTime(),
    // A window that vanished without its done file will never write one.
    sleep: async (ms) => {
      if (await deps.spawner.isAlive(id, a.window)) await deps.sleep(ms)
      else gone = true
    },
  })
  c.update((j) => ({ running: j.running.filter((w) => w !== a.window) }))
  const r: AgentResult = state === 'timeout' ? { ok: false, problem: `timed out after ${a.timeoutMin} min` } : result(c, a)
  // A failed window stays open for inspection.
  if (state === 'timeout' || r.ok) await deps.spawner.kill(id, a.window)
  c.note(`${a.window}: ${r.ok ? (r.verdict ?? 'ok') : r.problem}`)
  return r
}

function result(c: Ctx, a: Attempt): AgentResult {
  const r = inspect(c, a.spec)
  // At a reused path, a valid file from an earlier visit is not this agent's output.
  const stale = r.ok && REUSED.includes(a.spec.kind) && !writtenThisVisit(c, a.spec.output)
  const checked: AgentResult = stale ? { ok: false, problem: `${show(c, a.spec.output)} was not written` } : r
  if (a.interactive) return checked
  const code = readExitCode(a.req.doneFile)
  if (code === null) return { ok: false, problem: 'the window closed before the agent finished' }
  if (code !== 0) return { ok: false, problem: `exited with code ${code}` }
  return checked
}
