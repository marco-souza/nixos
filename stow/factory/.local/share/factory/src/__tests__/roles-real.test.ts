import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REQUIRED_ROLES } from '../driver'
import { LENSES, SPECIALISTS } from '../handoff'
import { PACKAGE_DIR } from '../paths'
import { loadRole } from '../roles'

const ROLES_DIR = join(PACKAGE_DIR, 'roles')
const FORBIDDEN = /AskUserQuestion|subagent_type|job\.json|mcp__|\.factory\/|\bdocs\//

const BUILDERS = SPECIALISTS.map((s) => `builder-${s}`)
const REVIEWERS = LENSES.map((l) => `reviewer-${l}`)
const BUILDING = ['planner', ...BUILDERS, ...REVIEWERS, 'build-judge']

/**
 * The exact headings and lines each role's output skeleton (a fenced block in its body) must show.
 * A skeleton shows one verdict, so `VERDICT:`/`STATUS:` lines need only be named in the body, and one of them must
 * open a skeleton.
 */
const CONTRACTS: Record<string, string[]> = {
  requirements: ['## Intent', '## Requirements', '## Decisions'],
  'tech-discoverer': ['## Findings', '## Risks'],
  designer: ['## Approach', '## Alternatives', '## Questions for the human'],
  'discovery-reviewer': ['VERDICT: PASS', 'VERDICT: REWORK tech-discovery', 'VERDICT: REWORK design', 'VERDICT: ASK', '## Questions'],
  planner: ['## Acceptance criteria', '## Tasks', '### T1', 'Specialist:', 'Lenses:', '## Run'],
  ...Object.fromEntries(BUILDERS.map((b) => [b, ['STATUS: READY', 'STATUS: BLOCKED', '## T1']])),
  ...Object.fromEntries(REVIEWERS.map((r) => [r, ['VERDICT: PASS', 'VERDICT: CHANGES']])),
  'build-judge': ['VERDICT: APPROVE', 'VERDICT: CHANGES', 'VERDICT: ESCALATE', '## Findings', '## Questions', '## Design'],
}

const VERDICT_LINE = /^(VERDICT|STATUS): /

const present = () => REQUIRED_ROLES.filter((r) => existsSync(join(ROLES_DIR, `${r}.md`)))
const missingRoles = (roles: string[]) => roles.filter((r) => !existsSync(join(ROLES_DIR, `${r}.md`)))

/** The content of every fenced code block in a role body. */
function skeletons(body: string): string[] {
  return [...body.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]!)
}

/** A heading must be a whole skeleton line (`### T1: …` counts for `### T1`); any other line may sit inside one. */
function inSkeleton(fences: string[], want: string): boolean {
  if (!want.startsWith('#')) return fences.some((f) => f.includes(want))
  return fences.some((f) => f.split('\n').some((l) => l.trimEnd() === want || l.startsWith(`${want}:`)))
}

describe('real roles', () => {
  test('the discovery roles exist', () => {
    expect(missingRoles(['requirements', 'tech-discoverer', 'designer', 'discovery-reviewer'])).toEqual([])
  })

  test('the building roles exist', () => {
    expect(missingRoles(BUILDING)).toEqual([])
  })

  test('every required role that exists loads under its own name', () => {
    for (const r of present()) expect(loadRole(ROLES_DIR, r).name).toBe(r)
  })

  test('only requirements is interactive', () => {
    const interactive = present().filter((r) => loadRole(ROLES_DIR, r).interactive)
    expect(interactive).toEqual(['requirements'])
  })

  test('the building roles with a browser are the frontend and general builders and the ux and ui reviewers', () => {
    const browser = BUILDING.filter((r) => loadRole(ROLES_DIR, r).browser)
    expect(browser).toEqual(['builder-frontend', 'builder-general', 'reviewer-ux', 'reviewer-ui'])
  })

  test('builders include the builder contract', () => {
    for (const b of BUILDERS) expect({ role: b, include: loadRole(ROLES_DIR, b).include }).toEqual({ role: b, include: ['_common', '_builder'] })
  })

  test('builders run on the medium tier, the other building roles on high', () => {
    const tiers = Object.fromEntries(BUILDING.map((r) => [r, loadRole(ROLES_DIR, r).tier]))
    expect(tiers).toEqual(Object.fromEntries(BUILDING.map((r) => [r, BUILDERS.includes(r) ? 'medium' : 'high'])))
  })

  test('no role body names harness tools, factory internals or fixed paths', () => {
    for (const r of present()) {
      const hit = loadRole(ROLES_DIR, r).body.match(FORBIDDEN)?.[0] ?? null
      expect({ role: r, hit }).toEqual({ role: r, hit: null })
    }
  })

  test('each role shows the exact headings of its output contract in its output skeleton', () => {
    for (const [r, wanted] of Object.entries(CONTRACTS)) {
      const body = loadRole(ROLES_DIR, r).body
      const fences = skeletons(body)
      const missing = wanted.filter((w) => !(VERDICT_LINE.test(w) ? body.includes(w) : inSkeleton(fences, w)))
      const verdicts = wanted.filter((w) => VERDICT_LINE.test(w))
      const opensWithVerdict = verdicts.length === 0 || fences.some((f) => verdicts.some((v) => f.startsWith(`${v}\n`)))
      expect({ role: r, missing, opensWithVerdict }).toEqual({ role: r, missing: [], opensWithVerdict: true })
    }
  })
})
