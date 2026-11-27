import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_DIR } from './paths'

export type Harness = 'claude' | 'pi'
export type Tier = 'high' | 'medium' | 'low'

export interface RoleOverride {
  harness?: Harness
  tier?: Tier
  timeoutMin?: number
}

export interface FactoryConfig {
  /** The branch new jobs start from; null: origin's default branch. `factory new --base` overrides it per job. */
  base: string | null
  /** PR title template with `{type}`, `{ticket}` and `{summary}`; null: the summarizer follows the repo's PR rules. */
  prTitle: string | null
  setup: string[]
  docs: { requirements: string; techDiscovery: string; design: string; specs: string; testPlans: string }
  hooks: { prOpened?: string; qaUrl?: string; qaReady?: string }
  validators: string[]
  roles: Record<string, RoleOverride>
  defaultHarness: Harness
  models: { claude: Record<Tier, string>; pi: Partial<Record<Tier, string>> }
  timeoutsMin: Record<Tier, number>
  maxTrips: number
  maxDiscoveryLoops: number
  qaReadyTimeoutMin: number
  qaPollSec: number
  docsCommitType: string
}

export const KNOWN_VALIDATORS = ['e2e', 'user', 'load', 'capacity']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Objects merge recursively; arrays and scalars from `over` replace `base`. */
function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v
  return out
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
}

export function loadConfig(repo: string): FactoryConfig {
  const defaults = readJson(join(PACKAGE_DIR, 'config.json'))
  const file = join(repo, '.factory.json')
  let merged = defaults
  if (existsSync(file)) {
    const repoConfig = readJson(file)
    if (!isObject(repoConfig)) throw new Error(`${file}: expected a JSON object`)
    merged = merge(defaults, repoConfig)
  }
  const config = merged as FactoryConfig
  for (const v of config.validators) {
    if (!KNOWN_VALIDATORS.includes(v)) {
      throw new Error(`unknown validator "${v}" (known: ${KNOWN_VALIDATORS.join(', ')})`)
    }
  }
  return config
}
