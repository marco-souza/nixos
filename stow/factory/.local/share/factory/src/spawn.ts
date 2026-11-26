import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Harness } from './config'
import type { Exec } from './exec'
import { CLI_PATH } from './paths'
import { shq } from './shell'

export interface SpawnRequest {
  jobId: string
  window: string
  cwd: string
  command: string
  scriptFile: string
  logFile: string
  doneFile: string
  interactive: boolean
  tail: Harness | null
}

export interface Spawner {
  /** Session `factory-<job>` with a `driver` window. No-op when it exists. */
  ensureSession(jobId: string, cwd: string, driverCmd: string): Promise<void>
  start(req: SpawnRequest): Promise<void>
  isAlive(jobId: string, window: string): Promise<boolean>
  kill(jobId: string, window: string): Promise<void>
  /** Every window but `driver`. */
  killAgents(jobId: string): Promise<void>
  killSession(jobId: string): Promise<void>
  /** Creates the session when missing. */
  respawnDriver(jobId: string, cwd: string, driverCmd: string): Promise<void>
}

const session = (jobId: string) => `factory-${jobId}`

/** Write `req.scriptFile` and return its content. */
export function writeRunScript(req: SpawnRequest): string {
  const lines = ['#!/usr/bin/env bash']
  if (req.interactive) {
    lines.push(`cd ${shq(req.cwd)} || exit 97`, req.command, `echo $? > ${shq(req.doneFile)}`)
  } else {
    const tail = req.tail ? ` | ${shq(process.execPath)} ${shq(CLI_PATH)} tail --format ${req.tail}` : ''
    lines.push(
      'set -o pipefail',
      `cd ${shq(req.cwd)} || exit 97`,
      `${req.command} 2>&1 | tee -a ${shq(req.logFile)}${tail}`,
      `echo "\${PIPESTATUS[0]}" > ${shq(req.doneFile)}`,
    )
  }
  const script = lines.join('\n') + '\n'
  writeFileSync(req.scriptFile, script)
  return script
}

export class TmuxSpawner implements Spawner {
  constructor(private exec: Exec) {}

  private tmux(...args: string[]) {
    return this.exec.run(['tmux', ...args])
  }

  private async hasSession(jobId: string): Promise<boolean> {
    return (await this.tmux('has-session', '-t', session(jobId))).code === 0
  }

  private async createSession(jobId: string, cwd: string, driverCmd: string): Promise<void> {
    const s = session(jobId)
    await this.tmux('new-session', '-d', '-s', s, '-n', 'driver', '-c', cwd, driverCmd)
    await this.tmux('set-option', '-t', s, 'status-left', '#[bold]factory #S ')
  }

  async ensureSession(jobId: string, cwd: string, driverCmd: string): Promise<void> {
    if (!(await this.hasSession(jobId))) await this.createSession(jobId, cwd, driverCmd)
  }

  async start(req: SpawnRequest): Promise<void> {
    writeRunScript(req)
    const target = `${session(req.jobId)}:${req.window}`
    // -d: never steal focus from the driver or the human.
    const created = await this.tmux(
      'new-window', '-d', '-t', session(req.jobId), '-n', req.window, '-c', req.cwd, `bash ${shq(req.scriptFile)}`,
    )
    if (created.code !== 0) throw new Error(`tmux new-window ${req.window}: ${created.stderr.trim()}`)
    // Keep a failed agent's window for inspection.
    await this.tmux('set-option', '-w', '-t', target, 'remain-on-exit', 'on')
    if (req.interactive) await this.tmux('select-window', '-t', target)
  }

  private async windows(jobId: string, format: string): Promise<string[]> {
    const r = await this.tmux('list-windows', '-t', session(jobId), '-F', format)
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
  }

  async isAlive(jobId: string, window: string): Promise<boolean> {
    const rows = await this.windows(jobId, '#{window_name} #{pane_dead}')
    return rows.some((row) => row === `${window} 0`)
  }

  async kill(jobId: string, window: string): Promise<void> {
    await this.tmux('kill-window', '-t', `${session(jobId)}:${window}`)
  }

  async killAgents(jobId: string): Promise<void> {
    for (const w of await this.windows(jobId, '#{window_name}')) {
      if (w !== 'driver') await this.kill(jobId, w)
    }
  }

  async killSession(jobId: string): Promise<void> {
    await this.tmux('kill-session', '-t', session(jobId))
  }

  async respawnDriver(jobId: string, cwd: string, driverCmd: string): Promise<void> {
    if (!(await this.hasSession(jobId))) return this.createSession(jobId, cwd, driverCmd)
    await this.tmux('respawn-window', '-k', '-t', `${session(jobId)}:driver`, '-c', cwd, driverCmd)
  }
}

/** Same contract without tmux: runs the script to completion in `start()`. For tests and `--inline`. */
export class InlineSpawner implements Spawner {
  constructor(private exec: Exec) {}

  async ensureSession(): Promise<void> {}

  async start(req: SpawnRequest): Promise<void> {
    writeRunScript(req)
    await this.exec.run(['bash', req.scriptFile])
  }

  async isAlive(): Promise<boolean> {
    return false
  }

  async kill(): Promise<void> {}
  async killAgents(): Promise<void> {}
  async killSession(): Promise<void> {}
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
