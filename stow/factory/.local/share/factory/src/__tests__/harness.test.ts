import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type FactoryConfig } from '../config'
import { buildCommand, HarnessError, PLAYWRIGHT_MCP_CONFIG, PLAYWRIGHT_TOOLS, renderTaskPrompt, resolveHarness } from '../harness'
import { createJob } from '../job'
import { jobPaths, PACKAGE_DIR } from '../paths'
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
const JOB_DIR = '/j'

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
    expect(buildCommand(role(), claude, files, JOB_DIR)).toBe(
      `claude -p ${task} --append-system-prompt-file '/j/run/sys.md' --model 'opus' --permission-mode auto --add-dir '/j' --strict-mcp-config --allowedTools 'Read,Grep,Glob,Bash,Write' --disallowedTools 'Edit,Agent' --output-format stream-json --verbose`,
    )
  })
  test('claude interactive', () => {
    expect(buildCommand(role({ interactive: true }), claude, files, JOB_DIR)).toBe(
      `claude ${task} --append-system-prompt-file '/j/run/sys.md' --model 'opus' --permission-mode auto --add-dir '/j' --strict-mcp-config --allowedTools 'Read,Grep,Glob,Bash,Write' --disallowedTools 'Edit,Agent'`,
    )
  })
  test('claude browser adds the shipped playwright server and its tools', () => {
    const cmd = buildCommand(role({ browser: true }), claude, files, JOB_DIR)
    expect(cmd).toContain(`--strict-mcp-config --mcp-config ${shq(PLAYWRIGHT_MCP_CONFIG)} --allowedTools`)
    expect(cmd).toContain(`--allowedTools 'Read,Grep,Glob,Bash,Write,${PLAYWRIGHT_TOOLS.join(',')}'`)
  })
  test('only browser roles get an mcp config', () => {
    expect(buildCommand(role(), claude, files, JOB_DIR)).not.toContain('--mcp-config')
    expect(buildCommand(role({ interactive: true }), claude, files, JOB_DIR)).not.toContain('--mcp-config')
  })
  test('pi headless', () => {
    expect(buildCommand(role(), { harness: 'pi', model: 'm' }, files, JOB_DIR)).toBe(
      `pi -p --append-system-prompt '/j/run/sys.md' --model 'm' --tools 'read,grep,find,ls,bash,write' --mode json ${task}`,
    )
  })
  test('pi headless without model', () => {
    expect(buildCommand(role(), { harness: 'pi', model: null }, files, JOB_DIR)).toBe(
      `pi -p --append-system-prompt '/j/run/sys.md' --tools 'read,grep,find,ls,bash,write' --mode json ${task}`,
    )
  })
  test('pi interactive', () => {
    expect(buildCommand(role({ interactive: true }), { harness: 'pi', model: 'm' }, files, JOB_DIR)).toBe(
      `pi --append-system-prompt '/j/run/sys.md' --model 'm' --tools 'read,grep,find,ls,bash,write' ${task}`,
    )
  })
  test('every claude role may use the job folder; pi needs no flag', () => {
    expect(buildCommand(role({ browser: true }), claude, files, JOB_DIR)).toContain(`--add-dir '/j' --strict-mcp-config`)
    expect(buildCommand(role(), { harness: 'pi', model: 'm' }, files, JOB_DIR)).not.toContain('--add-dir')
  })
  test('paths with quotes are escaped', () => {
    expect(buildCommand(role(), claude, { system: "/a'b/s.md", task: '/t.md' }, "/j'x")).toContain(`'/a'\\''b/s.md'`)
    expect(buildCommand(role(), claude, files, "/j'x")).toContain(`--add-dir '/j'\\''x'`)
  })
})

describe('PLAYWRIGHT_TOOLS', () => {
  test('12 unique browser tools of the shipped playwright server', () => {
    expect(PLAYWRIGHT_TOOLS).toHaveLength(12)
    expect(new Set(PLAYWRIGHT_TOOLS).size).toBe(12)
    expect(PLAYWRIGHT_TOOLS.every((t) => t.startsWith('mcp__playwright__browser_'))).toBe(true)
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__playwright__browser_hover')
    expect(PLAYWRIGHT_TOOLS).toContain('mcp__playwright__browser_emulate_media')
  })
})

describe('PLAYWRIGHT_MCP_CONFIG', () => {
  test('one server, playwright, pinned, isolated and headless', async () => {
    expect(PLAYWRIGHT_MCP_CONFIG).toBe(join(PACKAGE_DIR, 'mcp', 'playwright.json'))
    expect(await Bun.file(PLAYWRIGHT_MCP_CONFIG).json()).toEqual({
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.86', '--isolated', '--headless'] },
      },
    })
  })
})

describe('renderTaskPrompt', () => {
  const now = new Date('2026-11-26T00:00:00Z')
  const job = createJob({ id: '261126-thing', feature: 'Add thing', repo: '/r', slot: 1, now })
  const paths = jobPaths('/r', job.id)
  const mk = () => ({ job: { ...job, trip: 2 }, paths, cfg: { ...cfg, base: 'develop' }, assignment: 'Build T1', output: '/r/.factory/jobs/261126-thing/trip-2/build.md', inputs: ['/a.md', '/b.md'], target: 'http://localhost:5110' })

  test('build task with a local target and the base branch', () => {
    expect(renderTaskPrompt(mk())).toBe(
      [
        'Job: 261126-thing',
        'Request: Add thing',
        'Worktree: /r/.factory/261126-thing (your working directory)',
        'Job folder: /r/.factory/jobs/261126-thing',
        'Cycle: 1  Trip: 2',
        'Base: develop',
        'Docs: requirements=docs/requirements/261126-thing.md, tech-discovery=docs/tech-discovery/261126-thing.md, design=docs/design-docs/261126-thing.md, spec=docs/specs/261126-thing.md, test-plan=docs/test-plans/261126-thing.md',
        'Assignment: Build T1',
        'Output: /r/.factory/jobs/261126-thing/trip-2/build.md',
        'Inputs: /a.md, /b.md',
        'Target: http://localhost:5110',
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
    const cmd = buildCommand(role(), { harness: 'claude', model: 'opus' }, { system: join(dir, 'sys.md'), task: taskFile }, dir)
    expect(prompt).toContain(feature)
    expect(cmd).not.toContain('rm -rf')
    expect(cmd).not.toContain('`')
  })
})
