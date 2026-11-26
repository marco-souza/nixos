import type { Exec } from '../exec'
import { CommandError } from '../machine'
import { requireJob, type Args, type Cli, type Terminal } from './shared'

export const realTerminal: Terminal = {
  get tmux() {
    return Boolean(process.env.TMUX)
  },
  get tty() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
  },
  handOver(cmd) {
    return Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode ?? 1
  },
}

// `=`: the exact session, never a prefix match on another job's.
const target = (id: string) => `=factory-${id}`

/** tmux's exit code; 127 when tmux isn't installed. */
async function tmux(exec: Exec, ...args: string[]): Promise<number> {
  try {
    return (await exec.run(['tmux', ...args])).code
  } catch {
    return 127
  }
}

export const hasTmux = async (exec: Exec) => (await tmux(exec, '-V')) === 0
export const hasSession = async (exec: Exec, id: string) => (await tmux(exec, 'has-session', '-t', target(id))) === 0

/** Takes the human to the job's session: switch-client inside tmux, attach outside on a terminal. False when it can't. */
export async function enterSession(id: string, exec: Exec, term: Terminal): Promise<boolean> {
  if (term.tmux) return (await tmux(exec, 'switch-client', '-t', target(id))) === 0
  if (!term.tty) return false
  term.handOver(['tmux', 'attach', '-t', target(id)])
  return true
}

export async function attachCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const id = args.pos[0]!
  requireJob(repo, id)
  const { exec } = cli.deps(repo)
  if (!(await hasSession(exec, id))) throw new CommandError(`no tmux session factory-${id} (start the driver: factory run ${id})`)
  if (!(await enterSession(id, exec, cli.terminal))) throw new CommandError(`not a terminal; run: tmux attach -t factory-${id}`)
}
