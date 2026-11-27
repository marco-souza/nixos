import { CommandError } from '../machine'
import { startServer } from '../server'
import type { Args, Cli } from './shared'

const DEFAULT_PORT = 8000

/** Starts the dashboard server on 127.0.0.1 and prints its address. Port 0 picks a free one. */
export function serveDashboard(args: Args, cli: Cli, repo: string): ReturnType<typeof startServer> {
  const port = args.flags.port === undefined ? DEFAULT_PORT : Number(args.flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CommandError(`not a port: ${args.flags.port}`)
  const server = startServer(repo, cli.deps(repo), { port })
  cli.out(`Factory dashboard: http://127.0.0.1:${server.port}`)
  return server
}

/** Serves until killed: the server keeps the process alive after main returns. */
export async function dashboardCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  serveDashboard(args, cli, repo)
}
