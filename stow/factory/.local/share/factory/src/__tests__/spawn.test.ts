import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realExec } from '../exec'
import { InlineSpawner, readExitCode, TmuxSpawner, waitForFile, writeRunScript, type SpawnRequest } from '../spawn'
import { FakeExec } from './helpers'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-spawn-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function req(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    jobId: 'j',
    window: 'planner',
    cwd: dir,
    command: 'echo hi',
    scriptFile: join(dir, 'run.sh'),
    logFile: join(dir, 'a.log'),
    doneFile: join(dir, 'a.done'),
    interactive: false,
    tail: null,
    ...over,
  }
}

describe('writeRunScript', () => {
  test('headless script pipes through tail and records PIPESTATUS', () => {
    const s = writeRunScript(req({ tail: 'claude' }))
    expect(s).toContain('set -o pipefail')
    expect(s).toContain('${PIPESTATUS[0]}')
    expect(s).toContain('tail --format claude')
    expect(s).toContain('tee -a')
  })

  test('interactive script runs the command alone', () => {
    const s = writeRunScript(req({ interactive: true }))
    expect(s).not.toContain('tee')
    expect(s).toContain(`echo $? > '${dir}/a.done'`)
  })

  test('paths with quotes are shell-quoted', () => {
    const s = writeRunScript(req({ cwd: "/tmp/it's" }))
    expect(s).toContain(`cd '/tmp/it'\\''s' || { echo 97 > '${dir}/a.done'; exit 97; }`)
  })
})

describe('TmuxSpawner', () => {
  test('start issues new-window -d with remain-on-exit', async () => {
    const exec = new FakeExec()
    const r = req()
    await new TmuxSpawner(exec).start(r)
    expect(exec.calls).toEqual([
      ['tmux', 'new-window', '-d', '-t', '=factory-j:', '-n', 'planner', '-c', dir, `bash '${r.scriptFile}'`],
      ['tmux', 'set-option', '-w', '-t', '=factory-j:planner', 'remain-on-exit', 'on'],
    ])
  })

  test('interactive start also selects the window', async () => {
    const exec = new FakeExec()
    await new TmuxSpawner(exec).start(req({ interactive: true }))
    expect(exec.calls.at(-1)).toEqual(['tmux', 'select-window', '-t', '=factory-j:planner'])
  })

  test('ensureSession creates the session only when missing', async () => {
    const missing = new FakeExec([{ match: ['tmux', 'has-session'], result: { code: 1 } }])
    await new TmuxSpawner(missing).ensureSession('j', dir, 'drv')
    expect(missing.calls[1]).toEqual(['tmux', 'new-session', '-d', '-s', 'factory-j', '-n', 'driver', '-c', dir, 'drv'])
    expect(missing.calls[2]).toEqual(['tmux', 'set-option', '-t', '=factory-j', 'status-left', '#[bold]factory #S '])
    expect(missing.calls[3]).toEqual(['tmux', 'set-option', '-t', '=factory-j', 'remain-on-exit', 'on'])
    const present = new FakeExec()
    await new TmuxSpawner(present).ensureSession('j', dir, 'drv')
    expect(present.calls).toHaveLength(1)
  })

  test('session names that are prefixes of each other do not collide', async () => {
    const exec = new FakeExec()
    const sp = new TmuxSpawner(exec)
    await sp.ensureSession('a', dir, 'drv')
    await sp.start(req({ jobId: 'a' }))
    await sp.killAgents('a')
    await sp.killSession('a')
    const targets = exec.calls.flatMap((c) => {
      const i = c.indexOf('-t')
      return i < 0 ? [] : [c[i + 1]]
    })
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(t.startsWith('=factory-a')).toBe(true)
    expect(exec.calls).toContainEqual(['tmux', 'kill-session', '-t', '=factory-a'])
  })

  test('killAgents kills every window but driver', async () => {
    const exec = new FakeExec([{ match: ['tmux', 'list-windows'], result: { stdout: 'driver\nplanner\nbuilder\n' } }])
    await new TmuxSpawner(exec).killAgents('j')
    const kills = exec.calls.filter((c) => c[1] === 'kill-window')
    expect(kills).toEqual([
      ['tmux', 'kill-window', '-t', '=factory-j:planner'],
      ['tmux', 'kill-window', '-t', '=factory-j:builder'],
    ])
  })

  test('respawnDriver respawns when the session exists, creates it otherwise', async () => {
    const present = new FakeExec([{ match: ['tmux', 'list-windows'], result: { stdout: 'driver\nplanner\n' } }])
    await new TmuxSpawner(present).respawnDriver('j', dir, 'drv')
    expect(present.calls.at(-1)).toEqual(['tmux', 'respawn-window', '-k', '-t', '=factory-j:driver', '-c', dir, 'drv'])
    const missing = new FakeExec([{ match: ['tmux', 'has-session'], result: { code: 1 } }])
    await new TmuxSpawner(missing).respawnDriver('j', dir, 'drv')
    expect(missing.calls.some((c) => c[1] === 'new-session')).toBe(true)
  })

  test('respawnDriver opens a new driver window when the human closed it', async () => {
    const exec = new FakeExec([{ match: ['tmux', 'list-windows'], result: { stdout: 'planner\n' } }])
    await new TmuxSpawner(exec).respawnDriver('j', dir, 'drv')
    expect(exec.calls.at(-1)).toEqual(['tmux', 'new-window', '-d', '-t', '=factory-j:', '-n', 'driver', '-c', dir, 'drv'])
    expect(exec.calls.some((c) => c[1] === 'respawn-window')).toBe(false)
  })

  test('a tmux failure starting the driver throws its first stderr line', async () => {
    const error = (rules: ConstructorParameters<typeof FakeExec>[0]) => new TmuxSpawner(new FakeExec(rules)).respawnDriver('j', dir, 'drv')
    const message = 'tmux: could not start the driver for j: boom'
    const fail = { code: 1, stderr: '\nboom\nmore\n' }
    await expect(error([{ match: ['tmux', 'list-windows'], result: { stdout: 'driver\n' } }, { match: ['tmux', 'respawn-window'], result: fail }])).rejects.toThrow(message)
    await expect(error([{ match: ['tmux', 'new-window'], result: fail }])).rejects.toThrow(message)
    await expect(error([{ match: ['tmux', 'has-session'], result: { code: 1 } }, { match: ['tmux', 'new-session'], result: fail }])).rejects.toThrow(message)
    const created = new FakeExec([{ match: ['tmux', 'has-session'], result: { code: 1 } }, { match: ['tmux', 'new-session'], result: { code: 1 } }])
    await expect(new TmuxSpawner(created).ensureSession('j', dir, 'drv')).rejects.toThrow('tmux: could not start the driver for j: exit 1')
    expect(created.calls.some((c) => c[1] === 'set-option')).toBe(false)
  })

  test.skipIf(!Bun.which('tmux'))('real tmux runs a window to completion', async () => {
    const jobId = `t${process.pid}x${Date.now()}`
    const sp = new TmuxSpawner(realExec)
    const r = req({ jobId, command: 'echo hi' })
    try {
      await sp.ensureSession(jobId, dir, 'sleep 60')
      await sp.start(r)
      const res = await waitForFile(() => readExitCode(r.doneFile) !== null, {
        timeoutMs: 10000,
        pollMs: 50,
        sleep: (ms) => Bun.sleep(ms),
        now: Date.now,
      })
      expect(res).toBe('done')
      expect((await readFile(r.doneFile, 'utf8')).trim()).toBe('0')
    } finally {
      await sp.killSession(jobId)
    }
  })
})

describe('InlineSpawner', () => {
  test('runs the script and writes the exit code', async () => {
    const r = req({ command: 'exit 3' })
    await new InlineSpawner(realExec).start(r)
    expect(readExitCode(r.doneFile)).toBe(3)
  })
})

describe('bad cwd', () => {
  test('InlineSpawner records exit 97 when cwd does not exist', async () => {
    const r = req({ cwd: join(dir, 'missing') })
    await new InlineSpawner(realExec).start(r)
    expect(readExitCode(r.doneFile)).toBe(97)
    const i = req({ cwd: join(dir, 'missing'), interactive: true, doneFile: join(dir, 'i.done') })
    await new InlineSpawner(realExec).start(i)
    expect(readExitCode(i.doneFile)).toBe(97)
  })
})

describe('waitForFile', () => {
  test('times out with a fake clock', async () => {
    let t = 0
    const res = await waitForFile(() => false, {
      timeoutMs: 100,
      pollMs: 30,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    })
    expect(res).toBe('timeout')
  })

  test('checks before the first sleep', async () => {
    const res = await waitForFile(() => true, {
      timeoutMs: 0,
      pollMs: 30,
      sleep: async () => {
        throw new Error('slept')
      },
      now: () => 0,
    })
    expect(res).toBe('done')
  })
})

describe('readExitCode', () => {
  test('null when missing or not an integer', async () => {
    expect(readExitCode(join(dir, 'nope'))).toBeNull()
    await Bun.write(join(dir, 'x'), 'abc\n')
    expect(readExitCode(join(dir, 'x'))).toBeNull()
    await Bun.write(join(dir, 'y'), '7\n')
    expect(readExitCode(join(dir, 'y'))).toBe(7)
  })
})
