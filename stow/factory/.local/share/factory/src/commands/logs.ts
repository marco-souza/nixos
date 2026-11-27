import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../config'
import { CommandError } from '../machine'
import { jobPaths } from '../paths'
import { createFormatter } from '../tail'
import { paint } from '../ui'
import { requireJob, type Args, type Cli } from './shared'

const LAST_LINES = 200
const FOLLOW_POLL_MS = 500
const LOG = /^(.+)-(\d+)\.log$/
const CLAUDE_TYPES = new Set(['system', 'assistant', 'user', 'result'])

/** `<role>-<n>.log`: the role's highest n, or with no role the latest written log. */
function pickLog(logsDir: string, role: string | undefined): string | null {
  const logs = (existsSync(logsDir) ? readdirSync(logsDir) : []).flatMap((f) => {
    const m = LOG.exec(f)
    return m ? [{ file: f, role: m[1]!, n: Number(m[2]) }] : []
  })
  if (role) {
    const mine = logs.filter((l) => l.role === role).sort((a, b) => b.n - a.n)
    return mine[0]?.file ?? null
  }
  const mtime = (f: string) => statSync(join(logsDir, f)).mtimeMs
  return logs.map((l) => l.file).sort((a, b) => mtime(b) - mtime(a))[0] ?? null
}

/** From the first JSON line: claude events have a `session_id` and a claude `type`; anything else is pi. */
export function detectFormat(text: string): Harness {
  for (const line of text.split('\n')) {
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue
    const e = ev as Record<string, unknown>
    return typeof e.session_id === 'string' && CLAUDE_TYPES.has(e.type as string) ? 'claude' : 'pi'
  }
  return 'claude'
}

/** Prints the last lines of an agent's log through one formatter of its own; `-f` follows it until the agent is done. */
export async function logsCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const [id, role] = args.pos as [string, string | undefined]
  requireJob(repo, id)
  const paths = jobPaths(repo, id)
  const name = pickLog(paths.logsDir, role)
  if (!name) throw new CommandError(role ? `no ${role} logs for ${id}` : `no logs for ${id} yet`)
  const file = join(paths.logsDir, name)
  const bytes = readFileSync(file)
  const text = bytes.toString('utf8')
  const fmt = createFormatter(detectFormat(text))
  const emit = (line: string) => {
    const out = fmt(line.replace(/\r$/, ''))
    if (out !== null) cli.out(out)
  }
  const follow = args.flags.f === true || args.flags.follow === true
  // A line still being written is printed whole when following, as it lands.
  const end = text.endsWith('\n') || !follow ? text.length : text.lastIndexOf('\n') + 1
  cli.out(paint('dim', `logs/${name}`))
  const lines = text.slice(0, end).split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines.slice(-LAST_LINES)) emit(line)
  if (!follow) return
  const doneFile = join(paths.doneDir, name.replace(/\.log$/, ''))
  await followLog(file, bytes.length, text.slice(end), doneFile, emit, cli.deps(repo).sleep)
}

async function followLog(
  file: string,
  offset: number,
  pending: string,
  doneFile: string,
  emit: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder()
  let buf = pending
  for (;;) {
    // Checked before reading, so the agent's last write is never missed.
    const done = existsSync(doneFile)
    const size = statSync(file).size
    if (size > offset) {
      const chunk = Buffer.alloc(size - offset)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, chunk, 0, chunk.length, offset)
      } finally {
        closeSync(fd)
      }
      offset = size
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        emit(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    if (done) {
      if (buf) emit(buf)
      return
    }
    await sleep(FOLLOW_POLL_MS)
  }
}
