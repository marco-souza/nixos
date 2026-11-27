#!/usr/bin/env bun
/**
 * Stands in for a headless (or grill) agent in the end-to-end test:
 *
 *   bun fake-agent.ts <role> <taskFile> <scenarioFile>
 *
 * Reads the task prompt the driver wrote and writes a canned valid output for the role at its `Output:` path.
 * Builders also commit a file in the worktree; validators write proof files in the job folder.
 *
 * The scenario is a JSON object of verdicts per role, one per visit (`{"build-judge": ["CHANGES", "APPROVE"]}`);
 * a role without one (or past its last) gives its passing verdict. Visits are counted in `<scenarioFile>.counts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [role, taskFile, scenarioFile] = process.argv.slice(2) as [string, string, string]
const task = readFileSync(taskFile, 'utf8')
const field = (name: string) => {
  const m = new RegExp(`^${name}: (.+)$`, 'm').exec(task)
  if (!m) throw new Error(`${taskFile}: no "${name}:" line`)
  return m[1]!.trim()
}
const output = field('Output')
const assignment = field('Assignment')
const worktree = field('Worktree').replace(/ \(your working directory\)$/, '')
const jobDir = field('Job folder')
const job = field('Job')
const trip = /\bTrip: (\d+)/.exec(task)![1]!
const cycle = /^Cycle: (\d+)/m.exec(task)![1]!

/** This visit's verdict from the scenario, or `fallback`. */
function verdict(fallback: string): string {
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')) as Record<string, string[]>
  const countsFile = `${scenarioFile}.counts`
  const counts = existsSync(countsFile) ? (JSON.parse(readFileSync(countsFile, 'utf8')) as Record<string, number>) : {}
  const k = (counts[role] = (counts[role] ?? 0) + 1)
  writeFileSync(countsFile, JSON.stringify(counts))
  return scenario[role]?.[k - 1] ?? fallback
}

function git(...args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', worktree, ...args], { stderr: 'pipe', stdout: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

/** The numbered acceptance criteria of the spec, from the task's `Docs:` line. */
function criteria(): { k: number; text: string }[] {
  const spec = /\bspec=([^,\s]+)/.exec(field('Docs'))![1]!
  return [...readFileSync(join(worktree, spec), 'utf8').matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ k: Number(m[1]), text: m[2]! }))
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Verdict line, with the questions an ASK or ESCALATE needs. */
function judged(word: string, why: string): string {
  const questions = word === 'ASK' || word === 'ESCALATE' ? '\n## Questions\n- Should it be done this way?\n' : ''
  return `VERDICT: ${word}\n\n${why}\n${questions}`
}

const SPEC = `# Spec for ${job}

## Acceptance criteria
1. Requests over the limit get a 429.
2. The limit is configurable.

## Tasks
### T1 Limiter middleware
Specialist: backend

### T2 Settings page
Specialist: frontend

Lenses: product, code, security

## Run
T1, T2
`

function build(): string {
  const id = /^Task (T\d+)$/.exec(assignment)?.[1]
  if (!id) throw new Error(`builder: unexpected assignment "${assignment}"`)
  const file = join('src', `${id.toLowerCase()}.txt`)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  const path = join(worktree, file)
  writeFileSync(path, `${existsSync(path) ? readFileSync(path, 'utf8') : ''}${id} cycle ${cycle} trip ${trip}\n`)
  git('add', '--', file)
  git('commit', '-q', '-m', `feat: ${id.toLowerCase()} for ${job} (cycle ${cycle} trip ${trip})`)
  const rest = existsSync(output) ? readFileSync(output, 'utf8').split('\n').slice(1).join('\n').trimEnd() : '# Build'
  return `STATUS: READY\n${rest}\n\n## ${id}\nBuilt ${file}.\n`
}

function validate(kind: string): string {
  mkdirSync(join(jobDir, 'proof'), { recursive: true })
  for (const c of criteria()) writeFileSync(join(jobDir, 'proof', `ac${c.k}-${kind}-${slug(c.text)}.txt`), `$ check\n${c.text}: ok\n`)
  return judged(verdict('PASS'), `Every case passed on ${field('Target')}.`)
}

function content(): string {
  if (role === 'requirements') return `# Requirements for ${job}\n\n## Intent\n${field('Request')}\n\n## Requirements\n1. Limit requests.\n\n## Decisions\n- None.\n`
  if (role === 'tech-discoverer') return '# Tech discovery\n\n## Findings\n- One router.\n\n## Risks\n- None.\n'
  if (role === 'designer') return '# Design\n\n## Approach\nA middleware.\n\n## Alternatives\nA proxy.\n\n## Questions for the human\nNone\n'
  if (role === 'discovery-reviewer') return judged(verdict('PASS'), 'The docs match the request.')
  if (role === 'planner') return SPEC
  if (role.startsWith('builder-')) return build()
  if (role.startsWith('reviewer-')) return judged(verdict('PASS'), 'Looks right.')
  if (role === 'build-judge') return judged(verdict('APPROVE'), 'Weighed the reviews.')
  if (role === 'test-planner') return '# Test plan\n\n## Cases\n1. Send 101 requests; the last gets a 429.\n\nValidators: e2e\n'
  if (role.startsWith('validator-')) return validate(role.slice('validator-'.length))
  if (role === 'validation-judge') return judged(verdict('PASS'), 'Weighed the validators.')
  if (role === 'resolver') return 'STATUS: READY\n\nNo conflicts left.\n'
  if (role === 'summarizer') return '# Add rate limiting\n\nLimits requests per client.\n'
  throw new Error(`fake-agent: unknown role ${role}`)
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, content())
console.log(`fake ${role}: wrote ${output}`)
