import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newJobId, slugify, takenIds } from '../ids'
import { FakeExec, tempRepo } from './helpers'

test('slugify keeps up to 4 meaningful words', () => {
  expect(slugify('Rate limit the signup form!')).toBe('rate-limit-signup-form')
  expect(slugify('  Ünïcode & symbols: add dark mode to settings page ')).toBe('unicode-symbols-add-dark')
})

test('slugify falls back to "job" when nothing is left', () => {
  expect(slugify('')).toBe('job')
  expect(slugify('the to of !!!')).toBe('job')
  expect(slugify('日本語')).toBe('job')
})

test('newJobId uses YYMMDD and suffixes clashes', () => {
  const d = new Date(2026, 10, 26, 12)
  expect(newJobId(d, 'Rate limit the signup form', () => false)).toBe('261126-rate-limit-signup-form')
  const taken = new Set(['261126-rate-limit-signup-form', '261126-rate-limit-signup-form-2'])
  expect(newJobId(d, 'Rate limit the signup form', (id) => taken.has(id))).toBe('261126-rate-limit-signup-form-3')
})

test('newJobId uses the local date, not UTC', () => {
  const tz = process.env.TZ
  try {
    // bun test runs in UTC; 23:30 local in São Paulo is already the next day in UTC.
    process.env.TZ = 'America/Sao_Paulo'
    expect(newJobId(new Date(2026, 10, 26, 23, 30), 'x', () => false)).toBe('261126-x')
    // 00:30 local in Tokyo is still the previous day in UTC.
    process.env.TZ = 'Asia/Tokyo'
    expect(newJobId(new Date(2026, 10, 27, 0, 30), 'x', () => false)).toBe('261127-x')
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
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
    expect(await takenIds(t.repo, exec, 'docs/requirements')).toEqual(new Set(['261120-a', '261121-b', '261122-c']))
  } finally {
    await t.cleanup()
  }
})

test('takenIds reads requirement docs from the configured folder', async () => {
  const t = await tempRepo()
  try {
    await mkdir(join(t.repo, 'docs/req'), { recursive: true })
    await writeFile(join(t.repo, 'docs/req/261122-c.md'), '# c\n')
    await mkdir(join(t.repo, 'docs/requirements'), { recursive: true })
    await writeFile(join(t.repo, 'docs/requirements/261123-d.md'), '# d\n')
    expect(await takenIds(t.repo, new FakeExec(), 'docs/req')).toEqual(new Set(['261122-c']))
  } finally {
    await t.cleanup()
  }
})

test('takenIds still returns local ids when ls-remote fails', async () => {
  const t = await tempRepo()
  try {
    await mkdir(join(t.repo, '.factory/jobs/261121-b'), { recursive: true })
    const exec = new FakeExec([{ match: ['git', 'ls-remote'], result: { code: 128, stderr: "fatal: 'origin' does not appear to be a git repository" } }])
    expect(await takenIds(t.repo, exec, 'docs/requirements')).toEqual(new Set(['261121-b']))
  } finally {
    await t.cleanup()
  }
})
