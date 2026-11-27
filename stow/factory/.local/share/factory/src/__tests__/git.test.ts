import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realExec } from '../exec'
import { Git, GitHub } from '../git'
import { FakeExec, tempRepo } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const t = await tempRepo()
  cleanups.push(t.cleanup)
  return { ...t, git: new Git(realExec, t.repo) }
}

const sh = async (cwd: string, ...args: string[]) => {
  const r = await realExec.run(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('Git', () => {
  test('commitPaths returns false when nothing changed', async () => {
    const { repo, git } = await setup()
    expect(await git.commitPaths(repo, ['missing.md'], 'nothing')).toBe(false)
  })

  test('commitPaths commits changed paths', async () => {
    const { repo, git } = await setup()
    await writeFile(join(repo, 'a.md'), 'a')
    expect(await git.commitPaths(repo, ['a.md'], 'add a')).toBe(true)
    expect(await sh(repo, 'log', '-1', '--format=%s')).toBe('add a')
    expect(await git.head(repo)).toBe(await sh(repo, 'rev-parse', 'HEAD'))
  })

  test('createWorktree + push lands the branch on origin', async () => {
    const { repo, origin, git } = await setup()
    const wt = join(repo, '.factory', 'j1')
    await git.createWorktree('factory/j1', wt, 'main')
    await writeFile(join(wt, 'f.txt'), 'x')
    expect(await git.commitPaths(wt, ['f.txt'], 'add f')).toBe(true)
    await git.push(wt, 'factory/j1')
    expect(await sh(origin, 'branch', '--list', 'factory/j1')).toContain('factory/j1')
    expect(await git.remoteFactoryBranches()).toEqual(['factory/j1'])
    await git.push(wt, 'factory/j1', { force: true })
    await git.removeWorktree(wt)
    expect(existsSync(wt)).toBe(false)
    await git.deleteBranch('factory/j1')
    expect(await git.remoteFactoryBranches()).toEqual([])
    await git.deleteBranch('factory/j1') // tolerates missing
  })

  test('rebase reports conflict and leaves no rebase in progress', async () => {
    const { repo, git } = await setup()
    const wt = join(repo, '.factory', 'j2')
    await git.createWorktree('factory/j2', wt, 'main')
    await writeFile(join(wt, 'c.txt'), 'branch')
    await git.commitPaths(wt, ['c.txt'], 'branch change')
    await writeFile(join(repo, 'c.txt'), 'main')
    await git.commitPaths(repo, ['c.txt'], 'main change')
    await sh(repo, 'push', 'origin', 'main')
    expect(await git.rebase(wt, 'main')).toBe('conflict')
    const gitDir = await sh(wt, 'rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false)
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false)
  })

  test('rebase returns ok on a clean rebase', async () => {
    const { repo, git } = await setup()
    const wt = join(repo, '.factory', 'j3')
    await git.createWorktree('factory/j3', wt, 'main')
    await writeFile(join(repo, 'm.txt'), 'main')
    await git.commitPaths(repo, ['m.txt'], 'main change')
    await sh(repo, 'push', 'origin', 'main')
    expect(await git.rebase(wt, 'main')).toBe('ok')
  })

  test('ensureExcluded is idempotent', async () => {
    const { repo, git } = await setup()
    await git.ensureExcluded()
    await git.ensureExcluded()
    const file = join(repo, '.git', 'info', 'exclude')
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l === '/.factory/')
    expect(lines).toHaveLength(1)
  })

  test('failures carry the command and first stderr line', async () => {
    const { repo, git } = await setup()
    await expect(git.createWorktree('b', join(repo, 'w'), 'nope')).rejects.toThrow(/git fetch origin nope/)
  })

  test('push and deleteBranch refuse anything but factory/ and factory-proof/ branches', async () => {
    const exec = new FakeExec()
    const git = new Git(exec, '/r')
    const not = 'not a factory/ or factory-proof/ branch'
    for (const branch of ['main', 'master', 'develop', 'feature/factory/x', 'factory', 'factory-proof', 'factory-proofs/x', 'factory-x/y']) {
      await expect(git.push('/w', branch)).rejects.toThrow(`refusing to push "${branch}": ${not}`)
      await expect(git.push('/w', branch, { force: true })).rejects.toThrow(not)
      await expect(git.deleteBranch(branch)).rejects.toThrow(`refusing to delete "${branch}": ${not}`)
    }
    expect(exec.calls).toEqual([])
    await git.deleteBranch('factory-proof/j')
    expect(exec.calls).toEqual([
      ['git', 'branch', '-D', 'factory-proof/j'],
      ['git', 'push', 'origin', '--delete', 'factory-proof/j'],
    ])
  })

  test('forced push uses --force-with-lease, never --force', async () => {
    const exec = new FakeExec()
    const git = new Git(exec, '/r')
    await git.push('/w', 'factory/j', { force: true })
    await git.push('/w', 'factory/j')
    expect(exec.calls).toEqual([
      ['git', 'push', '--force-with-lease', '-u', 'origin', 'factory/j'],
      ['git', 'push', '-u', 'origin', 'factory/j'],
    ])
  })
})

describe('GitHub', () => {
  test('createDraftPr passes --draft and --assignee @me and returns the URL from stdout', async () => {
    const exec = new FakeExec([
      { match: ['gh', 'pr', 'create'], result: { stdout: 'Creating draft...\nhttps://github.com/o/r/pull/7\n\n' } },
    ])
    const url = await new GitHub(exec, '/r').createDraftPr({ branch: 'factory/j', base: 'main', title: 'T', bodyFile: '/b.md' })
    expect(url).toBe('https://github.com/o/r/pull/7')
    expect(exec.calls[0]).toEqual([
      'gh', 'pr', 'create', '--draft', '--assignee', '@me', '--head', 'factory/j', '--base', 'main',
      '--title', 'T', '--body-file', '/b.md',
    ])
  })

  test('preflight maps gh auth failure to the login hint', async () => {
    const exec = new FakeExec([{ match: ['gh', 'auth', 'status'], result: { code: 1 } }])
    await expect(new GitHub(exec, '/r').preflight()).rejects.toThrow('gh is not logged in (run: gh auth login)')
  })

  test('preflight reports a missing origin', async () => {
    const exec = new FakeExec([{ match: ['git', 'remote', 'get-url'], result: { code: 2 } }])
    await expect(new GitHub(exec, '/r').preflight()).rejects.toThrow('no origin remote')
  })

  test('findPr returns first open PR url or null', async () => {
    const hit = new FakeExec([{ match: ['gh', 'pr', 'list'], result: { stdout: '[{"url":"https://x/pull/1"}]' } }])
    expect(await new GitHub(hit, '/r').findPr('b')).toBe('https://x/pull/1')
    expect(hit.calls[0]).toContain('open')
    const none = new FakeExec([{ match: ['gh', 'pr', 'list'], result: { stdout: '[]' } }])
    expect(await new GitHub(none, '/r').findPr('b')).toBeNull()
  })

  test('commentsSince filters by createdAt and merges the three sources', async () => {
    const exec = new FakeExec([
      {
        match: ['gh', 'pr', 'view'],
        result: {
          stdout: JSON.stringify({
            comments: [
              { author: { login: 'a' }, body: 'old', createdAt: '2026-01-01T00:00:00Z' },
              { author: { login: 'a' }, body: 'issue', createdAt: '2026-01-03T00:00:00Z' },
            ],
            reviews: [
              { author: { login: 'b' }, body: 'review', submittedAt: '2026-01-02T00:00:00Z' },
              { author: { login: 'b' }, body: '', submittedAt: '2026-01-04T00:00:00Z' },
            ],
          }),
        },
      },
      {
        match: ['gh', 'api'],
        result: {
          stdout: JSON.stringify([
            { user: { login: 'c' }, body: 'inline', path: 'x.ts', line: 5, created_at: '2026-01-05T00:00:00Z' },
            { user: { login: 'c' }, body: 'older', path: 'x.ts', line: null, created_at: '2025-12-01T00:00:00Z' },
          ]),
        },
      },
    ])
    const got = await new GitHub(exec, '/r').commentsSince('https://github.com/o/r/pull/9', '2026-01-01T12:00:00Z')
    expect(got.map((c) => [c.author, c.body, c.path, c.line])).toEqual([
      ['b', 'review', null, null],
      ['a', 'issue', null, null],
      ['c', 'inline', 'x.ts', 5],
    ])
    expect(exec.calls.find((c) => c[1] === 'api')).toEqual([
      'gh', 'api', 'repos/{owner}/{repo}/pulls/9/comments', '--paginate',
    ])
    const all = await new GitHub(exec, '/r').commentsSince('https://github.com/o/r/pull/9', null)
    expect(all).toHaveLength(5)
  })

  test('commentsSince skips bots: a [bot] login, or a user of type Bot', async () => {
    const at = '2026-01-02T00:00:00Z'
    const exec = new FakeExec([
      {
        match: ['gh', 'pr', 'view'],
        result: {
          stdout: JSON.stringify({
            comments: [
              { author: { login: 'github-actions[bot]' }, body: 'CI passed', createdAt: at },
              { author: { login: 'alice' }, body: 'human', createdAt: at },
            ],
            reviews: [{ author: { login: 'coderabbitai[bot]' }, body: 'LGTM', submittedAt: at }],
          }),
        },
      },
      {
        match: ['gh', 'api'],
        result: {
          stdout: JSON.stringify([
            { user: { login: 'linter', type: 'Bot' }, body: 'style', path: 'x.ts', line: 1, created_at: at },
            { user: { login: 'bob', type: 'User' }, body: 'nit', path: 'x.ts', line: 2, created_at: at },
          ]),
        },
      },
    ])
    const got = await new GitHub(exec, '/r').commentsSince('https://github.com/o/r/pull/9', null)
    expect(got.map((c) => c.author)).toEqual(['alice', 'bob'])
  })

  test('simple wrappers build the expected argv', async () => {
    const exec = new FakeExec([
      { match: ['gh', 'repo', 'view'], result: { stdout: 'o/r\n' } },
      { match: ['gh', 'pr', 'view'], result: { stdout: 'body text' } },
    ])
    const gh = new GitHub(exec, '/r')
    expect(await gh.nameWithOwner()).toBe('o/r')
    expect(await gh.viewBody('u')).toBe('body text')
    await gh.editBody('u', '/b.md')
    await gh.editTitle('u', 'T')
    await gh.ready('u')
    await gh.toDraft('u')
    await gh.close('u')
    expect(exec.calls.slice(2)).toEqual([
      ['gh', 'pr', 'edit', 'u', '--body-file', '/b.md'],
      ['gh', 'pr', 'edit', 'u', '--title', 'T'],
      ['gh', 'pr', 'ready', 'u'],
      ['gh', 'pr', 'ready', 'u', '--undo'],
      ['gh', 'pr', 'close', 'u', '--delete-branch'],
    ])
  })
})
