import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tier } from './config'

export type NeutralTool = 'read' | 'grep' | 'glob' | 'bash' | 'edit' | 'write'

export interface Role {
  name: string
  description: string
  tools: NeutralTool[]
  browser: boolean
  tier: Tier
  include: string[]
  body: string
}

const TOOLS: readonly string[] = ['read', 'grep', 'glob', 'bash', 'edit', 'write']
const TIERS: readonly string[] = ['high', 'medium', 'low']
const KEYS = ['name', 'description', 'tools', 'browser', 'tier', 'include']

function trimBlankLines(s: string): string {
  const lines = s.split('\n')
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end).join('\n')
}

function list(v: string, file: string, key: string): string[] {
  if (!v.startsWith('[') || !v.endsWith(']')) throw new Error(`${file}: "${key}" must be an inline list like [a, b]`)
  return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
}

export function parseRole(text: string, file: string): Role {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/)
  if (!m) throw new Error(`${file}: missing frontmatter`)
  const raw: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 0) throw new Error(`${file}: bad frontmatter line "${line}"`)
    const key = line.slice(0, i).trim()
    if (!KEYS.includes(key)) throw new Error(`${file}: unknown frontmatter key "${key}"`)
    raw[key] = line.slice(i + 1).trim()
  }
  for (const k of ['name', 'description', 'tier']) {
    if (!raw[k]) throw new Error(`${file}: missing "${k}"`)
  }
  if (!TIERS.includes(raw.tier)) throw new Error(`${file}: invalid tier "${raw.tier}" (high, medium, low)`)
  const tools = raw.tools === undefined ? [] : list(raw.tools, file, 'tools')
  for (const t of tools) if (!TOOLS.includes(t)) throw new Error(`${file}: unknown tool "${t}"`)
  const flag = (k: string): boolean => {
    const v = raw[k]
    if (v === undefined || v === 'false') return false
    if (v === 'true') return true
    throw new Error(`${file}: "${k}" must be true or false`)
  }
  return {
    name: raw.name,
    description: raw.description,
    tools: tools as NeutralTool[],
    browser: flag('browser'),
    tier: raw.tier as Tier,
    include: raw.include === undefined ? ['_common'] : list(raw.include, file, 'include'),
    body: trimBlankLines(m[2] ?? ''),
  }
}

export function loadRole(rolesDir: string, name: string): Role {
  const file = join(rolesDir, `${name}.md`)
  const role = parseRole(readFileSync(file, 'utf8'), file)
  const parts = role.include.map((inc) => {
    const f = join(rolesDir, `${inc}.md`)
    if (!existsSync(f)) throw new Error(`include file ${f} not found (role "${name}")`)
    return trimBlankLines(readFileSync(f, 'utf8'))
  })
  return { ...role, body: [...parts, role.body].join('\n\n') }
}
