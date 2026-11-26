import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type FactoryConfig } from '../config'
import { buildCommand, HarnessError, PLAYWRIGHT_TOOLS, renderTaskPrompt, resolveHarness } from '../harness'
import { createJob } from '../job'
import { jobPaths } from '../paths'
import type { Role } from '../roles'
import { shq } from '../shell'

let dir: string
let cfg: FactoryConfig
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-harness-'))
  cfg = loadConfig(dir)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function role(over: Partial<Role> = {}): Role {
  return {
    name: 'reviewer-code', description: 'd', tools: ['read', 'grep', 'glob', 'bash', 'write'],
    browser: false, interactive: false, tier: 'high', include: [], body: 'b', ...over,
  }
}
const files = { system: '/j/run/sys.md', task: '/j/run/task.md' }

describe('shq', () => {
  test('escapes single quotes', () => expect(shq("it's")).toBe(`'it'\\''s'`))
})

describe('resolveHarness', () => {
  test('defaults from role tier', () => {
    expect(resolveHarness(role(), cfg)).toEqual({ harness: 'claude', model: 'opus', timeoutMin: 45 })
  })
  test('override picks pi, null model, override timeout', () => {
    const c = { ...cfg, roles: { 'reviewer-code': { harness: 'pi' as const, tier: 'low' as const, timeoutMin: 7 } } }
    expect(resolveHarness(role(), c)).toEqual({ harness: 'pi', model: null, timeoutMin: 7 })
  })
  test('pi model comes from config', () => {
    const c = { ...cfg, defaultHarness: 'pi' as const, models: { ...cfg.models, pi: { high: 'm1' } } }
    expect(resolveHarness(role(), c).model).toBe('m1')
  })
  test('browser role on pi throws', () => {
    const c = { ...cfg, defaultHarness: 'pi' as const }
    expect(() => resolveHarness(role({ name: 'validator-e2e', browser: true }), c)).toThrow(
      new HarnessError('role validator-e2e needs a browser; run it on claude'),
    )
  })
  test('unknown harness or tier is rejected naming role and value', () => {
    const bad = (o: object) => ({ ...cfg, roles: { 'reviewer-code': o } }) as unknown as FactoryConfig
    expect(() => resolveHarness(role(), bad({ harness: 'gpt' }))).toThrow(/reviewer-code.*gpt/)
    expect(() => resolveHarness(role(), bad({ tier: 'huge' }))).toThrow(/reviewer-code.*huge/)
    expect(() => resolveHarness(role(), { ...cfg, defaultHarness: 'x' as never })).toThrow(HarnessError)
  })
})

describe('buildCommand', () => {
  const claude = { harness: 'claude' as const, model: 'opus' }
  const task = `"$(cat '/j/run/task.md')"`
  test('claude headless', () => {
    expect(buildCommand(role(), claude, files)).toBe(
      `claude -p ${task} --append-system-prompt-file '/j/run/sys.md' --model 'opus' --permission-mode auto --allowedTools 'Read,Grep,Glob,Bash,Write' --disallowedTools 'Edit,Agent' --output-format stream-json --verbose`,
    )
  })
  test('claude interactive', () => {
    expect(buildCommand(role({ interactive: true }), claude, files)).toBe(
      `claude ${task} --append-system-prompt-file '/j/run/sys.md' --model 'opus' --permission-mode auto --allowedTools 'Read,Grep,Glob,Bash,Write' --disallowedTools 'Edit,Agent'`,
    )
  })
  test('claude browser adds playwright tools', () => {
    const cmd = buildCommand(role({ browser: true }), claude, files)
    expect(cmd).toContain(`--allowedTools 'Read,Grep,Glob,Bash,Write,${PLAYWRIGHT_TOOLS.join(',')}'`)
  })
  test('pi headless', () => {
    expect(buildCommand(role(), { harness: 'pi', model: 'm' }, files)).toBe(
      `pi -p --append-system-prompt '/j/run/sys.md' --model 'm' --tools 'read,grep,find,ls,bash,write' --mode json ${task}`,
    )
  })
  test('pi headless without model', () => {
    expect(buildCommand(role(), { harness: 'pi', model: null }, files)).toBe(
      `pi -p --append-system-prompt '/j/run/sys.md' --tools 'read,grep,find,ls,bash,write' --mode json ${task}`,
    )
  })
  test('pi interactive', () => {
    expect(buildCommand(role({ interactive: true }), { harness: 'pi', model: 'm' }, files)).toBe(
      `pi --append-system-prompt '/j/run/sys.md' --model 'm' --tools 'read,grep,find,ls,bash,write' ${task}`,
    )
  })
  test('paths with quotes are escaped', () => {
    expect(buildCommand(role(), claude, { system: "/a'b/s.md", task: '/t.md' })).toContain(`'/a'\\''b/s.md'`)
  })
})

describe('PLAYWRIGHT_TOOLS', () => {
  test('12 unique browser tools', () => {
    expect(PLAYWRIGHT_TOOLS).toHaveLength(12)
    expect(new Set(PLAYWRIGHT_TOOLS).size).toBe(12)
    expect(PLAYWRIGHT_TOOLS.every((t) => t.startsWith('mcp__plugin_playwright_playwright__browser_'))).toBe(true)
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__plugin_playwright_playwright__browser_hover')
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__plugin_playwright_playwright__browser_emulate_media')
  })
})

describe('renderTaskPrompt', () => {
  const now = new Date('2026-11-26T00:00:00Z')
  const job = createJob({ id: '261126-thing', feature: 'Add thing', repo: '/r', slot: 1, now })
  const paths = jobPaths('/r', job.id)
  const mk = () => ({ job: { ...job, trip: 2 }, paths, cfg, assignment: 'Build T1', output: '/r/.factory/jobs/261126-thing/trip-2/build.md', inputs: ['/a.md', '/b.md'], target: 'local dev server on port 3101' })

  test('build task with port target', () => {
    expect(renderTaskPrompt(mk())).toBe(
      [
        'Job: 261126-thing',
        'Request: Add thing',
        'Worktree: /r/.factory/261126-thing (your working directory)',
        'Job folder: /r/.factory/jobs/261126-thing',
        'Cycle: 1  Trip: 2',
        'Docs: requirements=docs/requirements/261126-thing.md, tech-discovery=docs/tech-discovery/261126-thing.md, design=docs/design-docs/261126-thing.md, spec=docs/specs/261126-thing.md, test-plan=docs/test-plans/261126-thing.md',
        'Assignment: Build T1',
        'Output: /r/.factory/jobs/261126-thing/trip-2/build.md',
        'Inputs: /a.md, /b.md',
        'Target: local dev server on port 3101',
      ].join('\n'),
    )
  })
  test('Inputs and Target omitted when empty', () => {
    const out = renderTaskPrompt({ ...mk(), inputs: [], target: null })
    expect(out).not.toContain('Inputs:')
    expect(out).not.toContain('Target:')
    expect(out.endsWith('trip-2/build.md')).toBe(true)
  })
  test('feature text appears in the task file, never in the command', () => {
    const feature = '"$(rm -rf ~)" `x`'
    const j = createJob({ id: '261126-evil', feature, repo: '/r', slot: 1, now })
    const prompt = renderTaskPrompt({ ...mk(), job: j, paths: jobPaths('/r', j.id) })
    const taskFile = join(dir, 'task.md')
    writeFileSync(taskFile, prompt)
    const cmd = buildCommand(role(), { harness: 'claude', model: 'opus' }, { system: join(dir, 'sys.md'), task: taskFile })
    expect(prompt).toContain(feature)
    expect(cmd).not.toContain('rm -rf')
    expect(cmd).not.toContain('`')
  })
})
