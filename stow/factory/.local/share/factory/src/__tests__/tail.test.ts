import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { formatDuration, formatEvent } from '../tail'

const fixture = async (name: string) =>
  (await Bun.file(join(import.meta.dir, 'fixtures/stream', name)).text()).split('\n').filter(Boolean)

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
beforeEach(() => {
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** Format every fixture line in order (formatEvent tracks tool names across lines). */
async function render(name: string, format: 'claude' | 'pi', width = 120) {
  return (await fixture(name)).map((l) => formatEvent(l, format, width))
}

describe('claude stream', () => {
  test('init and other system events are skipped', async () => {
    expect((await render('claude.jsonl', 'claude'))[0]).toBeNull()
    expect(formatEvent('{"type":"system","subtype":"hook_started"}', 'claude')).toBeNull()
    expect(formatEvent('{"type":"rate_limit_event"}', 'claude')).toBeNull()
  })

  test('assistant text is shown, wrapped to width', async () => {
    const out = (await render('claude.jsonl', 'claude', 40)).filter((l) => l?.startsWith('Files in'))[0]!
    expect(out).toContain('Files in the working directory')
    for (const l of out.split('\n')) expect(l.length).toBeLessThanOrEqual(40)
  })

  test('tool call is one line with the first arg, truncated with an ellipsis', async () => {
    const out = (await render('claude.jsonl', 'claude'))[1]!
    expect(out).toStartWith('▸ Bash  ls -la ')
    expect(out).not.toContain('\n')
    const long = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo ' + 'a'.repeat(200) } }] },
    })
    const cut = formatEvent(long, 'claude', 30)!
    expect(cut.length).toBe(30)
    expect(cut).toEndWith('…')
  })

  test('successful tool results are skipped; errors show the tool and first line in red', async () => {
    const lines = await render('claude.jsonl', 'claude')
    expect(lines[2]).toBeNull()
    expect(lines[7]).toBe('✗ Read: File does not exist.')
    process.env.FORCE_COLOR = '1'
    delete process.env.NO_COLOR
    const colored = (await fixture('claude.jsonl')).map((l) => formatEvent(l, 'claude', 120))
    expect(colored[7]).toBe('\x1b[31m✗ Read: File does not exist.\x1b[0m')
  })

  test('result: done with duration and cost, or failed with the subtype', async () => {
    const lines = await render('claude.jsonl', 'claude')
    expect(lines[8]).toBe('✓ done in 3m12s · $0.42')
    expect(lines[9]).toBe('✗ failed: error_max_turns')
    expect(formatEvent('{"type":"result","subtype":"success","duration_ms":45000}', 'claude')).toBe('✓ done in 45s')
  })

  test('non-JSON lines pass through, blank lines and unknown JSON are skipped', () => {
    expect(formatEvent('npm warn something', 'claude')).toBe('npm warn something')
    expect(formatEvent('42', 'claude')).toBe('42')
    expect(formatEvent('', 'claude')).toBeNull()
    expect(formatEvent('{"type":"mystery"}', 'claude')).toBeNull()
  })

  test('NO_COLOR output has no escape codes', async () => {
    for (const l of await render('claude.jsonl', 'claude')) expect(l ?? '').not.toContain('\x1b[')
  })
})

describe('pi stream', () => {
  test('session header, deltas and turn bookkeeping are skipped', async () => {
    const lines = await render('pi.jsonl', 'pi')
    for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(lines[i]).toBeNull()
  })

  test('assistant text comes from message_end; tool calls from tool_execution_start', async () => {
    const lines = await render('pi.jsonl', 'pi')
    expect(lines[7]).toBe("I'll list the files.")
    expect(lines[8]).toBe('▸ bash  ls -la')
    expect(lines[9]).toBeNull()
  })

  test('tool errors are red with the first line', async () => {
    const lines = await render('pi.jsonl', 'pi')
    expect(lines[12]).toBe('▸ read  missing.txt')
    expect(lines[13]).toBe('✗ read: ENOENT: no such file')
  })

  test('agent_settled is the final result', async () => {
    const lines = await render('pi.jsonl', 'pi')
    expect(lines.at(-1)).toBe('✓ done')
    expect(formatEvent('{"type":"agent_settled","aborted":true}', 'pi')).toBe('✗ failed: aborted')
  })

  test('colors on when forced', () => {
    process.env.FORCE_COLOR = '1'
    delete process.env.NO_COLOR
    expect(formatEvent('{"type":"agent_settled","aborted":false}', 'pi')).toBe('\x1b[32m✓ done\x1b[0m')
  })
})

test('formatDuration', () => {
  expect(formatDuration(45_000)).toBe('45s')
  expect(formatDuration(192_000)).toBe('3m12s')
  expect(formatDuration(3_720_000)).toBe('1h02m')
})

test('runTail formats stdin to stdout', async () => {
  const input = (await fixture('claude.jsonl')).join('\n') + '\nplain line'
  const script = `import { runTail } from ${JSON.stringify(join(import.meta.dir, '../tail'))}; await runTail('claude')`
  const proc = Bun.spawn(['bun', '-e', script], {
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  expect(out).toContain('▸ Bash  ls -la')
  expect(out).toContain('✓ done in 3m12s · $0.42')
  expect(out).toEndWith('plain line\n')
})
