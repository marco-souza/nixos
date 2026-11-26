import type { Harness } from './config'

const ESC = '\x1b['

/** ANSI only on a TTY without NO_COLOR; FORCE_COLOR turns it on regardless. */
export function useColor(): boolean {
  const force = process.env.FORCE_COLOR
  if (force !== undefined && force !== '' && force !== '0') return true
  if (process.env.NO_COLOR !== undefined) return false
  return Boolean(process.stdout.isTTY)
}

type Style = 'dim' | 'red' | 'green'
const CODES: Record<Style, string> = { dim: '2', red: '31', green: '32' }

function paint(style: Style, text: string): string {
  return useColor() ? `${ESC}${CODES[style]}m${text}${ESC}0m` : text
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Drop C0 controls (except \n, \t) and DEL so agent output can't drive the terminal. */
function clean(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function wrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      const out: string[] = []
      let cur = ''
      for (const word of line.split(' ')) {
        if (cur !== '' && cur.length + 1 + word.length > width) {
          out.push(cur)
          cur = word
        } else {
          cur = cur === '' && out.length === 0 ? word : `${cur} ${word}`
        }
      }
      out.push(cur)
      return out.join('\n')
    })
    .join('\n')
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

const ARG_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'prompt', 'description']

function firstArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of ARG_KEYS) {
    if (typeof obj[key] === 'string' && obj[key] !== '') return firstLine(clean(obj[key] as string))
  }
  const any = Object.values(obj).find((v) => typeof v === 'string' && v !== '')
  return typeof any === 'string' ? firstLine(clean(any)) : ''
}

function toolLine(name: string, input: unknown, width: number): string {
  const arg = firstArg(input)
  const head = `▸ ${clean(name)}`
  const room = width - head.length - 2
  const shown = arg === '' ? '' : `  ${truncate(arg, Math.max(1, room))}`
  return `${paint('dim', head)}${shown}`
}

function errorLine(tool: string, body: unknown, width: number): string {
  return paint('red', truncate(`✗ ${clean(tool)}: ${firstLine(clean(blockText(body)))}`, width))
}

/** Text of a tool result: a string, or an array of `{type:'text', text}` blocks. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : '')).join('\n')
  }
  return ''
}

function claudeEvent(ev: any, width: number, toolNames: Map<string, string>): string | null {
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const parts: string[] = []
    for (const block of ev.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(wrap(clean(block.text).trim(), width))
      } else if (block?.type === 'tool_use') {
        if (typeof block.id === 'string') toolNames.set(block.id, String(block.name))
        parts.push(toolLine(String(block.name), block.input, width))
      }
    }
    return parts.length ? parts.join('\n') : null
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const parts: string[] = []
    for (const block of ev.message.content) {
      if (block?.type === 'tool_result' && block.is_error === true) {
        parts.push(errorLine(toolNames.get(block.tool_use_id) ?? 'tool', block.content, width))
      }
      if (block?.type === 'tool_result') toolNames.delete(block.tool_use_id)
    }
    return parts.length ? parts.join('\n') : null
  }
  if (ev.type === 'result') {
    if (ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== 'success')) {
      const why =
        ev.subtype === 'success' || ev.subtype === undefined
          ? firstLine(clean(typeof ev.result === 'string' ? ev.result : '')) || 'error'
          : ev.subtype
      return paint('red', `✗ failed: ${why}`)
    }
    const bits = ['done']
    if (typeof ev.duration_ms === 'number') bits[0] = `done in ${formatDuration(ev.duration_ms)}`
    let line = `✓ ${bits[0]}`
    if (typeof ev.total_cost_usd === 'number') line += ` · $${ev.total_cost_usd.toFixed(2)}`
    return paint('green', line)
  }
  return null
}

function piEvent(ev: any, width: number): string | null {
  if (ev.type === 'message_end' && ev.message?.role === 'assistant' && Array.isArray(ev.message.content)) {
    const texts = ev.message.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
      .map((b: any) => wrap(clean(b.text).trim(), width))
    return texts.length ? texts.join('\n') : null
  }
  if (ev.type === 'tool_execution_start') return toolLine(String(ev.toolName), ev.args, width)
  if (ev.type === 'tool_execution_end' && ev.isError === true) {
    return errorLine(String(ev.toolName), ev.result?.content, width)
  }
  if (ev.type === 'auto_retry_end' && ev.success === false) {
    return paint('red', `✗ failed: ${clean(String(ev.finalError ?? 'retry'))}`)
  }
  if (ev.type === 'agent_settled') {
    return ev.aborted ? paint('red', '✗ failed: aborted') : paint('green', '✓ done')
  }
  return null
}

/**
 * Formatter for one stream. Holds the tool_use id -> name map, so a later
 * is_error tool_result can say which tool failed; entries go when the result arrives.
 */
export function createFormatter(
  format: Harness,
  width: number = process.stdout.columns ?? 120,
): (line: string) => string | null {
  const toolNames = new Map<string, string>()
  return (line) => {
    if (line.trim() === '') return null
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      return clean(line)
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return clean(line)
    return format === 'claude' ? claudeEvent(ev, width, toolNames) : piEvent(ev, width)
  }
}

/** Stateless: one line on its own, so an error result can't name its tool. */
export function formatEvent(line: string, format: Harness, width?: number): string | null {
  return createFormatter(format, width)(line)
}

/** stdin -> stdout, one formatted event per line. */
export async function runTail(format: Harness): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ''
  const fmt = createFormatter(format)
  const emit = (line: string) => {
    const out = fmt(line.replace(/\r$/, ''))
    if (out !== null) process.stdout.write(`${out}\n`)
  }
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      emit(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  if (buf !== '') emit(buf)
}
