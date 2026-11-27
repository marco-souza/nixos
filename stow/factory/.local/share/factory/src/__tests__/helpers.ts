import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realExec, type Exec, type ExecResult } from '../exec'

export class FakeExec implements Exec {
  calls: string[][] = []
  constructor(private rules: { match: string[]; result: Partial<ExecResult> }[] = []) {}

  async run(cmd: string[]): Promise<ExecResult> {
    this.calls.push(cmd)
    const rule = this.rules.find((r) => r.match.every((m, i) => cmd[i] === m))
    return { code: 0, stdout: '', stderr: '', ...rule?.result }
  }
}

/** Git repo with one commit on `main` and a bare `origin` it was pushed to. */
export async function tempRepo(): Promise<{ repo: string; origin: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-test-')))
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realExec.run(['git', ...args], { cwd })
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  await git(root, 'init', '--bare', '-b', 'main', origin)
  await git(root, 'init', '-b', 'main', repo)
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await git(repo, 'commit', '--allow-empty', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'push', '-u', 'origin', 'main')
  return { repo, origin, cleanup: () => rm(root, { recursive: true, force: true }) }
}
