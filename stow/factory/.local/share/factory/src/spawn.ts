import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Harness } from './config'
import type { Exec } from './exec'
import { CLI_PATH, jobPaths } from './paths'
import { shq } from './shell'

export interface SpawnRequest {
  jobId: string
  window: string
  cwd: string
  command: string
  scriptFile: string
  logFile: string
  doneFile: string
  tail: Harness | null
}

export interface Spawner {
  start(req: SpawnRequest): Promise<void>
  isAlive(jobId: string, window: string): Promise<boolean>
  kill(jobId: string, window: string): Promise<void>
  /** Every agent of the job; not the driver. */
  killAgents(jobId: string): Promise<void>
  /** Starts the job's driver in the background, replacing a running one. Throws when it can't start. */
  respawnDriver(jobId: string, cwd: string, driverCmd: string): Promise<void>
}

// A bad cwd must still leave an exit code, or the waiter runs to its timeout.
const cdFail = (req: SpawnRequest) => `{ echo 97 > ${shq(req.doneFile)}; exit 97; }`

/** Write `req.scriptFile` and return its content. */
export function writeRunScript(req: SpawnRequest): string {
  const tail = req.tail ? ` | ${shq(process.execPath)} ${shq(CLI_PATH)} tail --format ${req.tail}` : ''
  const lines = [
    '#!/usr/bin/env bash',
    'set -o pipefail',
    `cd ${shq(req.cwd)} || ${cdFail(req)}`,
    `${req.command} 2>&1 | tee -a ${shq(req.logFile)}${tail}`,
    `echo "\${PIPESTATUS[0]}" > ${shq(req.doneFile)}`,
  ]
  const script = lines.join('\n') + '\n'
  writeFileSync(req.scriptFile, script)
  return script
}

const DRIVER = 'driver'

/** Background processes, one pid file each under the job's run folder. They outlive the command that started them. */
export class ProcessSpawner implements Spawner {
  constructor(private repo: string) {}

  private pidFile(jobId: string, name: string) {
    return join(jobPaths(this.repo, jobId).runDir, `${name}.pid`)
  }

  private launch(jobId: string, name: string, argv: string[], cwd: string, logFile: string): void {
    mkdirSync(dirname(logFile), { recursive: true })
    mkdirSync(dirname(this.pidFile(jobId, name)), { recursive: true })
    const fd = openSync(logFile, 'a')
    try {
      // detached: its own process group, so `kill` takes the whole tree and a closed terminal doesn't.
      const p = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: fd, stderr: fd, detached: true })
      p.unref()
      writeFileSync(this.pidFile(jobId, name), String(p.pid))
    } finally {
      closeSync(fd)
    }
  }

  private pid(jobId: string, name: string): number | null {
    const f = this.pidFile(jobId, name)
    if (!existsSync(f)) return null
    const n = Number(readFileSync(f, 'utf8').trim())
    if (!Number.isInteger(n) || n <= 0) return null
    try {
      process.kill(n, 0)
      return n
    } catch {
      return null
    }
  }

  async start(req: SpawnRequest): Promise<void> {
    writeRunScript(req)
    this.launch(req.jobId, req.window, ['bash', req.scriptFile], req.cwd, `${req.scriptFile}.out`)
  }

  async isAlive(jobId: string, window: string): Promise<boolean> {
    return this.pid(jobId, window) !== null
  }

  async kill(jobId: string, window: string): Promise<void> {
    const pid = this.pid(jobId, window)
    if (pid === null) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // gone already
    }
  }

  async killAgents(jobId: string): Promise<void> {
    const dir = jobPaths(this.repo, jobId).runDir
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.pid') && f !== `${DRIVER}.pid`) await this.kill(jobId, f.slice(0, -4))
    }
  }

  async respawnDriver(jobId: string, cwd: string, driverCmd: string): Promise<void> {
    // Never kill ourselves: `factory run --here` is the driver.
    const old = this.pid(jobId, DRIVER)
    if (old !== null && old !== process.pid) await this.kill(jobId, DRIVER)
    this.launch(jobId, DRIVER, ['bash', '-c', `exec ${driverCmd}`], cwd, join(jobPaths(this.repo, jobId).logsDir, 'driver.log'))
  }
}

/** Same contract without processes: runs the script to completion in `start()`. For the grill, tests and `--inline`. */
export class InlineSpawner implements Spawner {
  constructor(private exec: Exec) {}

  async start(req: SpawnRequest): Promise<void> {
    writeRunScript(req)
    await this.exec.run(['bash', req.scriptFile])
  }

  async isAlive(): Promise<boolean> {
    return false
  }

  async kill(): Promise<void> {}
  async killAgents(): Promise<void> {}
  async respawnDriver(): Promise<void> {}
}

export interface WaitOptions {
  timeoutMs: number
  pollMs: number
  sleep(ms: number): Promise<void>
  now(): number
}

/** Check `pred` first, then every `pollMs` until `timeoutMs` has elapsed. */
export async function waitForFile(pred: () => boolean, o: WaitOptions): Promise<'done' | 'timeout'> {
  const start = o.now()
  for (;;) {
    if (pred()) return 'done'
    if (o.now() - start >= o.timeoutMs) return 'timeout'
    await o.sleep(o.pollMs)
  }
}

/** Exit code in a done file; null when missing or not an integer. */
export function readExitCode(doneFile: string): number | null {
  if (!existsSync(doneFile)) return null
  const s = readFileSync(doneFile, 'utf8').trim()
  return /^-?\d+$/.test(s) ? Number(s) : null
}
