import type { FactoryConfig, Harness, Tier } from './config'
import type { Job } from './job'
import type { JobPaths } from './paths'
import type { NeutralTool, Role } from './roles'
import { shq } from './shell'

export class HarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}

const PW = 'mcp__plugin_playwright_playwright__browser_'
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
  const harness = o.harness ?? cfg.defaultHarness
  if (!HARNESSES.includes(harness)) throw new HarnessError(`role ${role.name}: unknown harness "${harness}" (claude, pi)`)
  const tier = o.tier ?? role.tier
  if (!TIERS.includes(tier)) throw new HarnessError(`role ${role.name}: unknown tier "${tier}" (high, medium, low)`)
  if (role.browser && harness !== 'claude') throw new HarnessError(`role ${role.name} needs a browser; run it on claude`)
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
    `Base: ${cfg.base}`,
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

/** A bash command line. Prompt text is read from files, never interpolated. */
export function buildCommand(
  role: Role,
  h: { harness: Harness; model: string | null },
  files: { system: string; task: string },
): string {
  const task = `"$(cat ${shq(files.task)})"`
  const headless = !role.interactive
  if (h.harness === 'claude') {
    const allowed = [...role.tools.map((t) => CLAUDE_TOOLS[t]), ...(role.browser ? PLAYWRIGHT_TOOLS : [])]
    const denied = (Object.keys(CLAUDE_TOOLS) as NeutralTool[])
      .filter((t) => !role.tools.includes(t))
      .map((t) => CLAUDE_TOOLS[t])
      .concat('Agent')
    return [
      'claude',
      ...(headless ? ['-p'] : []),
      task,
      '--append-system-prompt-file', shq(files.system),
      ...(h.model ? ['--model', shq(h.model)] : []),
      '--permission-mode', 'auto',
      '--allowedTools', shq(allowed.join(',')),
      '--disallowedTools', shq(denied.join(',')),
      ...(headless ? ['--output-format', 'stream-json', '--verbose'] : []),
    ].join(' ')
  }
  const tools = role.tools.flatMap((t) => PI_TOOLS[t])
  return [
    'pi',
    ...(headless ? ['-p'] : []),
    '--append-system-prompt', shq(files.system),
    ...(h.model ? ['--model', shq(h.model)] : []),
    '--tools', shq(tools.join(',')),
    ...(headless ? ['--mode', 'json'] : []),
    task,
  ].join(' ')
}
