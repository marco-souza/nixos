import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Exec } from './exec'
import { jobPaths } from './paths'

const STOPWORDS = new Set('a an the to of for and in on with into from by'.split(' '))

export function slugify(feature: string): string {
  return feature
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 4)
    .join('-')
}

export function newJobId(date: Date, feature: string, taken: (id: string) => boolean): string {
  const yymmdd = date.toISOString().slice(2, 10).replace(/-/g, '')
  const base = `${yymmdd}-${slugify(feature)}`
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  return id
}

function names(dir: string, strip = ''): string[] {
  try {
    return readdirSync(dir).map((f) => (strip && f.endsWith(strip) ? f.slice(0, -strip.length) : f))
  } catch {
    return []
  }
}

/** Ids already used by local job folders, remote factory branches and requirement docs. */
export async function takenIds(repo: string, exec: Exec): Promise<Set<string>> {
  const ids = new Set<string>(names(jobPaths(repo, '').jobsDir))
  for (const n of names(join(repo, 'docs', 'requirements'), '.md')) ids.add(n)
  const r = await exec.run(['git', 'ls-remote', '--heads', 'origin', 'factory/*'], { cwd: repo })
  if (r.code === 0) {
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/refs\/heads\/factory\/(\S+)$/)
      if (m) ids.add(m[1])
    }
  }
  return ids
}
