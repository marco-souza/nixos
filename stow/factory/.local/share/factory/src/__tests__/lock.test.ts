import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockError } from '../lock'

let jobDir: string
beforeEach(() => {
  jobDir = join(mkdtempSync(join(tmpdir(), 'factory-lock-')), '261126-x')
  mkdirSync(jobDir)
})
afterEach(() => rmSync(join(jobDir, '..'), { recursive: true, force: true }))

/** A pid that existed and has exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(['true'])
  await p.exited
  return p.pid
}

describe('acquireLock', () => {
  test('second acquire throws with pid', () => {
    const release = acquireLock(jobDir)
    expect(() => acquireLock(jobDir)).toThrow(new LockError(`driver already running for 261126-x (pid ${process.pid})`))
    expect(() => acquireLock(jobDir)).toThrow(LockError)
    release()
    expect(existsSync(join(jobDir, 'driver.lock'))).toBe(false)
    acquireLock(jobDir)()
  })

  test('stale lock is reclaimed', async () => {
    const dead = await deadPid()
    writeFileSync(join(jobDir, 'driver.lock'), `${dead}\n`)
    const release = acquireLock(jobDir)
    expect(readFileSync(join(jobDir, 'driver.lock'), 'utf8').trim()).toBe(String(process.pid))
    release()
  })

  test('garbage lock content is reclaimed', () => {
    writeFileSync(join(jobDir, 'driver.lock'), 'not a pid')
    acquireLock(jobDir)()
  })

  test('release leaves a lock taken over by another pid alone', () => {
    const release = acquireLock(jobDir)
    writeFileSync(join(jobDir, 'driver.lock'), '1\n')
    release()
    expect(readFileSync(join(jobDir, 'driver.lock'), 'utf8').trim()).toBe('1')
  })
})
