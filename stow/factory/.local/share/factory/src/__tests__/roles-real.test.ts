import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REQUIRED_ROLES } from '../driver'
import { PACKAGE_DIR } from '../paths'
import { loadRole } from '../roles'

const ROLES_DIR = join(PACKAGE_DIR, 'roles')
const FORBIDDEN = /AskUserQuestion|subagent_type|job\.json|mcp__/

/** The exact headings and first lines each role's body must name (output contracts). */
const CONTRACTS: Record<string, string[]> = {
  requirements: ['## Intent', '## Requirements', '## Decisions'],
  'tech-discoverer': ['## Findings', '## Risks'],
  designer: ['## Approach', '## Alternatives', '## Questions for the human'],
  'discovery-reviewer': ['VERDICT: PASS', 'VERDICT: REWORK tech-discovery', 'VERDICT: REWORK design', 'VERDICT: ASK', '## Questions'],
}

const present = () => REQUIRED_ROLES.filter((r) => existsSync(join(ROLES_DIR, `${r}.md`)))

describe('real roles', () => {
  test('the discovery roles exist', () => {
    const missing = ['requirements', 'tech-discoverer', 'designer', 'discovery-reviewer'].filter((r) => !existsSync(join(ROLES_DIR, `${r}.md`)))
    expect(missing).toEqual([])
  })

  test('every required role that exists loads under its own name', () => {
    for (const r of present()) expect(loadRole(ROLES_DIR, r).name).toBe(r)
  })

  test('only requirements is interactive', () => {
    const interactive = present().filter((r) => loadRole(ROLES_DIR, r).interactive)
    expect(interactive).toEqual(['requirements'])
  })

  test('no role body names harness tools or factory internals', () => {
    for (const r of present()) {
      const hit = loadRole(ROLES_DIR, r).body.match(FORBIDDEN)?.[0] ?? null
      expect({ role: r, hit }).toEqual({ role: r, hit: null })
    }
  })

  test('each role names the exact headings of its output contract', () => {
    for (const [r, headings] of Object.entries(CONTRACTS)) {
      const body = loadRole(ROLES_DIR, r).body
      expect({ role: r, missing: headings.filter((h) => !body.includes(h)) }).toEqual({ role: r, missing: [] })
    }
  })
})
