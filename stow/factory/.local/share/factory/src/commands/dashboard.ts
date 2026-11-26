import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CommandError } from '../machine'
import type { Args, Cli } from './shared'

const DEFAULT_PORT = 8000

/** Serves the dashboard on 127.0.0.1 (src/server.ts, Task 15). */
export async function dashboardCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const port = args.flags.port === undefined ? DEFAULT_PORT : Number(args.flags.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CommandError(`not a port: ${args.flags.port}`)
  const server = join(import.meta.dir, '..', 'server.ts')
  if (!existsSync(server)) throw new CommandError('dashboard not available yet')
  const { startServer } = await import(server)
  await startServer({ repo, port, deps: cli.deps(repo) })
  cli.out(`Factory dashboard: http://127.0.0.1:${port}`)
}
