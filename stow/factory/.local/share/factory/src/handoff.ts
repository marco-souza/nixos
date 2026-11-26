import { join } from 'node:path'
import type { FactoryConfig } from './config'
import type { JobPaths } from './paths'

export type OutputKind =
  | 'requirements'
  | 'tech-discovery'
  | 'design'
  | 'discovery-review'
  | 'spec'
  | 'build'
  | 'review'
  | 'build-judge'
  | 'test-plan'
  | 'validation'
  | 'validation-judge'
  | 'rebase'
  | 'pr'

export type Check = { ok: true; verdict: string | null } | { ok: false; problem: string }

export const LENSES = ['product', 'security', 'code', 'ux', 'ui']
export const SPECIALISTS = ['backend', 'frontend', 'mobile', 'data', 'infra', 'general']

export function builderFor(specialist: string): string {
  return `builder-${SPECIALISTS.includes(specialist) ? specialist : 'general'}`
}

export function outputPath(
  kind: OutputKind,
  a: { paths: JobPaths; cfg: FactoryConfig; id: string; trip: number; n: number; name?: string },
): string {
  const { paths, cfg, id, trip, n, name } = a
  const doc = (dir: string) => join(paths.worktree, dir, `${id}.md`)
  const tripFile = (file: string) => join(paths.tripDir(trip), file)
  const named = () => {
    if (!name) throw new Error(`outputPath: "${kind}" needs a name`)
    return name
  }
  switch (kind) {
    case 'requirements':
      return doc(cfg.docs.requirements)
    case 'tech-discovery':
      return doc(cfg.docs.techDiscovery)
    case 'design':
      return doc(cfg.docs.design)
    case 'spec':
      return doc(cfg.docs.specs)
    case 'test-plan':
      return doc(cfg.docs.testPlans)
    case 'discovery-review':
      return paths.discoveryReview(n)
    case 'build':
      return tripFile('build.md')
    case 'review':
      return tripFile(`review-${named()}.md`)
    case 'build-judge':
      return tripFile('build-judge.md')
    case 'validation':
      return tripFile(`validation-${named()}.md`)
    case 'validation-judge':
      return tripFile('validation-judge.md')
    case 'rebase':
      return tripFile('rebase.md')
    case 'pr':
      return paths.prFile
  }
}

function lines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/)
}

function firstLine(text: string): string {
  return lines(text)[0]!.trimEnd()
}

const hasHeading = (text: string, h: string) => lines(text).some((l) => l.trimEnd() === h)

/** Body lines of the `## ` section named `h`, up to the next `## ` heading; null if absent. */
function section(text: string, h: string): string[] | null {
  const all = lines(text)
  const start = all.findIndex((l) => l.trimEnd() === h)
  if (start < 0) return null
  const rest = all.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return end < 0 ? rest : rest.slice(0, end)
}

/** Comma-separated values of the first `<key>: a, b` line, lowercased; null if no such line. */
function listLine(text: string, key: string): string[] | null {
  for (const l of lines(text)) {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'i').exec(l)
    if (m) return m[1]!.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  }
  return null
}

function missing(text: string, headings: string[]): string | null {
  const h = headings.find((x) => !hasHeading(text, x))
  return h ? `missing "${h}"` : null
}

export function parsePlan(text: string): {
  tasks: { id: string; specialist: string }[]
  run: string[]
  lenses: string[]
  criteria: number[]
} {
  const tasks: { id: string; specialist: string }[] = []
  let cur: { id: string; specialist: string } | null = null
  for (const l of section(text, '## Tasks') ?? []) {
    const h = /^###\s+(T\d+)\b/.exec(l)
    if (h) {
      cur = { id: h[1]!, specialist: '' }
      tasks.push(cur)
    } else if (l.startsWith('### ')) {
      cur = null
    } else if (cur && !cur.specialist) {
      const s = /^Specialist:\s*(\S+)/i.exec(l)
      if (s) cur.specialist = s[1]!.toLowerCase()
    }
  }
  const runBody = (section(text, '## Run') ?? []).find((l) => l.trim() !== '') ?? ''
  const run = runBody
    .replace(/^\s*Run:/i, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const criteria: number[] = []
  for (const l of section(text, '## Acceptance criteria') ?? []) {
    const m = /^\s*(\d+)\.\s/.exec(l)
    if (m) criteria.push(Number(m[1]))
  }
  return { tasks, run, lenses: listLine(text, 'Lenses') ?? [], criteria }
}

export function parseTestPlan(text: string): { validators: string[] } {
  return { validators: listLine(text, 'Validators') ?? [] }
}

const DISCOVERY_LINE = /^VERDICT: (PASS|ASK|REWORK (tech-discovery|design))$/

export function parseDiscoveryReview(text: string): { verdict: 'PASS' | 'REWORK' | 'ASK'; step?: 'tech-discovery' | 'design' } {
  const m = DISCOVERY_LINE.exec(firstLine(text))
  if (!m) throw new Error('not a discovery-review verdict line')
  const [word, step] = m[1]!.split(' ') as ['PASS' | 'REWORK' | 'ASK', ('tech-discovery' | 'design')?]
  return step ? { verdict: word, step } : { verdict: word }
}

export function hasHumanQuestions(design: string): boolean {
  const body = (section(design, '## Questions for the human') ?? []).join('\n').trim()
  return body !== '' && !/^none\.?$/i.test(body)
}

type LineSpec = { prefix: 'VERDICT' | 'STATUS'; words: string[]; questionsOn?: string[] }

const LINE_SPECS: Partial<Record<OutputKind, LineSpec>> = {
  build: { prefix: 'STATUS', words: ['READY', 'BLOCKED'] },
  rebase: { prefix: 'STATUS', words: ['READY', 'BLOCKED'] },
  review: { prefix: 'VERDICT', words: ['PASS', 'CHANGES'] },
  validation: { prefix: 'VERDICT', words: ['PASS', 'FAIL'] },
  'build-judge': { prefix: 'VERDICT', words: ['APPROVE', 'CHANGES', 'ESCALATE'], questionsOn: ['ESCALATE'] },
  'validation-judge': { prefix: 'VERDICT', words: ['PASS', 'FAIL', 'ENV', 'ESCALATE'], questionsOn: ['ESCALATE'] },
}

const quote = (items: string[]) => items.map((s) => `"${s}"`).join(', ').replace(/, ([^,]*)$/, ' or $1')

function questionsProblem(text: string): string | null {
  const body = section(text, '## Questions')
  if (!body) return 'missing "## Questions"'
  return body.join('').trim() === '' ? 'empty "## Questions"' : null
}

function checkLine(kind: OutputKind, text: string): Check {
  const spec = LINE_SPECS[kind]!
  const m = new RegExp(`^${spec.prefix}: (${spec.words.join('|')})$`).exec(firstLine(text))
  if (!m) return { ok: false, problem: `first line must be ${quote(spec.words.map((w) => `${spec.prefix}: ${w}`))}` }
  const verdict = m[1]!
  if (spec.questionsOn?.includes(verdict)) {
    const p = questionsProblem(text)
    if (p) return { ok: false, problem: p }
  }
  return { ok: true, verdict }
}

const fail = (problem: string | null): Check | null => (problem ? { ok: false, problem } : null)
const pass: Check = { ok: true, verdict: null }

function checkSpec(text: string): Check {
  const m = missing(text, ['## Acceptance criteria', '## Tasks'])
  if (m) return { ok: false, problem: m }
  const plan = parsePlan(text)
  if (plan.criteria.length === 0) return { ok: false, problem: 'no numbered acceptance criteria' }
  if (plan.tasks.length === 0) return { ok: false, problem: 'no "### T<k>" tasks under "## Tasks"' }
  const noSpec = plan.tasks.find((t) => !t.specialist)
  if (noSpec) return { ok: false, problem: `task ${noSpec.id} has no "Specialist: <s>" line` }
  const lenses = listLine(text, 'Lenses')
  if (!lenses) return { ok: false, problem: 'missing "Lenses:" line' }
  const badLens = lenses.find((l) => !LENSES.includes(l))
  if (badLens) return { ok: false, problem: `unknown lens "${badLens}"` }
  const headings = lines(text).filter((l) => l.startsWith('## '))
  if (headings[headings.length - 1]?.trimEnd() !== '## Run') return { ok: false, problem: 'missing "## Run" as the last section' }
  if (plan.run.length === 0) return { ok: false, problem: 'empty "## Run"' }
  const ids = plan.tasks.map((t) => t.id)
  const unknown = plan.run.find((r) => !ids.includes(r))
  if (unknown) return { ok: false, problem: `Run lists unknown task "${unknown}"` }
  return pass
}

export function checkOutput(kind: OutputKind, text: string, cfg: FactoryConfig): Check {
  switch (kind) {
    case 'requirements': {
      if (!firstLine(text).startsWith('# ')) return { ok: false, problem: 'first line must start with "# "' }
      return fail(missing(text, ['## Intent', '## Requirements', '## Decisions'])) ?? pass
    }
    case 'tech-discovery':
      return fail(missing(text, ['## Findings', '## Risks'])) ?? pass
    case 'design':
      return fail(missing(text, ['## Approach', '## Alternatives', '## Questions for the human'])) ?? pass
    case 'discovery-review': {
      let r
      try {
        r = parseDiscoveryReview(text)
      } catch {
        return {
          ok: false,
          problem: `first line must be ${quote(['VERDICT: PASS', 'VERDICT: REWORK tech-discovery', 'VERDICT: REWORK design', 'VERDICT: ASK'])}`,
        }
      }
      if (r.verdict === 'ASK') {
        const p = fail(questionsProblem(text))
        if (p) return p
      }
      return { ok: true, verdict: r.verdict }
    }
    case 'spec':
      return checkSpec(text)
    case 'test-plan': {
      const m = fail(missing(text, ['## Cases']))
      if (m) return m
      const { validators } = parseTestPlan(text)
      if (validators.length === 0) return { ok: false, problem: 'missing "Validators:" line' }
      const off = validators.find((v) => !cfg.validators.includes(v))
      if (off) return { ok: false, problem: `validator "${off}" is not enabled in .factory.json` }
      return pass
    }
    case 'pr':
      return /^# \S/.test(firstLine(text)) ? pass : { ok: false, problem: 'first line must be "# <PR title>"' }
    default:
      return checkLine(kind, text)
  }
}
