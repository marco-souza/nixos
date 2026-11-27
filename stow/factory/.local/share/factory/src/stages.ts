import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FactoryConfig } from './config'
import type { Deps } from './deps'
import {
  builderFor, checkOutput, hasHumanQuestions, outputPath, parseDiscoveryReview, parsePlan, parseTestPlan, SPECIALISTS,
  type Check, type OutputKind,
} from './handoff'
import { runHook, waitQaReady, type HookEnv, type HookName } from './hooks'
import type { Job, Stage, TripRecord } from './job'
import type { Outcome } from './machine'
import type { JobPaths } from './paths'
import { initialBody, proofCoverage, pushProof } from './prbody'
import { loadRole } from './roles'

export type AgentResult = { ok: true; verdict: string | null; text: string } | { ok: false; problem: string }

export interface AgentSpec {
  role: string
  kind: OutputKind
  output: string
  assignment: string
  inputs?: string[]
  target?: string | null
  /** Replaces the output's handoff check. */
  check?: (text: string) => Check
  /** false: spawn even when a valid output is already there. */
  resume?: boolean
  /** Called as each agent's result lands, skipped ones included. */
  onResult?: (r: AgentResult) => void
}

/** What a stage effect gets from the driver. */
export interface Ctx {
  repo: string
  paths: JobPaths
  cfg: FactoryConfig
  deps: Deps
  /** The latest saved job. */
  job: Job
  /** Merge into the job and save it. */
  update(patch: Partial<Job> | ((job: Job) => Partial<Job>)): void
  /** One line to activity.log and the driver window. */
  note(line: string): void
  /** Start every agent before waiting on any; a failed one runs once more. Agents whose output is already done are skipped. */
  spawn(specs: AgentSpec[]): Promise<AgentResult[]>
  nameWithOwner(): Promise<string | null>
}

type Step = (c: Ctx) => Promise<Outcome>
type DocName = 'requirements' | 'tech discovery' | 'design' | 'spec' | 'test plan'

const DOCS: Record<DocName, { kind: OutputKind; key: keyof FactoryConfig['docs'] }> = {
  requirements: { kind: 'requirements', key: 'requirements' },
  'tech discovery': { kind: 'tech-discovery', key: 'techDiscovery' },
  design: { kind: 'design', key: 'design' },
  spec: { kind: 'spec', key: 'specs' },
  'test plan': { kind: 'test-plan', key: 'testPlans' },
}

const read = (file: string) => readFileSync(file, 'utf8')
const present = (...files: (string | null)[]) => files.filter((f): f is string => !!f)
const done = (stage: Stage, o: Partial<Extract<Outcome, { kind: 'done' }>> = {}): Outcome => ({ kind: 'done', stage, ...o })
const failed = (stage: Stage, reason: string): Outcome => ({ kind: 'failed', stage, reason })
const firstProblem = (rs: AgentResult[]) => rs.flatMap((r) => (r.ok ? [] : [r.problem]))[0]

/** Output paths; the trip directory is the current TripRecord's (never reset across cycles). */
function out(c: Ctx, kind: OutputKind, name?: string): string {
  return outputPath(kind, { paths: c.paths, cfg: c.cfg, id: c.job.id, trip: c.job.trips.length, n: c.job.discovery.length + 1, name })
}

const docRel = (c: Ctx, d: DocName) => join(c.cfg.docs[DOCS[d].key], `${c.job.id}.md`)
const tripDir = (c: Ctx) => c.paths.tripDir(c.job.trips.length)
const localUrl = (c: Ctx, i: number) => `http://localhost:${5100 + 10 * c.job.slot + i}`

function tripFiles(c: Ctx, re: RegExp): string[] {
  const dir = tripDir(c)
  return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : []
}

/** Patch the current TripRecord. */
function setTrip(c: Ctx, patch: (t: TripRecord) => Partial<TripRecord>): void {
  c.update((j) => {
    if (!j.trips.length) return {}
    const trips = [...j.trips]
    trips[trips.length - 1] = { ...trips[trips.length - 1]!, ...patch(trips[trips.length - 1]!) }
    return { trips }
  })
}

/** Browser builders and reviewers get their own local dev server: QA lags behind the branch until qa-wait. */
function browserTarget(c: Ctx, role: string, i: number): string | null {
  return loadRole(c.deps.rolesDir, role).browser ? localUrl(c, i) : null
}

const push = (c: Ctx, force = false) => c.deps.git.push(c.job.worktree, c.job.branch, { force })

/** Spawn the role that writes `doc`, then commit it (with `alsoCommit`) and push. */
async function writeDoc(c: Ctx, role: string, doc: DocName, assignment: string, inputs: string[] = [], alsoCommit: DocName[] = []): Promise<AgentResult> {
  const [r] = await c.spawn([{ role, kind: DOCS[doc].kind, output: out(c, DOCS[doc].kind), assignment, inputs }])
  if (!r!.ok) return r!
  const paths = [doc, ...alsoCommit].map((d) => docRel(c, d))
  if (await c.deps.git.commitPaths(c.job.worktree, paths, `${c.cfg.docsCommitType}: ${doc} for ${c.job.id}`)) c.note(`committed the ${doc} doc`)
  await push(c)
  return r!
}

async function hookEnv(c: Ctx): Promise<HookEnv> {
  return { JOB: c.job.id, PR: c.job.pr ?? '', BRANCH: c.job.branch, SHA: await c.deps.git.head(c.job.worktree) }
}

/** Runs a configured hook: null when it isn't configured, else its result and, on a non-zero exit, the failure line. */
async function hook(c: Ctx, name: HookName): Promise<{ stdout: string; failure: string | null } | null> {
  if (!c.cfg.hooks[name]) return null
  const r = await runHook(name, c.cfg, await hookEnv(c), c.job.worktree, c.deps.exec)
  if (!r) return null
  const why = r.stderr.trim().split('\n')[0]
  return { stdout: r.stdout, failure: r.code === 0 ? null : `hook ${name} failed (exit ${r.code})${why ? `: ${why}` : ''}` }
}

/** prOpened assigns the QA env, so it must have run once per PR; its marker lets a retry run it again until it passes. */
async function prOpened(c: Ctx): Promise<void> {
  const marker = join(c.paths.jobDir, 'prOpened.ok')
  if (existsSync(marker)) return
  const r = await hook(c, 'prOpened')
  if (r?.failure) throw new Error(r.failure)
  if (r) writeFileSync(marker, `${c.job.pr}\n`)
}

/** Asks the qaUrl hook for the QA env when there is none yet. A failure is noted: validators then use a local port. */
async function qaUrl(c: Ctx): Promise<void> {
  if (c.job.qaUrl) return
  const r = await hook(c, 'qaUrl')
  if (r?.failure) return c.note(r.failure)
  const url = r?.stdout.trim().split('\n').pop()!.trim()
  if (url) {
    c.update({ qaUrl: url })
    c.note(`QA env: ${url}`)
  }
}

export const prTitle = (feature: string) => `[factory] ${feature.replace(/\s+/g, ' ').trim()}`.slice(0, 72).trimEnd()

/** Find or open the draft PR, run prOpened if it hasn't passed yet, then ask for the QA env. */
async function ensurePr(c: Ctx): Promise<void> {
  if (!c.job.pr) {
    const found = await c.deps.gh.findPr(c.job.branch)
    if (found) {
      c.update({ pr: found })
      c.note(`found the open PR ${found}`)
    } else {
      const bodyFile = join(c.paths.jobDir, 'pr-body.md')
      writeFileSync(bodyFile, initialBody(c.job))
      const pr = await c.deps.gh.createDraftPr({ branch: c.job.branch, base: c.cfg.base, title: prTitle(c.job.feature), bodyFile })
      c.update({ pr })
      c.note(`opened draft PR ${pr}`)
    }
  }
  await prOpened(c)
  await qaUrl(c)
}

/** The review a REWORK step answers: the latest one, when it said REWORK. */
function reworkInputs(c: Ctx): string[] {
  const n = c.job.discovery.length
  return c.job.discovery[n - 1]?.verdict === 'REWORK' ? [c.paths.discoveryReview(n)] : []
}

const requirements: Step = async (c) => {
  const inputs = present(c.job.questionsFile, c.job.reasonFile)
  const assignment = inputs.length
    ? 'Go through the Inputs with the human and update the requirements doc.'
    : 'Grill the human about the request and write the requirements doc.'
  const r = await writeDoc(c, 'requirements', 'requirements', assignment, inputs)
  if (!r.ok) return failed('requirements', r.problem)
  await ensurePr(c)
  return done('requirements')
}

const techDiscovery: Step = async (c) => {
  const inputs = reworkInputs(c)
  const assignment = inputs.length
    ? 'Rework the tech discovery doc as the discovery review in Inputs asks.'
    : 'Explore the codebase for the request and write the tech discovery doc.'
  const r = await writeDoc(c, 'tech-discoverer', 'tech discovery', assignment, inputs)
  return r.ok ? done('tech-discovery') : failed('tech-discovery', r.problem)
}

const design: Step = async (c) => {
  const inputs = reworkInputs(c)
  const assignment = inputs.length ? 'Rework the design doc as the discovery review in Inputs asks.' : 'Write the design doc for the request.'
  const r = await writeDoc(c, 'designer', 'design', assignment, inputs)
  if (!r.ok) return failed('design', r.problem)
  return hasHumanQuestions(r.text) ? done('design', { humanQuestions: true, questionsFile: out(c, 'design') }) : done('design')
}

const discoveryReview: Step = async (c) => {
  const output = out(c, 'discovery-review')
  const n = c.job.discovery.length + 1
  const [r] = await c.spawn([{ role: 'discovery-reviewer', kind: 'discovery-review', output, assignment: `Review the discovery docs against the request and the repo (review ${n}).` }])
  if (!r!.ok) return failed('discovery-review', r!.problem)
  const v = parseDiscoveryReview(r!.text)
  return done('discovery-review', {
    verdict: v.verdict,
    ...(v.step ? { reworkStep: v.step } : {}),
    ...(v.verdict === 'ASK' ? { questionsFile: output } : {}),
  })
}

const planning: Step = async (c) => {
  const inputs = present(c.job.reasonFile)
  const assignment = inputs.length
    ? 'Revise the spec for the Inputs. When they change what the human wants, also amend the requirements and design docs and name the Inputs file there.'
    : 'Write the spec: numbered acceptance criteria, tasks with a specialist each, the review lenses and the run order.'
  const r = await writeDoc(c, 'planner', 'spec', assignment, inputs, ['requirements', 'design'])
  return r.ok ? done('planning') : failed('planning', r.problem)
}

const hasSection = (text: string, id: string) => new RegExp(`^## ${id}\\b`, 'm').test(text)

/** `blocked: <first line under ### Blocked>`, or the status line when there is no such section. */
function blockedLine(text: string): string {
  const lines = text.split(/\r?\n/)
  const at = lines.map((l) => l.trim().replace(/:$/, '')).lastIndexOf('### Blocked')
  const why = at >= 0 ? lines.slice(at + 1).find((l) => l.trim() && !l.startsWith('#')) : undefined
  return why ? `blocked: ${why.trim()}` : 'STATUS: BLOCKED'
}

const build: Step = async (c) => {
  const plan = parsePlan(read(out(c, 'spec')))
  const output = out(c, 'build')
  for (const t of plan.tasks) {
    if (!SPECIALISTS.includes(t.specialist)) c.note(`${t.id}: unknown specialist "${t.specialist}" → ${builderFor(t.specialist)}`)
  }
  let pushed = true
  for (const id of plan.run) {
    if (c.job.trips[c.job.trips.length - 1]?.built?.includes(id)) {
      c.note(`skip ${id}: already built`)
      pushed = false
      continue
    }
    const role = builderFor(plan.tasks.find((t) => t.id === id)?.specialist ?? 'general')
    const check = (text: string): Check => {
      const r = checkOutput('build', text, c.cfg)
      return !r.ok || hasSection(text, id) ? r : { ok: false, problem: `no "## ${id}" section` }
    }
    const [r] = await c.spawn([{ role, kind: 'build', output, assignment: `Task ${id}`, target: browserTarget(c, role, 0), check, resume: false }])
    if (!r!.ok) return failed('build', r!.problem)
    if (r!.verdict === 'BLOCKED') return failed('build', `${role}: ${id} ${blockedLine(r!.text)}`)
    // Recorded before the push, so a failed push retries the push, not the builder.
    setTrip(c, (t) => ({ built: [...(t.built ?? []), id] }))
    await push(c)
    pushed = true
  }
  if (!pushed) await push(c)
  return done('build')
}

const review: Step = async (c) => {
  const lenses = parsePlan(read(out(c, 'spec'))).lenses
  setTrip(c, (t) => ({ reviews: Object.fromEntries(lenses.map((l) => [l, t.reviews[l] ?? 'pending'])) }))
  const results = await c.spawn(
    lenses.map((lens, i) => ({
      role: `reviewer-${lens}`,
      kind: 'review' as const,
      output: out(c, 'review', lens),
      assignment: `Review the branch through the ${lens} lens.`,
      target: browserTarget(c, `reviewer-${lens}`, i),
      onResult: (r: AgentResult) => {
        if (r.ok) setTrip(c, (t) => ({ reviews: { ...t.reviews, [lens]: r.verdict! } }))
      },
    })),
  )
  const problem = firstProblem(results)
  return problem ? failed('review', problem) : done('review')
}

/** A judge's verdict; its file holds the reasons and questions the machine needs. */
async function judge(c: Ctx, stage: 'build-judge' | 'validation-judge', assignment: string, inputs: string[]): Promise<Outcome> {
  const output = out(c, stage)
  const [r] = await c.spawn([{ role: stage, kind: stage, output, assignment, inputs }])
  if (!r!.ok) return failed(stage, r!.problem)
  return done(stage, { verdict: r!.verdict!, reasonFile: output, questionsFile: output })
}

const buildJudge: Step = (c) =>
  judge(c, 'build-judge', `Judge trip ${c.job.trip}: weigh the reviews against the spec.`, tripFiles(c, /^review-[^.]+\.md$/))

const testPlanning: Step = async (c) => {
  const assignment = `Write the test plan: the cases and the validators to run. Enabled validators: ${c.cfg.validators.join(', ')}`
  const r = await writeDoc(c, 'test-planner', 'test plan', assignment)
  return r.ok ? done('test-planning') : failed('test-planning', r.problem)
}

const rebase: Step = async (c) => {
  const base = c.cfg.base
  if ((await c.deps.git.rebase(c.job.worktree, base)) === 'conflict') {
    c.note(`rebase onto origin/${base} conflicts; starting the resolver`)
    // An earlier rebase.md can't count: the branch still conflicts.
    const [r] = await c.spawn([{
      role: 'resolver', kind: 'rebase', output: out(c, 'rebase'), resume: false,
      assignment: `Rebase ${c.job.branch} onto origin/${base} and resolve the conflicts without changing behaviour.`,
    }])
    if (!r!.ok) return failed('rebase', r!.problem)
    if (r!.verdict === 'BLOCKED') return failed('rebase', `resolver: ${blockedLine(r!.text)}`)
  }
  await push(c, true)
  return done('rebase')
}

/** An ENV retry validates again in the same trip: keep the old files under `.env<k>.md` so resume doesn't reuse them. */
function moveValidationAside(c: Ctx): void {
  const dir = tripDir(c)
  if (!existsSync(dir)) return
  const names = readdirSync(dir)
  const current = names.filter((f) => /^validation-[^.]+\.md$/.test(f))
  if (!current.length) return
  let k = 1
  while (names.some((f) => f.endsWith(`.env${k}.md`))) k++
  for (const f of current) renameSync(join(dir, f), join(dir, f.replace(/\.md$/, `.env${k}.md`)))
  setTrip(c, () => ({ validations: {} }))
  c.note(`moved this trip's validation files aside (.env${k}.md) to validate again`)
}

const qaWait: Step = async (c) => {
  moveValidationAside(c)
  // The QA env may be assigned some time after the PR opened.
  await qaUrl(c)
  const clock = { sleep: (ms: number) => c.deps.sleep(ms), now: () => c.deps.now().getTime() }
  const r = await waitQaReady(c.cfg, await hookEnv(c), c.job.worktree, c.deps.exec, clock)
  return r === 'timeout' ? failed('qa-wait', `QA env not ready after ${c.cfg.qaReadyTimeoutMin} min`) : done('qa-wait')
}

const validation: Step = async (c) => {
  const kinds = parseTestPlan(read(out(c, 'test-plan'))).validators
  setTrip(c, (t) => ({ validations: Object.fromEntries(kinds.map((k) => [k, t.validations[k] ?? 'pending'])) }))
  const results = await c.spawn(
    kinds.map((kind, i) => ({
      role: `validator-${kind}`,
      kind: 'validation' as const,
      output: out(c, 'validation', kind),
      assignment: `Validate the branch against the test plan with the ${kind} validator.`,
      target: c.job.qaUrl ?? localUrl(c, i),
      onResult: (r: AgentResult) => {
        if (r.ok) setTrip(c, (t) => ({ validations: { ...t.validations, [kind]: r.verdict! } }))
      },
    })),
  )
  const problem = firstProblem(results)
  return problem ? failed('validation', problem) : done('validation')
}

const validationJudge: Step = (c) =>
  judge(c, 'validation-judge', `Judge trip ${c.job.trip}'s validation.`, tripFiles(c, /^validation-(?!judge\.md$)[^.]+\.md$/))

function proofSection(nameWithOwner: string, sha: string, files: string[]): string {
  const lines = files.map((f) => {
    const url = `https://github.com/${nameWithOwner}/blob/${sha}/${encodeURIComponent(f)}?raw=true`
    return /\.(png|jpe?g|gif|webp|svg)$/i.test(f) ? `![${f}](${url})` : `[${f}](${url})`
  })
  return ['## Proof', ...lines].join('\n\n')
}

function openSection(job: Job, gaps: number[]): string {
  const items: string[] = []
  if (gaps.length) items.push(`- No proof for acceptance criteria ${gaps.join(', ')}.`)
  if (job.ready !== true) items.push('- Approved without a clean pass: the job had stopped for the human.')
  return ['## Open', items.join('\n')].join('\n\n')
}

const finalize: Step = async (c) => {
  const pr = c.job.pr
  if (!pr) return failed('finalize', 'no pull request to finalize')
  const sha = await pushProof(c.deps.exec, c.repo, c.paths.proofDir, c.job.id, join(c.paths.runDir, 'proof.index'))
  const proof = sha ? readdirSync(c.paths.proofDir).sort() : []
  const inputs = ['build.md', 'validation-judge.md'].map((f) => join(tripDir(c), f)).filter((f) => existsSync(f))
  const [r] = await c.spawn([{ role: 'summarizer', kind: 'pr', output: out(c, 'pr'), assignment: 'Write the pull request: its title as the first line, then the body.', inputs }])
  if (!r!.ok) return failed('finalize', r!.problem)
  const [first, ...rest] = r!.text.split(/\r?\n/)
  const spec = out(c, 'spec')
  const gaps = proofCoverage(existsSync(spec) ? parsePlan(read(spec)).criteria : [], proof)
  const ready = c.job.ready === true && gaps.length === 0
  const parts = [ready ? '' : openSection(c.job, gaps), rest.join('\n').trim()]
  if (sha) parts.push(proofSection(await c.deps.gh.nameWithOwner(), sha, proof))
  const bodyFile = join(c.paths.jobDir, 'pr-body.md')
  writeFileSync(bodyFile, `${parts.filter(Boolean).join('\n\n')}\n`)
  await c.deps.gh.editTitle(pr, first!.replace(/^#\s+/, '').trim())
  await c.deps.gh.editBody(pr, bodyFile)
  if (ready) await c.deps.gh.ready(pr)
  c.note(ready ? `PR ready for review: ${pr}` : `PR stays a draft: ${pr}`)
  return done('finalize')
}

/** The effect of every stage the driver runs; waiting stages have none. */
export const STAGES: Partial<Record<Stage, Step>> = {
  requirements,
  'tech-discovery': techDiscovery,
  design,
  'discovery-review': discoveryReview,
  planning,
  build,
  review,
  'build-judge': buildJudge,
  'test-planning': testPlanning,
  rebase,
  'qa-wait': qaWait,
  validation,
  'validation-judge': validationJudge,
  finalize,
}

/** Branch links to the docs that exist, for the PR status block. */
export async function docLinks(c: Ctx): Promise<Record<string, string | null>> {
  const nwo = await c.nameWithOwner()
  const links: Record<string, string | null> = {}
  for (const d of Object.keys(DOCS) as DocName[]) {
    links[d] = nwo && existsSync(out(c, DOCS[d].kind)) ? `https://github.com/${nwo}/blob/${c.job.branch}/${docRel(c, d)}` : null
  }
  return links
}
