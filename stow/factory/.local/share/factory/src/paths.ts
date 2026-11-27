import { dirname, join } from 'node:path'
import type { Exec } from './exec'

export const PACKAGE_DIR: string = join(import.meta.dir, '..')
export const CLI_PATH: string = join(PACKAGE_DIR, 'src', 'cli.ts')

/** Main checkout of the repo containing `cwd`, also when `cwd` is a linked worktree. */
export async function findRepo(cwd: string, exec: Exec): Promise<string> {
  const r = await exec.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  if (r.code !== 0) throw new Error('not inside a git repository')
  return dirname(r.stdout.trim())
}

export interface JobPaths {
  factoryDir: string
  jobsDir: string
  jobDir: string
  jobFile: string
  activityLog: string
  logsDir: string
  doneDir: string
  runDir: string
  proofDir: string
  prFile: string
  worktree: string
  tripDir(t: number): string
  discoveryReview(n: number): string
  feedback(k: number): string
}

export function jobPaths(repo: string, id: string): JobPaths {
  const factoryDir = join(repo, '.factory')
  const jobsDir = join(factoryDir, 'jobs')
  const jobDir = join(jobsDir, id)
  return {
    factoryDir,
    jobsDir,
    jobDir,
    jobFile: join(jobDir, 'job.json'),
    activityLog: join(jobDir, 'activity.log'),
    logsDir: join(jobDir, 'logs'),
    doneDir: join(jobDir, 'done'),
    runDir: join(jobDir, 'run'),
    proofDir: join(jobDir, 'proof'),
    prFile: join(jobDir, 'pr.md'),
    worktree: join(factoryDir, id),
    tripDir: (t) => join(jobDir, `trip-${t}`),
    discoveryReview: (n) => join(jobDir, `discovery-review-${n}.md`),
    feedback: (k) => join(jobDir, `feedback-${k}.md`),
  }
}
