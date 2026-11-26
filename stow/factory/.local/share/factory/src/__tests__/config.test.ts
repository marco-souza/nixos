import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'

const dirs: string[] = []
async function repoWith(factoryJson?: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'factory-config-'))
  dirs.push(d)
  if (factoryJson !== undefined) await writeFile(join(d, '.factory.json'), factoryJson)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('loadConfig', () => {
  test('defaults when the repo has no .factory.json', async () => {
    const c = loadConfig(await repoWith())
    expect(c.validators).toEqual(['e2e', 'user'])
    expect(c.models.claude.high).toBe('opus')
  })

  test('repo overrides merge', async () => {
    const c = loadConfig(
      await repoWith(JSON.stringify({ docs: { specs: 'spec' }, roles: { 'reviewer-security': { harness: 'pi' } } })),
    )
    expect(c.docs.specs).toBe('spec')
    expect(c.docs.requirements).toBe('docs/requirements')
    expect(c.roles['reviewer-security']!.harness).toBe('pi')
  })

  test('arrays replace the default', async () => {
    const c = loadConfig(await repoWith(JSON.stringify({ validators: ['load'], setup: ['bun install'] })))
    expect(c.validators).toEqual(['load'])
    expect(c.setup).toEqual(['bun install'])
  })

  test('invalid JSON names the file', async () => {
    const repo = await repoWith('{ nope')
    expect(() => loadConfig(repo)).toThrow('.factory.json')
  })

  test('unknown validator is rejected', async () => {
    const repo = await repoWith(JSON.stringify({ validators: ['smoke'] }))
    expect(() => loadConfig(repo)).toThrow('unknown validator "smoke" (known: e2e, user, load, capacity)')
  })
})
