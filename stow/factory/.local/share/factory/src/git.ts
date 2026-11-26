import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Exec, ExecResult } from './exec'

export class GitError extends Error {
  constructor(cmd: string[], r: ExecResult) {
    const first = r.stderr.split('\n').find((l) => l.trim()) ?? ''
    super(`${cmd.join(' ')} failed (exit ${r.code})${first ? `: ${first.trim()}` : ''}`)
    this.name = 'GitError'
  }
}

async function ok(exec: Exec, cmd: string[], cwd: string): Promise<ExecResult> {
  const r = await exec.run(cmd, { cwd })
  if (r.code !== 0) throw new GitError(cmd, r)
  return r
}

/** Destructive operations only ever touch the factory's own branches. */
function factoryOnly(op: string, branch: string): void {
  if (!branch.startsWith('factory/')) throw new Error(`refusing to ${op} "${branch}": not a factory/ branch`)
}

export class Git {
  constructor(private exec: Exec, private repo: string) {}

  private git(args: string[], cwd = this.repo) {
    return ok(this.exec, ['git', ...args], cwd)
  }

  async ensureExcluded(): Promise<void> {
    const out = (await this.git(['rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
    const file = resolve(this.repo, out)
    await mkdir(dirname(file), { recursive: true })
    const current = existsSync(file) ? await readFile(file, 'utf8') : ''
    if (current.split('\n').includes('/.factory/')) return
    if (!existsSync(file)) await writeFile(file, '')
    await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}/.factory/\n`)
  }

  async createWorktree(branch: string, path: string, base: string): Promise<void> {
    await this.git(['fetch', 'origin', base])
    await this.git(['worktree', 'add', '-b', branch, path, `origin/${base}`])
  }

  async commitPaths(cwd: string, paths: string[], message: string): Promise<boolean> {
    const existing = paths.filter((p) => existsSync(resolve(cwd, p)))
    if (existing.length === 0) return false
    await this.git(['add', '--', ...existing], cwd)
    const staged = await this.exec.run(['git', 'diff', '--cached', '--quiet'], { cwd })
    if (staged.code === 0) return false
    if (staged.code !== 1) throw new GitError(['git', 'diff', '--cached', '--quiet'], staged)
    await this.git(['commit', '-m', message], cwd)
    return true
  }

  async head(cwd: string): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'], cwd)).stdout.trim()
  }

  async push(cwd: string, branch: string, o: { force?: boolean } = {}): Promise<void> {
    factoryOnly('push', branch)
    await this.git(['push', ...(o.force ? ['--force-with-lease'] : []), '-u', 'origin', branch], cwd)
  }

  async rebase(cwd: string, base: string): Promise<'ok' | 'conflict'> {
    await this.git(['fetch', 'origin', base], cwd)
    const r = await this.exec.run(['git', 'rebase', `origin/${base}`], { cwd })
    if (r.code === 0) return 'ok'
    await this.exec.run(['git', 'rebase', '--abort'], { cwd })
    return 'conflict'
  }

  async removeWorktree(path: string): Promise<void> {
    await this.git(['worktree', 'remove', '--force', path])
  }

  async deleteBranch(branch: string): Promise<void> {
    factoryOnly('delete', branch)
    const local = await this.exec.run(['git', 'branch', '-D', branch], { cwd: this.repo })
    if (local.code !== 0 && !/not found/i.test(local.stderr)) {
      throw new GitError(['git', 'branch', '-D', branch], local)
    }
    const remote = await this.exec.run(['git', 'push', 'origin', '--delete', branch], { cwd: this.repo })
    if (remote.code !== 0 && !/remote ref does not exist|not found/i.test(remote.stderr)) {
      throw new GitError(['git', 'push', 'origin', '--delete', branch], remote)
    }
  }

  async remoteFactoryBranches(): Promise<string[]> {
    const r = await this.git(['ls-remote', '--heads', 'origin', 'refs/heads/factory/*'])
    return r.stdout
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
      .filter((b): b is string => !!b)
  }
}

export interface PrComment {
  author: string
  body: string
  path: string | null
  line: number | null
  createdAt: string
}

/** `gh api --paginate` prints one JSON array per page back to back. */
function parseConcatenatedArrays(text: string): any[] {
  const out: any[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[') {
      if (depth++ === 0) start = i
    } else if (c === ']' && --depth === 0) out.push(...JSON.parse(text.slice(start, i + 1)))
  }
  return out
}

export class GitHub {
  constructor(private exec: Exec, private repo: string) {}

  private gh(args: string[]) {
    return ok(this.exec, ['gh', ...args], this.repo)
  }

  async preflight(): Promise<void> {
    const auth = await this.exec.run(['gh', 'auth', 'status'], { cwd: this.repo })
    if (auth.code !== 0) throw new Error('gh is not logged in (run: gh auth login)')
    const origin = await this.exec.run(['git', 'remote', 'get-url', 'origin'], { cwd: this.repo })
    if (origin.code !== 0) throw new Error('no origin remote')
  }

  async findPr(branch: string): Promise<string | null> {
    const r = await this.gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'])
    const list = JSON.parse(r.stdout || '[]') as { url: string }[]
    return list[0]?.url ?? null
  }

  async createDraftPr(o: { branch: string; base: string; title: string; bodyFile: string }): Promise<string> {
    const r = await this.gh([
      'pr', 'create', '--draft', '--assignee', '@me', '--head', o.branch, '--base', o.base,
      '--title', o.title, '--body-file', o.bodyFile,
    ])
    const lines = r.stdout.split('\n').filter((l) => l.trim())
    return lines[lines.length - 1].trim()
  }

  async viewBody(pr: string): Promise<string> {
    return (await this.gh(['pr', 'view', pr, '--json', 'body', '-q', '.body'])).stdout
  }

  async editBody(pr: string, bodyFile: string): Promise<void> {
    await this.gh(['pr', 'edit', pr, '--body-file', bodyFile])
  }

  async editTitle(pr: string, title: string): Promise<void> {
    await this.gh(['pr', 'edit', pr, '--title', title])
  }

  async ready(pr: string): Promise<void> {
    await this.gh(['pr', 'ready', pr])
  }

  async toDraft(pr: string): Promise<void> {
    await this.gh(['pr', 'ready', pr, '--undo'])
  }

  async close(pr: string): Promise<void> {
    await this.gh(['pr', 'close', pr, '--delete-branch'])
  }

  async commentsSince(pr: string, sinceIso: string | null): Promise<PrComment[]> {
    const number = pr.match(/\/pull\/(\d+)/)?.[1]
    if (!number) throw new Error(`not a pull request URL: ${pr}`)
    const view = JSON.parse((await this.gh(['pr', 'view', pr, '--json', 'comments,reviews'])).stdout || '{}')
    const inline = parseConcatenatedArrays(
      (await this.gh(['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'])).stdout,
    )
    const all: PrComment[] = [
      ...(view.comments ?? []).map((c: any) => ({
        author: c.author?.login ?? '', body: c.body ?? '', path: null, line: null, createdAt: c.createdAt,
      })),
      ...(view.reviews ?? []).map((c: any) => ({
        author: c.author?.login ?? '', body: c.body ?? '', path: null, line: null, createdAt: c.submittedAt,
      })),
      ...inline.map((c: any) => ({
        author: c.user?.login ?? '', body: c.body ?? '', path: c.path ?? null, line: c.line ?? null,
        createdAt: c.created_at,
      })),
    ]
    return all
      .filter((c) => c.body.trim() && c.createdAt && (sinceIso === null || c.createdAt > sinceIso))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  async nameWithOwner(): Promise<string> {
    return (await this.gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).stdout.trim()
  }
}
