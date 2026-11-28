import { dirname, join } from 'node:path'
import type { Exec } from './exec'

export const PACKAGE_DIR: string = join(import.meta.dir, '..')
export const CLI_PATH: string = join(PACKAGE_DIR, 'src', 'cli.ts')

/** Main checkout of the repo containing `cwd`, and whether `cwd` is in a linked worktree of it. */
export async function findRepo(cwd: string, exec: Exec): Promise<{ repo: string; linked: boolean }> {
  const r = await exec.run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd })
  if (r.code !== 0) throw new Error('not inside a git repository')
  const [gitDir, commonDir] = r.stdout.trim().split('\n')
  return { repo: dirname(commonDir!), linked: gitDir !== commonDir }
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
  /** The grill's transcript and pending question. */
  grillDir: string
  proofDir: string
  prFile: string
  /** A report job's deliverable. */
  reportFile: string
  /** The access check's results. */
  accessFile: string
  worktree: string
  tripDir(t: number): string
  discoveryReview(n: number): string
  feedback(k: number): string
  decision(k: number): string
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
    grillDir: join(jobDir, 'grill'),
    proofDir: join(jobDir, 'proof'),
    prFile: join(jobDir, 'pr.md'),
    reportFile: join(jobDir, 'report.md'),
    accessFile: join(jobDir, 'access.md'),
    worktree: join(factoryDir, id),
    tripDir: (t) => join(jobDir, `trip-${t}`),
    discoveryReview: (n) => join(jobDir, `discovery-review-${n}.md`),
    feedback: (k) => join(jobDir, `feedback-${k}.md`),
    decision: (k) => join(jobDir, `decision-${k}.md`),
  }
}
