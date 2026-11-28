import { join } from 'node:path'
import type { FactoryConfig, Harness, Tier } from './config'
import type { Job } from './job'
import { PACKAGE_DIR, type JobPaths } from './paths'
import type { NeutralTool, Role } from './roles'
import { shq } from './shell'

export class HarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}

/**
 * The Playwright MCP server browser roles get, on top of the user's own. `--isolated`: browser roles that run side by
 * side in one worktree would otherwise share, and fight over, one persistent browser profile.
 */
export const PLAYWRIGHT_MCP_CONFIG: string = join(PACKAGE_DIR, 'mcp', 'playwright.json')

const PW = 'mcp__playwright__browser_'
/** builder-frontend's tools, then the two extra ones reviewer-ui uses. */
export const PLAYWRIGHT_TOOLS: string[] = [
  'navigate', 'snapshot', 'take_screenshot', 'resize', 'click', 'type', 'press_key', 'wait_for',
  'console_messages', 'close', 'hover', 'emulate_media',
].map((t) => PW + t)

const HARNESSES: readonly string[] = ['claude', 'pi']
const TIERS: readonly string[] = ['high', 'medium', 'low']

export function resolveHarness(
  role: Role,
  cfg: FactoryConfig,
): { harness: Harness; model: string | null; timeoutMin: number } {
  const o = cfg.roles[role.name] ?? {}
  // Browser roles need the Playwright MCP server, which only claude gets.
  const harness = role.browser ? 'claude' : o.harness ?? cfg.defaultHarness
  if (!HARNESSES.includes(harness)) throw new HarnessError(`role ${role.name}: unknown harness "${harness}" (claude, pi)`)
  const tier = o.tier ?? role.tier
  if (!TIERS.includes(tier)) throw new HarnessError(`role ${role.name}: unknown tier "${tier}" (high, medium, low)`)
  const model = (cfg.models[harness] as Partial<Record<Tier, string>>)[tier] ?? null
  return { harness, model, timeoutMin: o.timeoutMin ?? cfg.timeoutsMin[tier] }
}

export interface TaskContext {
  job: Job
  paths: JobPaths
  cfg: FactoryConfig
  assignment: string
  output: string
  inputs: string[]
  target: string | null
}

export function renderTaskPrompt(ctx: TaskContext): string {
  const { job, paths, cfg } = ctx
  const d = cfg.docs
  const doc = (dir: string) => `${dir}/${job.id}.md`
  const lines = [
    `Job: ${job.id}`,
    `Request: ${job.feature}`,
    `Worktree: ${job.worktree} (your working directory)`,
    `Job folder: ${paths.jobDir}`,
    `Cycle: ${job.cycle}  Trip: ${job.trip}`,
    `Base: ${job.base}`,
    `Docs: requirements=${doc(d.requirements)}, tech-discovery=${doc(d.techDiscovery)}, design=${doc(d.design)}, spec=${doc(d.specs)}, test-plan=${doc(d.testPlans)}`,
    `Assignment: ${ctx.assignment}`,
    `Output: ${ctx.output}`,
  ]
  if (ctx.inputs.length) lines.push(`Inputs: ${ctx.inputs.join(', ')}`)
  if (ctx.target !== null) lines.push(`Target: ${ctx.target}`)
  return lines.join('\n')
}

const CLAUDE_TOOLS: Record<NeutralTool, string> = {
  read: 'Read', grep: 'Grep', glob: 'Glob', bash: 'Bash', edit: 'Edit', write: 'Write',
}
const PI_TOOLS: Record<NeutralTool, string[]> = {
  read: ['read'], grep: ['grep'], glob: ['find', 'ls'], bash: ['bash'], edit: ['edit'], write: ['write'],
}

/**
 * A bash command line. Prompt text is read from files, never interpolated. `jobDir` holds the role's inputs and
 * outputs, outside its working directory (the worktree).
 */
export function buildCommand(
  role: Role,
  h: { harness: Harness; model: string | null },
  files: { system: string; task: string },
  jobDir: string,
): string {
  const task = `"$(cat ${shq(files.task)})"`
  if (h.harness === 'claude') {
    const allowed = [...role.tools.map((t) => CLAUDE_TOOLS[t]), ...(role.browser ? PLAYWRIGHT_TOOLS : [])]
    const denied = (Object.keys(CLAUDE_TOOLS) as NeutralTool[])
      .filter((t) => !role.tools.includes(t))
      .map((t) => CLAUDE_TOOLS[t])
      .concat('Agent')
    return [
      'claude',
      '-p',
      task,
      '--append-system-prompt-file', shq(files.system),
      ...(h.model ? ['--model', shq(h.model)] : []),
      '--permission-mode', 'auto',
      // Variadic like --mcp-config: each must be followed by another option, never by the prompt.
      '--add-dir', shq(jobDir),
      // No --strict-mcp-config: agents get the user's MCP servers (tickets, Slack, docs). Auto mode gates risky calls.
      ...(role.browser ? ['--mcp-config', shq(PLAYWRIGHT_MCP_CONFIG)] : []),
      '--allowedTools', shq(allowed.join(',')),
      '--disallowedTools', shq(denied.join(',')),
      '--output-format', 'stream-json', '--verbose',
    ].join(' ')
  }
  const tools = role.tools.flatMap((t) => PI_TOOLS[t])
  return [
    'pi',
    '-p',
    '--append-system-prompt', shq(files.system),
    ...(h.model ? ['--model', shq(h.model)] : []),
    '--tools', shq(tools.join(',')),
    '--mode', 'json',
    task,
  ].join(' ')
}
