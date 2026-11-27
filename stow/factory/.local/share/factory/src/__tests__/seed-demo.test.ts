import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SEED = join(import.meta.dir, 'fixtures', 'seed-demo.ts')
const seed = (dir: string) => Bun.spawnSync([process.execPath, SEED, dir], { stdout: 'pipe', stderr: 'pipe' })

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'factory-seed-'))
  dirs.push(dir)
  return dir
}

describe('seed-demo', () => {
  test('refuses a non-empty folder it did not seed, and touches nothing', async () => {
    const dir = await tempDir()
    mkdirSync(join(dir, '.factory', 'jobs', 'real-job'), { recursive: true })
    writeFileSync(join(dir, '.factory', 'jobs', 'real-job', 'job.json'), '{"keep":true}')
    const r = seed(dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('refusing to seed')
    expect(readFileSync(join(dir, '.factory', 'jobs', 'real-job', 'job.json'), 'utf8')).toBe('{"keep":true}')
    expect(existsSync(join(dir, '.factory-demo'))).toBe(false)
  })

  test('seeds an empty folder, marks it, and seeds it again', async () => {
    const dir = join(await tempDir(), 'demo')
    expect(seed(dir).exitCode).toBe(0)
    expect(existsSync(join(dir, '.factory-demo'))).toBe(true)
    expect(existsSync(join(dir, '.factory', 'jobs', '251102-wishlist', 'job.json'))).toBe(true)
    expect(seed(dir).exitCode).toBe(0)
  })
})
