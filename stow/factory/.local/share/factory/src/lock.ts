import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export class LockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockError'
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function holder(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Takes `<jobDir>/driver.lock` for `pid` and returns its release. A lock whose pid is dead is taken over. */
export function acquireLock(jobDir: string, pid: number = process.pid): () => void {
  const file = join(jobDir, 'driver.lock')
  const id = basename(jobDir)
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: 'wx' })
      return () => {
        if (holder(file) === pid) rmSync(file, { force: true })
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const other = holder(file)
    if (other !== null && alive(other)) throw new LockError(`driver already running for ${id} (pid ${other})`)
    rmSync(file, { force: true })
  }
  throw new LockError(`could not take the driver lock for ${id}`)
}
