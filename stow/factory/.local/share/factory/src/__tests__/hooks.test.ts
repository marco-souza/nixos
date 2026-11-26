import { describe, expect, test } from 'bun:test'
import { realExec, type Exec, type ExecResult } from '../exec'
import type { FactoryConfig } from '../config'
import { runHook, waitQaReady, type HookEnv } from '../hooks'

const env: HookEnv = { JOB: 'j', PR: '7', BRANCH: 'factory/j', SHA: 'abc' }
const cfg = (hooks: FactoryConfig['hooks']) =>
  ({ hooks, qaReadyTimeoutMin: 1, qaPollSec: 5 }) as FactoryConfig

class ScriptedExec implements Exec {
  calls: { cmd: string[]; cwd?: string; env?: Record<string, string> }[] = []
  constructor(private codes: number[]) {}
  async run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    this.calls.push({ cmd, ...opts })
    return { code: this.codes[this.calls.length - 1] ?? 1, stdout: '', stderr: '' }
  }
}

describe('runHook', () => {
  test('hook env reaches the command', async () => {
    const r = await runHook('qaUrl', cfg({ qaUrl: 'echo $JOB-$PR' }), env, process.cwd(), realExec)
    expect(r?.code).toBe(0)
    expect(r?.stdout.trim()).toBe('j-7')
  })

  test('runs via bash -c in cwd with env merged over process.env', async () => {
    const exec = new ScriptedExec([0])
    await runHook('prOpened', cfg({ prOpened: 'true' }), env, '/wt', exec)
    expect(exec.calls[0].cmd).toEqual(['bash', '-c', 'true'])
    expect(exec.calls[0].cwd).toBe('/wt')
    expect(exec.calls[0].env).toMatchObject({ JOB: 'j', PR: '7', BRANCH: 'factory/j', SHA: 'abc' })
    expect(exec.calls[0].env?.PATH).toBe(process.env.PATH ?? '')
  })

  test('non-zero exit is returned, not thrown', async () => {
    const r = await runHook('qaReady', cfg({ qaReady: 'exit 3' }), env, process.cwd(), realExec)
    expect(r?.code).toBe(3)
  })

  test('unconfigured hook returns null', async () => {
    const exec = new ScriptedExec([])
    expect(await runHook('qaUrl', cfg({}), env, '/wt', exec)).toBeNull()
    expect(exec.calls).toHaveLength(0)
  })
})

describe('waitQaReady', () => {
  const clock = () => {
    let t = 0
    const sleeps: number[] = []
    return {
      sleeps,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        t += ms
      },
      now: () => t,
    }
  }

  test('ready on the 3rd poll, sleeping qaPollSec between polls', async () => {
    const exec = new ScriptedExec([1, 1, 0])
    const c = clock()
    expect(await waitQaReady(cfg({ qaReady: 'x' }), env, '/wt', exec, c)).toBe('ready')
    expect(exec.calls).toHaveLength(3)
    expect(c.sleeps).toEqual([5000, 5000])
  })

  test('timeout after qaReadyTimeoutMin', async () => {
    const exec = new ScriptedExec([])
    const c = clock()
    expect(await waitQaReady(cfg({ qaReady: 'x' }), env, '/wt', exec, c)).toBe('timeout')
    expect(exec.calls).toHaveLength(12)
    expect(c.now()).toBe(60_000)
  })

  test('no-hook makes no calls', async () => {
    const exec = new ScriptedExec([])
    expect(await waitQaReady(cfg({}), env, '/wt', exec, clock())).toBe('no-hook')
    expect(exec.calls).toHaveLength(0)
  })
})
