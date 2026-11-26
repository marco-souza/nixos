import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realExec } from '../exec'
import { findRepo, jobPaths } from '../paths'
import { tempRepo } from './helpers'

test('findRepo returns the main checkout from inside a worktree', async () => {
  const t = await tempRepo()
  try {
    const wt = join(t.repo, '.factory', 'wt')
    const r = await realExec.run(['git', 'worktree', 'add', '-b', 'factory/wt', wt], { cwd: t.repo })
    expect(r.code).toBe(0)
    expect(await findRepo(wt, realExec)).toBe(t.repo)
    expect(await findRepo(t.repo, realExec)).toBe(t.repo)
  } finally {
    await t.cleanup()
  }
})

test('findRepo outside git throws "not inside a git repository"', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-nogit-')))
  try {
    await expect(findRepo(dir, realExec)).rejects.toThrow('not inside a git repository')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('jobPaths lays out .factory', () => {
  const p = jobPaths('/r', '261126-x')
  expect(p.jobDir).toBe('/r/.factory/jobs/261126-x')
  expect(p.worktree).toBe('/r/.factory/261126-x')
  expect(p.tripDir(2)).toBe('/r/.factory/jobs/261126-x/trip-2')
  expect(p.discoveryReview(1)).toBe('/r/.factory/jobs/261126-x/discovery-review-1.md')
})
