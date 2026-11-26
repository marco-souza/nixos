import { afterEach, describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../exec'
import { FakeExec } from './helpers'
import { notify } from '../notify'

const n = { title: 'Job "x"', message: 'say "hi" \\ now' }
const savedTmux = process.env.TMUX
afterEach(() => {
  if (savedTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = savedTmux
})

describe('notify', () => {
  test('darwin: osascript with escaped quotes and backslashes', async () => {
    delete process.env.TMUX
    const exec = new FakeExec()
    await notify(n, exec, 'darwin', () => true)
    expect(exec.calls).toEqual([
      ['osascript', '-e', 'display notification "say \\"hi\\" \\\\ now" with title "Job \\"x\\""'],
    ])
  })

  test('linux: notify-send', async () => {
    delete process.env.TMUX
    const exec = new FakeExec()
    await notify(n, exec, 'linux', () => true)
    expect(exec.calls).toEqual([['notify-send', n.title, n.message]])
  })

  test('tmux display-message when TMUX is set', async () => {
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    const exec = new FakeExec()
    await notify(n, exec, 'linux', () => true)
    expect(exec.calls[1].slice(0, 2)).toEqual(['tmux', 'display-message'])
    expect(exec.calls[1].join(' ')).toContain(n.message)
  })

  test('bell written to stderr', async () => {
    delete process.env.TMUX
    const writes: string[] = []
    await notify(n, new FakeExec(), 'linux', (s) => (writes.push(s), true))
    expect(writes).toEqual(['\x07'])
  })

  test('swallows a throwing exec and still rings the bell', async () => {
    process.env.TMUX = '1'
    const boom: Exec = {
      async run(): Promise<ExecResult> {
        throw new Error('no such binary')
      },
    }
    const writes: string[] = []
    await notify(n, boom, 'darwin', (s) => (writes.push(s), true))
    expect(writes).toEqual(['\x07'])
  })

  test('other platforms still bell', async () => {
    delete process.env.TMUX
    const exec = new FakeExec()
    const writes: string[] = []
    await notify(n, exec, 'win32', (s) => (writes.push(s), true))
    expect(exec.calls).toHaveLength(0)
    expect(writes).toEqual(['\x07'])
  })
})
