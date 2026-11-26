import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUIRED_ROLES } from '../driver'
import { listRoles, loadRole, parseRole } from '../roles'

const dir = join(import.meta.dir, 'fixtures', 'roles')
const fm = (lines: string[], body = 'Body.') => `---\n${lines.join('\n')}\n---\n\n${body}\n`
const base = ['name: x', 'description: d', 'tier: low']

describe('parseRole', () => {
  test('parses frontmatter', () => {
    const r = parseRole(fm(['name: x', 'description: A role: with colon', 'tools: [read, grep]', 'tier: high', 'browser: true']), 'x.md')
    expect(r).toEqual({
      name: 'x', description: 'A role: with colon', tools: ['read', 'grep'], browser: true,
      interactive: false, tier: 'high', include: ['_common'], body: 'Body.',
    })
    const d = parseRole(fm(base), 'x.md')
    expect(d.browser).toBe(false)
    expect(d.interactive).toBe(false)
    expect(d.tools).toEqual([])
  })
  test('missing name fails with file path', () => {
    expect(() => parseRole(fm(['description: d', 'tier: low']), '/r/sample.md')).toThrow(/sample\.md.*name/)
  })
  test('missing description or tier fails', () => {
    expect(() => parseRole(fm(['name: x', 'tier: low']), 'x.md')).toThrow(/description/)
    expect(() => parseRole(fm(['name: x', 'description: d']), 'x.md')).toThrow(/tier/)
  })
  test('invalid tier fails', () => {
    expect(() => parseRole(fm(['name: x', 'description: d', 'tier: huge']), 'x.md')).toThrow(/tier/)
  })
  test('unknown tool fails', () => {
    expect(() => parseRole(fm([...base, 'tools: [read, fly]']), 'x.md')).toThrow('unknown tool "fly"')
  })
  test('unknown key fails naming key and file', () => {
    expect(() => parseRole(fm([...base, 'output: a.md']), 'x.md')).toThrow(/x\.md.*"output"/)
  })
  test('missing frontmatter fails', () => {
    expect(() => parseRole('just text', 'x.md')).toThrow(/frontmatter/)
  })
  test('long run of inner blank lines parses quickly and is kept', () => {
    const inner = '\n'.repeat(41)
    const t0 = performance.now()
    const r = parseRole(fm(base, `A${inner}B`), 'x.md')
    expect(performance.now() - t0).toBeLessThan(100)
    expect(r.body).toBe(`A${inner}B`)
  })
  test('include list', () => {
    expect(parseRole(fm([...base, 'include: []']), 'x.md').include).toEqual([])
    expect(parseRole(fm([...base, 'include: [_common, _extra]']), 'x.md').include).toEqual(['_common', '_extra'])
  })
})

describe('loadRole', () => {
  test('includes come first', () => {
    const r = loadRole(dir, 'sample')
    expect(r.body.startsWith('Shared rules for every role.\n\nBe brief.')).toBe(true)
    expect(r.body.endsWith('\n\nYou are the sample role.')).toBe(true)
  })
  test('include: [] disables _common', () => {
    const d = mkdtempSync(join(tmpdir(), 'roles-'))
    writeFileSync(join(d, 'bare.md'), fm([...base, 'include: []'], 'Only me.'))
    expect(loadRole(d, 'bare').body).toBe('Only me.')
  })
  test('missing include names the file and role', () => {
    const d = mkdtempSync(join(tmpdir(), 'roles-'))
    writeFileSync(join(d, 'r.md'), fm(base))
    expect(() => loadRole(d, 'r')).toThrow(/_common\.md.*role "r"/)
  })
})

describe('listRoles', () => {
  test('lists non-underscore md files', () => {
    expect(listRoles(dir)).toEqual([...REQUIRED_ROLES, 'sample'].sort())
  })
})
