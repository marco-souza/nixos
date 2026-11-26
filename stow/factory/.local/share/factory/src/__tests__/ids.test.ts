import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newJobId, slugify, takenIds } from '../ids'
import { FakeExec, tempRepo } from './helpers'

test('slugify keeps up to 4 meaningful words', () => {
  expect(slugify('Rate limit the signup form!')).toBe('rate-limit-signup-form')
  expect(slugify('  Ünïcode & symbols: add dark mode to settings page ')).toBe('unicode-symbols-add-dark')
})

test('newJobId uses YYMMDD and suffixes clashes', () => {
  const d = new Date('2026-11-26T12:00:00Z')
  expect(newJobId(d, 'Rate limit the signup form', () => false)).toBe('261126-rate-limit-signup-form')
  const taken = new Set(['261126-rate-limit-signup-form', '261126-rate-limit-signup-form-2'])
  expect(newJobId(d, 'Rate limit the signup form', (id) => taken.has(id))).toBe('261126-rate-limit-signup-form-3')
})

test('takenIds merges job folders, remote factory branches and requirement docs', async () => {
  const t = await tempRepo()
  try {
    await mkdir(join(t.repo, '.factory/jobs/261121-b'), { recursive: true })
    await mkdir(join(t.repo, 'docs/requirements'), { recursive: true })
    await writeFile(join(t.repo, 'docs/requirements/261122-c.md'), '# c\n')
    const exec = new FakeExec([
      { match: ['git', 'ls-remote'], result: { stdout: 'abc\trefs/heads/factory/261120-a\n' } },
    ])
    expect(await takenIds(t.repo, exec)).toEqual(new Set(['261120-a', '261121-b', '261122-c']))
  } finally {
    await t.cleanup()
  }
})
