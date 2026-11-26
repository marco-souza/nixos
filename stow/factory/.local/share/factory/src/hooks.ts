import type { FactoryConfig } from './config'
import type { Exec, ExecResult } from './exec'

export type HookName = 'prOpened' | 'qaUrl' | 'qaReady'

export interface HookEnv {
  JOB: string
  PR: string
  BRANCH: string
  SHA: string
}

/** Runs a configured hook in the worktree. Returns null when it isn't configured; non-zero exits are the caller's call. */
export async function runHook(
  name: HookName,
  cfg: FactoryConfig,
  env: HookEnv,
  cwd: string,
  exec: Exec,
): Promise<ExecResult | null> {
  const script = cfg.hooks[name]
  if (!script) return null
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v
  return exec.run(['bash', '-c', script], { cwd, env: merged })
}

/** Polls the qaReady hook until it exits 0 or qaReadyTimeoutMin passes. */
export async function waitQaReady(
  cfg: FactoryConfig,
  env: HookEnv,
  cwd: string,
  exec: Exec,
  clock: { sleep(ms: number): Promise<void>; now(): number },
): Promise<'ready' | 'timeout' | 'no-hook'> {
  if (!cfg.hooks.qaReady) return 'no-hook'
  const start = clock.now()
  const limit = cfg.qaReadyTimeoutMin * 60_000
  while (true) {
    const r = await runHook('qaReady', cfg, env, cwd, exec)
    if (r?.code === 0) return 'ready'
    await clock.sleep(cfg.qaPollSec * 1000)
    if (clock.now() - start >= limit) return 'timeout'
  }
}
