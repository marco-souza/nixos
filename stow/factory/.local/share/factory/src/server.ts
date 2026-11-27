import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { approve } from './commands/approve'
import { discard } from './commands/discard'
import { feedback } from './commands/feedback'
import { detectFormat } from './commands/logs'
import { retry } from './commands/run'
import { findJob, JOB_ID } from './commands/shared'
import { loadConfig } from './config'
import type { Deps } from './deps'
import { listJobs, type Job, type LegacyJob } from './job'
import { acquireLock, LockError } from './lock'
import { CommandError } from './machine'
import { jobPaths, PACKAGE_DIR } from './paths'
import { STEPS } from './prbody'
import { createFormatter } from './tail'
import { nextHint, whatFor } from './ui'

const ACTIVITY_LINES = 200
const MAX_LOG_LINES = 2000
const FORMAT_WIDTH = 160
const ANSI = /\x1b\[[0-9;]*m/g
const PLACEHOLDER =
  '<!doctype html><meta charset="utf-8"><title>Factory dashboard</title><p>Factory dashboard: UI not built yet</p>'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A non-200 answer: thrown by handlers, sent as `{ error }`. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, 'content-type': 'application/json' } })
const text = (body: string, type: string) =>
  new Response(body, { headers: { ...NO_STORE, 'content-type': `${type}; charset=utf-8` } })

function lastLines(file: string, n: number): string[] {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-n)
}

/** Log names (`<role>-<n>`, no extension) in logs/, newest first. */
function logNames(logsDir: string): string[] {
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ name: f.slice(0, -4), mtime: statSync(join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
    .map((l) => l.name)
}

function tripFolders(jobDir: string): { trip: number; files: string[] }[] {
  if (!existsSync(jobDir)) return []
  return readdirSync(jobDir, { withFileTypes: true })
    .flatMap((d) => {
      const m = /^trip-(\d+)$/.exec(d.name)
      return m && d.isDirectory() ? [{ trip: Number(m[1]), dir: d.name }] : []
    })
    .sort((a, b) => a.trip - b.trip)
    .map(({ trip, dir }) => ({
      trip,
      files: readdirSync(join(jobDir, dir), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => `${dir}/${e.name}`)
        .sort(),
    }))
}

/** The v1 or v2 job, or a 404. */
function lookup(repo: string, id: string): { job: Job | LegacyJob; worktree: string } {
  let job
  try {
    job = findJob(repo, id)
  } catch (e) {
    throw new HttpError(404, (e as Error).message)
  }
  return { job, worktree: 'legacy' in job ? jobPaths(repo, id).worktree : job.worktree }
}

function jobDetail(repo: string, id: string) {
  const { job, worktree } = lookup(repo, id)
  const paths = jobPaths(repo, id)
  const docs = loadConfig(repo).docs
  const kinds = [
    ['requirements', docs.requirements],
    ['tech discovery', docs.techDiscovery],
    ['design', docs.design],
    ['spec', docs.specs],
    ['test plan', docs.testPlans],
  ] as const
  return {
    job,
    docs: kinds.map(([name, dir]) => {
      const path = `${dir}/${id}.md`
      return { name, path, exists: existsSync(join(worktree, path)) }
    }),
    trips: tripFolders(paths.jobDir),
    activity: lastLines(paths.activityLog, ACTIVITY_LINES),
    logs: logNames(paths.logsDir),
  }
}

/** `p` is `root` or inside it. */
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/** Reads `rel` from the job dir or the worktree. 403 outside the job dir and `<worktree>/docs/`, 404 when missing. */
function readJobFile(repo: string, id: string, rel: string): string {
  const { worktree } = lookup(repo, id)
  const jobDir = jobPaths(repo, id).jobDir
  const roots = [jobDir, join(worktree, 'docs')]
  const realRoots = roots.map((r) => (existsSync(r) ? realpathSync(r) : r))
  const paths = [jobDir, worktree].map((base) => resolve(base, rel))
  // Lexical check first, so `../..` is refused whether or not the target exists.
  if (!rel || !paths.some((p) => roots.some((r) => inside(r, p)))) throw new HttpError(403, 'path outside the job')
  let denied = false
  for (const p of paths) {
    if (!existsSync(p)) continue
    // Symlinks are judged by where they lead.
    const target = realpathSync(p)
    if (!realRoots.some((r) => inside(r, target))) denied = true
    else if (statSync(target).isFile()) return readFileSync(target, 'utf8')
  }
  throw denied ? new HttpError(403, 'path outside the job') : new HttpError(404, `no file ${rel}`)
}

function jobLog(repo: string, id: string, name: string, lines: number): string[] {
  // Only names the job lists: `name` never becomes a path of its own making.
  if (!jobDetail(repo, id).logs.includes(name)) throw new HttpError(404, `no log ${name}`)
  const body = readFileSync(join(jobPaths(repo, id).logsDir, `${name}.log`), 'utf8')
  // A fresh formatter per log: it remembers tool names between lines.
  const fmt = createFormatter(detectFormat(body), FORMAT_WIDTH)
  const out: string[] = []
  for (const line of body.split('\n')) {
    const f = fmt(line.replace(/\r$/, ''))
    // The formatter colors by TTY and FORCE_COLOR; JSON never carries escapes.
    if (f !== null) out.push(f.replace(ANSI, ''))
  }
  return out.slice(-lines)
}

async function readNote(req: Request): Promise<string | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new CommandError('body must be JSON: { "note": "..." }')
  }
  const note = (body as { note?: unknown } | null)?.note
  if (note !== undefined && note !== null && typeof note !== 'string') throw new CommandError('note must be a string')
  return note ?? null
}

/** Throws LockError when a live driver holds the job's lock: a second driver would refuse to start. */
function requireNoDriver(repo: string, id: string): void {
  if ('legacy' in lookup(repo, id).job) return
  acquireLock(jobPaths(repo, id).jobDir)()
}

/**
 * Serves the dashboard on 127.0.0.1. The actions run the same command cores as the CLI.
 * `htmlFile` overrides the page (tests); it defaults to `<package>/dashboard.html`.
 */
export function startServer(
  repo: string,
  deps: Deps,
  o: { port: number; htmlFile?: string },
): ReturnType<typeof Bun.serve> {
  const project = basename(repo)
  const htmlFile = o.htmlFile ?? join(PACKAGE_DIR, 'dashboard.html')

  const actions: Record<string, (id: string, req: Request) => Promise<Job>> = {
    approve: async (id) => (requireNoDriver(repo, id), approve(repo, id, deps)),
    retry: async (id) => (requireNoDriver(repo, id), retry(repo, id, deps)),
    // The core stops a running driver itself, so a held lock is no reason to refuse.
    feedback: async (id, req) => feedback(repo, id, await readNote(req), deps),
    // The page confirms; the core never prompts.
    discard: async (id) => discard(repo, id, deps),
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const port = server.port
    const origin = req.headers.get('origin')
    if (origin !== null && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      throw new HttpError(403, 'foreign origin')
    }
    // Against DNS rebinding: a page on another name that resolves here.
    const host = req.headers.get('host')
    if (host !== null && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'foreign host')

    const get = () => {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only')
    }
    if (url.pathname === '/') {
      get()
      const html = existsSync(htmlFile) ? readFileSync(htmlFile, 'utf8') : PLACEHOLDER
      return text(html.replaceAll('{{PROJECT}}', escapeHtml(project)), 'text/html')
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'jobs' || parts.length > 4) throw new HttpError(404, 'not found')
    if (parts.length === 2) {
      get()
      // The page shows the CLI's own words and step table, so the three never drift apart.
      const jobs = listJobs(repo).map((j) =>
        'legacy' in j ? { ...j, hint: null, whatFor: null } : { ...j, hint: nextHint(j), whatFor: whatFor(j) },
      )
      const limits = { maxTrips: loadConfig(repo).maxTrips }
      return json({ project, jobs, now: deps.now().toISOString(), limits, steps: STEPS })
    }
    let id: string
    try {
      id = decodeURIComponent(parts[2]!)
    } catch {
      throw new HttpError(404, 'not found')
    }
    if (!JOB_ID.test(id)) throw new HttpError(404, `no job ${id}`)
    const action = parts[3]
    if (action === undefined) {
      get()
      return json(jobDetail(repo, id))
    }
    if (action === 'file') {
      get()
      return text(readJobFile(repo, id, url.searchParams.get('path') ?? ''), 'text/plain')
    }
    if (action === 'log') {
      get()
      const n = Number(url.searchParams.get('lines') ?? ACTIVITY_LINES)
      const lines = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LOG_LINES) : ACTIVITY_LINES
      return json({ lines: jobLog(repo, id, url.searchParams.get('name') ?? '', lines) })
    }
    const run = Object.hasOwn(actions, action) ? actions[action] : undefined
    if (!run) throw new HttpError(404, 'not found')
    if (req.method !== 'POST') throw new HttpError(405, 'POST only')
    if (req.headers.get('x-factory') !== '1') throw new HttpError(403, 'missing X-Factory header')
    return json({ job: await run(id, req) })
  }

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port,
    async fetch(req) {
      try {
        return await handle(req)
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status)
        if (e instanceof CommandError) return json({ error: e.message }, 400)
        if (e instanceof LockError) return json({ error: e.message }, 409)
        return json({ error: e instanceof Error ? e.message : String(e) }, 500)
      }
    },
  })
  return server
}
