import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FactoryConfig } from './config'
import type { Exec } from './exec'
import { jobPaths } from './paths'

const STOPWORDS = new Set('a an the to of for and in on with into from by'.split(' '))

export function slugify(feature: string): string {
  const slug = feature
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 4)
    .join('-')
  return slug || 'job'
}

const BRANCH_PROMPT = `Name a git branch for the request below. Use the repo's branch naming convention if its instructions give one. \
Otherwise use <type>/<TICKET>/<brief-name>: <type> is the kind of change (feature, fix, chore, …); <TICKET> is the ticket key \
the request mentions, such as ABC-123, left out with its slash when there is none; <brief-name> is two to four lowercase words \
joined by hyphens. Reply with the branch name only.

Request: `

/** No dots: that rules out `..`, `.lock` and the other names git refuses. */
const BRANCH = /^\w[\w-]*(\/\w[\w-]*)*$/

/** A branch name for `feature`, from the default harness's low-tier model; `feature/<slug>` when that fails. */
export async function nameBranch(feature: string, cfg: FactoryConfig, exec: Exec, repo: string): Promise<string> {
  const model = cfg.models[cfg.defaultHarness]?.low
  const prompt = BRANCH_PROMPT + feature
  const cmd = cfg.defaultHarness === 'pi'
    ? ['pi', '-p', ...(model ? ['--model', model] : []), prompt]
    : ['claude', '-p', prompt, '--strict-mcp-config', ...(model ? ['--model', model] : [])]
  const r = await exec.run(cmd, { cwd: repo }).catch(() => null)
  const name = r?.code === 0 ? (r.stdout.trim().split('\n').at(-1) ?? '').replace(/`/g, '').trim() : ''
  return BRANCH.test(name) ? name : `feature/${slugify(feature)}`
}

/** The branch's last part, made safe for folder and tmux session names. */
export function jobIdFor(branch: string): string {
  return (branch.split('/').at(-1) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job'
}

function names(dir: string, strip = ''): string[] {
  try {
    return readdirSync(dir).map((f) => (strip && f.endsWith(strip) ? f.slice(0, -strip.length) : f))
  } catch {
    return []
  }
}

/** Ids already used by local job folders and requirement docs (`requirementsDir`, relative to `repo`). */
export function takenIds(repo: string, requirementsDir: string): Set<string> {
  return new Set([...names(jobPaths(repo, '').jobsDir), ...names(join(repo, requirementsDir), '.md')])
}
