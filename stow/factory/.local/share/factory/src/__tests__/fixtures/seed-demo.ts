#!/usr/bin/env bun
/**
 * Seeds a demo repo for the dashboard: one job per waiting state, jobs mid-discovery, mid-build, mid-validation,
 * done and discarded, with docs, trip files, logs and activity. Times are relative to now.
 *
 *   bun src/__tests__/fixtures/seed-demo.ts /tmp/factory-demo
 *
 * Re-running replaces `<dir>/.factory`, so it refuses a non-empty `<dir>` without the `.factory-demo` file an
 * earlier seed left. Serve it with serve-demo.ts, which never launches anything.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { realExec } from '../../exec'
import { createJob, saveJob, type Job, type Stage, type TripRecord } from '../../job'
import { jobPaths } from '../../paths'

/** Left in <dir> by a seed: the only sign that wiping <dir>/.factory is safe. */
const MARKER = '.factory-demo'
const NOW = Date.now()
const ago = (min: number) => new Date(NOW - min * 60_000)
const today = (() => {
  const d = new Date(NOW)
  return [d.getFullYear() % 100, d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('')
})()

const DOCS = {
  requirements: 'docs/requirements',
  'tech discovery': 'docs/tech-discovery',
  design: 'docs/design-docs',
  spec: 'docs/specs',
  'test plan': 'docs/test-plans',
} as const
type Doc = keyof typeof DOCS

/** The role that runs each stage, as the driver names its windows. */
const ROLE: Partial<Record<Stage, string>> = {
  requirements: 'requirements',
  'tech-discovery': 'tech-discoverer',
  design: 'designer',
  'discovery-review': 'discovery-reviewer',
  planning: 'planner',
  build: 'builder-backend',
  review: 'reviewer-code',
  'build-judge': 'build-judge',
  'test-planning': 'test-planner',
  validation: 'validator-e2e',
  'validation-judge': 'validation-judge',
  finalize: 'summarizer',
}

function write(file: string, body: string, mtime?: Date): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`)
  if (mtime) utimesSync(file, mtime, mtime)
}

const hms = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')

/** activity.log lines for a walk through `stages`, spread from `fromMin` to `toMin` minutes ago, plus `extra`. */
function history(stages: Stage[], fromMin: number, toMin: number, verdicts: Record<number, string> = {}, extra: [number, string][] = []): string {
  const lines: [number, string][] = [...extra]
  const step = (fromMin - toMin) / Math.max(1, stages.length - 1)
  for (let i = 0; i < stages.length - 1; i++) {
    const at = fromMin - i * step
    const from = stages[i]!
    const role = ROLE[from]
    if (role) {
      lines.push([at, `start ${role} (claude ${from === 'requirements' || from.endsWith('judge') ? 'opus' : 'sonnet'})`])
      lines.push([at - step * 0.8, `${role}: ${verdicts[i] ?? 'ok'}`])
    }
    lines.push([at - step * 0.85, `${from} → ${stages[i + 1]}`])
  }
  return lines
    .sort((a, b) => b[0] - a[0])
    .map(([min, text]) => `${hms(ago(min))} ${text}`)
    .join('\n')
}

/** A claude stream-json log: text, tool calls (one may fail) and, once the agent finished, the closing result. */
function claudeLog(
  steps: ({ text: string } | { tool: string; input: Record<string, string>; error?: string })[],
  result: { secs: number; cost: number } | 'max_turns' | null = null,
): string {
  const sid = `session-${Math.random().toString(36).slice(2, 8)}`
  const ev: unknown[] = [{ type: 'system', subtype: 'init', cwd: '/repo/.factory/job', session_id: sid, model: 'claude-sonnet-4-5' }]
  steps.forEach((s, i) => {
    if ('text' in s) {
      ev.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: s.text }] }, session_id: sid })
      return
    }
    const id = `toolu_${i}`
    ev.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: s.tool, input: s.input }] }, session_id: sid })
    ev.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!s.error, content: s.error ?? 'ok' }] }, session_id: sid })
  })
  if (result === 'max_turns') ev.push({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 45_000, session_id: sid })
  else if (result) ev.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: result.secs * 1000, total_cost_usd: result.cost, session_id: sid })
  return ev.map((e) => JSON.stringify(e)).join('\n')
}

const reviewBody = (lens: string, verdict: string, note: string) => `VERDICT: ${verdict}

## ${lens[0]!.toUpperCase()}${lens.slice(1)} review

${note}
`

interface Seed {
  slug: string
  feature: string
  minutes: number
  job: Partial<Job>
  docs?: Partial<Record<Doc, string>>
  trips?: Record<string, string>[]
  files?: Record<string, string>
  logs?: Record<string, string>
  activity: string
}

function seed(repo: string, s: Seed, slot: number): Job {
  const id = `${today}-${s.slug}`
  const paths = jobPaths(repo, id)
  const base = createJob({ id, branch: `feature/${id}`, base: 'main', feature: s.feature, repo, slot, now: ago(s.minutes) })
  const job: Job = { ...base, ...s.job }
  if (job.questionsFile) job.questionsFile = join(paths.jobDir, job.questionsFile)
  if (job.reasonFile) job.reasonFile = join(paths.jobDir, job.reasonFile)
  saveJob(paths.jobFile, job, ago(1))
  mkdirSync(job.worktree, { recursive: true })
  for (const [name, body] of Object.entries(s.docs ?? {})) write(join(job.worktree, DOCS[name as Doc], `${id}.md`), body)
  s.trips?.forEach((files, i) => {
    for (const [name, body] of Object.entries(files)) write(join(paths.tripDir(i + 1), name), body)
  })
  for (const [name, body] of Object.entries(s.files ?? {})) write(join(paths.jobDir, name), body)
  // Newest log last in the list, so its mtime is the latest.
  Object.entries(s.logs ?? {}).forEach(([name, body], i, all) => write(join(paths.logsDir, `${name}.log`), body, ago(all.length - i)))
  write(paths.activityLog, s.activity)
  return job
}

const trip = (cycle: number, n: number, patch: Partial<TripRecord> = {}): TripRecord => ({
  cycle, trip: n, reviews: {}, buildJudge: null, validations: {}, validationJudge: null, ...patch,
})
const ALL_PASS = { product: 'PASS', security: 'PASS', code: 'PASS', ux: 'PASS', ui: 'PASS' }
const PR = (n: number) => `https://github.com/acme/shop/pull/${n}`

const requirements = (title: string, intent: string, reqs: string[], decisions: string[]) => `# ${title}

## Intent

${intent}

## Requirements

${reqs.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Decisions

${decisions.map((d) => `- ${d}`).join('\n')}
`

const spec = (criteria: string[], tasks: [string, string, string][], lenses: string) => `# Spec

## Acceptance criteria

${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Tasks

${tasks.map(([t, title, s]) => `### ${t} ${title}\n\nSpecialist: ${s}\n`).join('\n')}
Lenses: ${lenses}

## Run

${tasks.map(([t]) => t).join(', ')}
`

function seeds(): Seed[] {
  const rateLimitDocs: Partial<Record<Doc, string>> = {
    requirements: requirements(
      'Rate limit the signup form',
      'Bots create thousands of accounts a day through `/signup`. Slow them down without hurting real people.',
      ['At most 5 signups per IP per 10 minutes.', 'A blocked request gets HTTP 429 and a friendly message.', 'Limits are configurable per environment.'],
      ['Count per IP, not per session (answered in the grill).', 'No CAPTCHA for now.'],
    ),
    'tech discovery': `# Tech discovery

## Findings

- Signup lives in \`src/routes/signup.ts\`; there is no middleware layer yet.
- Redis is already deployed (\`REDIS_URL\`) and used for sessions.

| Option | Cost | Notes |
| --- | --- | --- |
| Redis \`INCR\` + \`EXPIRE\` | none | atomic, shared across pods |
| In-memory map | none | breaks with more than one pod |

## Risks

- Behind the load balancer every request comes from one IP unless we trust \`X-Forwarded-For\`.
`,
    design: `# Design

## Approach

A small \`rateLimit({ key, max, windowSec })\` middleware backed by Redis, applied to \`POST /signup\`.

\`\`\`ts
app.post('/signup', rateLimit({ key: clientIp, max: 5, windowSec: 600 }), signup)
\`\`\`

## Alternatives

- A reverse-proxy rule in nginx: faster, but invisible to the app and hard to test.

## Questions for the human

None
`,
    spec: spec(
      ['Six signups from one IP within 10 minutes: the sixth gets 429.', 'The 429 page says when to try again.', '`RATE_LIMIT_SIGNUP` overrides the default of 5.'],
      [['T1', 'Rate limit middleware', 'backend'], ['T2', 'Friendly 429 page', 'frontend']],
      'product, security, code, ux, ui',
    ),
    'test plan': `# Test plan

## Cases

1. Sign up five times from one IP, then a sixth: expect 429 and the retry time.
2. Wait out the window: signup works again.

Validators: e2e, user
`,
  }

  return [
    {
      slug: 'onboarding-checklist',
      feature: 'Add an onboarding checklist to the account page',
      minutes: 6,
      job: { stage: 'requirements', waitingFor: 'requirements', waitingSince: ago(4).toISOString(), running: ['requirements'] },
      logs: {},
      activity: history(['requirements'], 6, 6, {}, [[6, 'start requirements (claude opus)']]),
    },
    {
      slug: 'rate-limit',
      feature: 'Rate limit the signup form',
      minutes: 190,
      job: {
        stage: 'human-review', waitingFor: 'human-review', waitingSince: ago(26).toISOString(), planned: true, trip: 2,
        discoveryLoops: 0, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(42), qaUrl: 'https://qa-42.shop.acme.dev', ready: null,
        trips: [
          trip(1, 1, { reviews: { ...ALL_PASS, security: 'CHANGES', code: 'CHANGES' }, buildJudge: 'CHANGES', built: ['T1', 'T2'] }),
          trip(1, 2, { reviews: ALL_PASS, buildJudge: 'APPROVE', validations: { e2e: 'PASS', user: 'PASS' }, validationJudge: 'PASS', built: ['T1'] }),
        ],
      },
      docs: rateLimitDocs,
      files: {
        'discovery-review-1.md': 'VERDICT: PASS\n\nRequirements, findings and design agree. The proxy-IP risk is covered by the design.',
        'pr.md': '# Rate limit the signup form\n\nAdds a Redis-backed limiter to `POST /signup`.',
      },
      trips: [
        {
          'build.md': 'STATUS: READY\n\n## T1 Rate limit middleware\n\nAdded `src/middleware/rateLimit.ts` and tests.\n\n## T2 Friendly 429 page\n\nAdded `views/429.html`.',
          'review-product.md': reviewBody('product', 'PASS', 'Matches the requirements.'),
          'review-security.md': reviewBody('security', 'CHANGES', '1. `X-Forwarded-For` is trusted from any client: spoofable. Trust it only from the load balancer.'),
          'review-code.md': reviewBody('code', 'CHANGES', '1. `windowSec` is read as a string from env; parse it.'),
          'review-ux.md': reviewBody('ux', 'PASS', 'The 429 page explains what happened and when to retry.'),
          'review-ui.md': reviewBody('ui', 'PASS', 'Uses the existing error page layout.'),
          'build-judge.md': 'VERDICT: CHANGES\n\n## Fixes\n\n1. Trust `X-Forwarded-For` only from the load balancer (security).\n2. Parse `windowSec` as a number (code).',
        },
        {
          'build.md': 'STATUS: READY\n\n## Fixes\n\n- Proxy trust list from `TRUSTED_PROXIES`.\n- `windowSec` parsed with `Number()` and validated.',
          ...Object.fromEntries(Object.keys(ALL_PASS).map((l) => [`review-${l}.md`, reviewBody(l, 'PASS', 'No further findings.')])),
          'build-judge.md': 'VERDICT: APPROVE\n\nBoth fixes landed with tests.',
          'rebase.md': 'STATUS: READY\n\nRebased onto origin/main without conflicts.',
          'validation-e2e.md': 'VERDICT: PASS\n\n| Case | Result |\n| --- | --- |\n| 1 | 429 after the fifth signup |\n| 2 | works again after 10 min |',
          'validation-user.md': 'VERDICT: PASS\n\nThe message is clear; the retry time is shown in local time.',
          'validation-judge.md': 'VERDICT: PASS\n\nAll cases pass on the QA env.',
        },
      ],
      logs: {
        'planner-1': claudeLog([{ text: 'Reading the requirements and the design.' }, { tool: 'Read', input: { file_path: 'docs/design-docs/rate-limit.md' } }, { tool: 'Write', input: { file_path: 'docs/specs/rate-limit.md' } }, { text: 'Spec written: 2 tasks, 5 lenses.' }], { secs: 94, cost: 0.18 }),
        'builder-backend-2': claudeLog([{ text: 'Applying the judge fixes.' }, { tool: 'Edit', input: { file_path: 'src/middleware/rateLimit.ts' } }, { tool: 'Bash', input: { command: 'bun test src/middleware' } }, { text: 'All 14 tests pass. Committed `fix: trust proxies explicitly`.' }], { secs: 312, cost: 0.61 }),
        'validator-e2e-1': claudeLog([{ text: 'Opening https://qa-42.shop.acme.dev/signup' }, { tool: 'browser_navigate', input: { url: 'https://qa-42.shop.acme.dev/signup' } }, { tool: 'browser_click', input: { description: 'Sign up' } }, { text: 'Sixth signup returned 429 with "Try again at 14:20".' }], { secs: 141, cost: 0.33 }),
      },
      activity: history(
        ['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'planning', 'build', 'review', 'build-judge', 'test-planning', 'rebase', 'qa-wait', 'validation', 'validation-judge', 'human-review'],
        190, 26, { 3: 'PASS', 6: 'CHANGES', 7: 'CHANGES', 11: 'APPROVE', 15: 'PASS', 16: 'PASS' },
        [[150, `opened draft PR ${PR(42)}`], [60, 'QA env: https://qa-42.shop.acme.dev']],
      ),
    },
    {
      slug: 'signup-schema',
      feature: 'Validate signup payloads on the server',
      minutes: 120,
      job: {
        stage: 'needs-human', waitingFor: 'escalation', waitingSince: ago(12).toISOString(), resumeStage: 'test-planning', planned: true, trip: 1,
        discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(45), questionsFile: 'trip-1/build-judge.md', reasonFile: 'trip-1/build-judge.md',
        trips: [trip(1, 1, { reviews: { ...ALL_PASS, code: 'CHANGES' }, buildJudge: 'ESCALATE', built: ['T1', 'T2'] })],
      },
      docs: {
        requirements: requirements('Validate signup payloads on the server', 'Bad payloads reach the database today.', ['Reject unknown fields.', 'Return field-level errors.'], ['Validation errors use the existing `{ errors: [] }` shape.']),
        spec: spec(['A payload with an unknown field gets 400.', 'Each invalid field is named in `errors`.'], [['T1', 'Schema and middleware', 'backend'], ['T2', 'Show field errors on the form', 'frontend']], 'product, security, code'),
      },
      trips: [{
        'build.md': 'STATUS: READY\n\n## T1 Schema and middleware\n\nAdded `zod` and `src/schemas/signup.ts`.',
        'review-product.md': reviewBody('product', 'PASS', 'Covers both requirements.'),
        'review-security.md': reviewBody('security', 'PASS', 'Unknown fields are stripped before the insert.'),
        'review-code.md': reviewBody('code', 'CHANGES', '1. The builder added the dependency `zod` (12 kB gzipped). AGENTS.md says new dependencies need the owner\'s OK.'),
        'review-ux.md': reviewBody('ux', 'PASS', 'Errors show next to each field.'),
        'review-ui.md': reviewBody('ui', 'PASS', 'Error text uses the form error style.'),
        'build-judge.md': 'VERDICT: ESCALATE\n\nThe work is sound, but it adds a runtime dependency, which only the owner can approve.\n\n## Questions\n\n1. New dependency `zod` for schema validation: keep it, or hand-roll the checks?\n2. Should unknown fields be rejected or silently dropped?',
      }],
      logs: {
        'build-judge-1': claudeLog([{ text: 'Weighing 5 reviews against the spec.' }, { tool: 'Read', input: { file_path: 'trip-1/review-code.md' } }, { text: 'Escalating: new runtime dependency.' }], { secs: 48, cost: 0.12 }),
      },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'needs-human'], 120, 12, { 3: 'PASS', 6: 'CHANGES', 7: 'ESCALATE' }),
    },
    {
      slug: 'csv-export',
      feature: 'Export orders as CSV',
      minutes: 75,
      job: {
        stage: 'needs-human', waitingFor: 'failure', waitingSince: ago(41).toISOString(), resumeStage: 'planning', planned: false, trip: 1,
        reason: 'planner wrote no file twice', discovery: [{ n: 1, verdict: 'PASS' }], trips: [trip(1, 1)],
      },
      docs: {
        requirements: requirements('Export orders as CSV', 'Support asks engineers for order exports every week.', ['Admins download orders for a date range as CSV.', 'Columns match the finance template.'], ['UTF-8 with BOM, so Excel opens it.']),
        'tech discovery': '# Tech discovery\n\n## Findings\n\n- Orders are paginated in `OrderRepo.list`; streaming is possible.\n\n## Risks\n\n- Large ranges may time out behind the 30 s proxy limit.',
        design: '# Design\n\n## Approach\n\nStream rows with `Readable.from`.\n\n## Alternatives\n\n- A background job that emails the file.\n\n## Questions for the human\n\nNone',
      },
      logs: {
        'planner-1': claudeLog([{ text: 'Reading the design.' }, { tool: 'Read', input: { file_path: 'docs/design-docs/csv-export.md' } }], 'max_turns'),
        'planner-2': claudeLog([{ text: 'Retrying the plan.' }, { tool: 'Write', input: { file_path: 'docs/specs/csv-export.md' }, error: 'EACCES: permission denied, open docs/specs/csv-export.md' }], 'max_turns'),
      },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'needs-human'], 75, 41, { 3: 'PASS', 4: 'docs/specs/csv-export.md was not written' }),
    },
    {
      slug: 'search-filters',
      feature: 'Filter search results by price',
      minutes: 160,
      job: {
        stage: 'needs-human', waitingFor: 'escalation', waitingSince: ago(8).toISOString(), resumeStage: 'human-review', capHit: 'env', planned: true, trip: 1,
        envRetries: 1, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(47), qaUrl: 'https://qa-47.shop.acme.dev', reasonFile: 'trip-1/validation-judge.md',
        trips: [trip(1, 1, { reviews: ALL_PASS, buildJudge: 'APPROVE', validations: {}, validationJudge: 'ENV', built: ['T1'] })],
      },
      docs: { requirements: requirements('Filter search results by price', 'Shoppers can\'t narrow big result pages.', ['A min/max price filter on search.'], ['Prices filter on the displayed currency.']) },
      trips: [{
        'review-code.md': reviewBody('code', 'PASS', 'Clean.'),
        'build-judge.md': 'VERDICT: APPROVE',
        'validation-e2e.env1.md': 'VERDICT: FAIL\n\nhttps://qa-47.shop.acme.dev answered 502 Bad Gateway.',
        'validation-judge.md': 'VERDICT: ENV\n\nThe QA env answered **502** twice. Nothing points at the change itself.',
      }],
      logs: {},
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'test-planning', 'rebase', 'qa-wait', 'validation', 'validation-judge', 'needs-human'], 160, 8, { 3: 'PASS', 7: 'APPROVE', 12: 'ENV' }),
    },
    {
      slug: 'dark-mode',
      feature: 'Dark mode for the storefront',
      minutes: 35,
      job: { stage: 'design', waitingFor: null, waitingSince: null, running: ['designer'] },
      docs: {
        requirements: requirements('Dark mode for the storefront', 'Night shoppers asked for it.', ['Follow the OS setting.', 'A toggle in the footer overrides it.'], ['Product photos stay as they are.']),
        'tech discovery': `# Tech discovery

## Findings

- Colors are hard-coded in 41 files. Theme tokens exist only in \`checkout.css\`.
- A review once shipped this in a comment: <img src=x onerror=alert(1)> (it must show as text).

\`\`\`html
<script>document.body.classList.add('dark')</script>
\`\`\`

## Risks

- [Old prototype](javascript:alert(1)) used inline styles; see [the issue](https://github.com/acme/shop/issues/311).
`,
      },
      logs: {
        'tech-discoverer-1': claudeLog([{ tool: 'Grep', input: { pattern: '#[0-9a-f]{6}' } }, { text: 'Found 41 files with hard-coded colors.' }], { secs: 203, cost: 0.29 }),
        'designer-1': claudeLog([{ text: 'Drafting a token-based approach.' }, { tool: 'Read', input: { file_path: 'src/styles/checkout.css' } }]),
      },
      activity: history(['requirements', 'tech-discovery', 'design'], 35, 3, {}, [[2.9, 'start designer (claude opus)']]),
    },
    {
      slug: 'gift-cards',
      feature: 'Escape HTML in product reviews (<script> tags show as text)',
      minutes: 14,
      job: { stage: 'tech-discovery', waitingFor: null, waitingSince: null, running: ['tech-discoverer'] },
      docs: { requirements: requirements('Escape HTML in product reviews', 'A review with `<script>` broke the product page.', ['Review text renders as text.'], ['Existing reviews are escaped on read, not migrated.']) },
      logs: { 'tech-discoverer-1': claudeLog([{ tool: 'Grep', input: { pattern: 'dangerouslySetInnerHTML' } }]) },
      activity: history(['requirements', 'tech-discovery'], 14, 2, {}, [[1.9, 'start tech-discoverer (claude sonnet)']]),
    },
    {
      slug: 'order-history',
      feature: 'Paginate the order history page',
      minutes: 95,
      job: {
        stage: 'review', waitingFor: null, waitingSince: null, planned: true, trip: 1, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(44),
        running: ['reviewer-ux', 'reviewer-ui'],
        trips: [trip(1, 1, { reviews: { product: 'PASS', security: 'PASS', code: 'CHANGES', ux: 'pending', ui: 'pending' }, built: ['T1', 'T2', 'T3'] })],
      },
      docs: {
        requirements: requirements('Paginate the order history page', 'Customers with 500+ orders wait 9 s for the page.', ['20 orders per page.', 'Keep the filter when paging.'], ['Cursor pagination, not offsets.']),
        spec: spec(['The first page loads under 1 s with 500 orders.', 'Next and previous keep the status filter.'], [['T1', 'Cursor query', 'data'], ['T2', 'API params', 'backend'], ['T3', 'Pager component', 'frontend']], 'product, security, code, ux, ui'),
      },
      trips: [{
        'build.md': 'STATUS: READY\n\n## T1 Cursor query\n\n## T2 API params\n\n## T3 Pager component',
        'review-product.md': reviewBody('product', 'PASS', 'Both criteria are met.'),
        'review-security.md': reviewBody('security', 'PASS', 'The cursor is signed.'),
        'review-code.md': reviewBody('code', 'CHANGES', '1. `decodeCursor` throws on bad input; return 400 instead of 500.'),
      }],
      logs: {
        'builder-data-1': claudeLog([{ tool: 'Edit', input: { file_path: 'src/db/orders.ts' } }, { tool: 'Bash', input: { command: 'bun test src/db' } }], { secs: 260, cost: 0.4 }),
        'reviewer-code-1': claudeLog([{ tool: 'Bash', input: { command: 'git diff origin/main...HEAD --stat' } }, { text: 'One finding: decodeCursor throws.' }], { secs: 77, cost: 0.15 }),
        'reviewer-ui-1': claudeLog([{ text: 'Opening http://localhost:5130/orders' }, { tool: 'browser_navigate', input: { url: 'http://localhost:5130/orders' } }]),
        'reviewer-ux-1': claudeLog([{ text: 'Checking keyboard paging.' }, { tool: 'browser_press_key', input: { key: 'Tab' } }]),
      },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review'], 95, 5, { 3: 'PASS' },
        [[4.9, 'start reviewer-product (claude sonnet)'], [4.9, 'start reviewer-security (claude sonnet)'], [4.8, 'start reviewer-ux (claude sonnet)'], [4.8, 'start reviewer-ui (claude sonnet)'], [3, 'reviewer-product: PASS'], [2, 'reviewer-security: PASS'], [1, 'reviewer-code: CHANGES']]),
    },
    {
      slug: 'promo-codes',
      feature: 'Apply promo codes at checkout',
      minutes: 230,
      job: {
        stage: 'validation', waitingFor: null, waitingSince: null, planned: true, trip: 2, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(43),
        qaUrl: 'https://qa-43.shop.acme.dev', running: ['validator-user'],
        trips: [
          trip(1, 1, { reviews: { ...ALL_PASS, product: 'CHANGES' }, buildJudge: 'CHANGES' }),
          trip(1, 2, { reviews: ALL_PASS, buildJudge: 'APPROVE', validations: { e2e: 'PASS', user: 'pending' } }),
        ],
      },
      docs: { requirements: requirements('Apply promo codes at checkout', 'Marketing runs campaigns by hand.', ['One code per order.', 'Show the discount before payment.'], ['Codes are case-insensitive.']) },
      trips: [
        { 'review-product.md': reviewBody('product', 'CHANGES', '1. Expired codes show no message.'), 'build-judge.md': 'VERDICT: CHANGES\n\n1. Message for expired codes.' },
        { 'build-judge.md': 'VERDICT: APPROVE', 'validation-e2e.md': 'VERDICT: PASS\n\nAll 4 cases pass.' },
      ],
      logs: {
        'validator-e2e-1': claudeLog([{ tool: 'browser_navigate', input: { url: 'https://qa-43.shop.acme.dev/cart' } }, { text: 'All 4 cases pass.' }], { secs: 188, cost: 0.37 }),
        'validator-user-1': claudeLog([{ text: 'Trying the checkout as a first-time shopper.' }, { tool: 'browser_type', input: { text: 'WINTER10' } }]),
      },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'planning', 'build', 'review', 'build-judge', 'test-planning', 'rebase', 'qa-wait', 'validation'], 230, 6, { 3: 'PASS', 7: 'CHANGES', 11: 'APPROVE' }, [[5.5, 'validator-e2e: PASS']]),
    },
    {
      slug: 'sitemap',
      feature: 'Generate a sitemap for search engines',
      minutes: 140,
      job: {
        stage: 'finalize', waitingFor: null, waitingSince: null, planned: true, trip: 1, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(41), ready: true,
        running: ['summarizer'], trips: [trip(1, 1, { reviews: ALL_PASS, buildJudge: 'APPROVE', validations: { e2e: 'PASS' }, validationJudge: 'PASS' })],
      },
      logs: { 'summarizer-1': claudeLog([{ text: 'Writing the PR body.' }]) },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'test-planning', 'rebase', 'qa-wait', 'validation', 'validation-judge', 'human-review', 'finalize'], 140, 1, { 3: 'PASS', 7: 'APPROVE', 12: 'PASS' }, [[1.5, 'approve: human-review → finalize']]),
    },
    {
      slug: 'password-reset',
      feature: 'Password reset by email',
      minutes: 60 * 26,
      job: {
        stage: 'done', waitingFor: null, waitingSince: null, planned: true, trip: 1, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(38), ready: true,
        trips: [trip(1, 1, { reviews: ALL_PASS, buildJudge: 'APPROVE', validations: { e2e: 'PASS', user: 'PASS' }, validationJudge: 'PASS' })],
      },
      activity: history(['requirements', 'tech-discovery', 'design', 'discovery-review', 'planning', 'build', 'review', 'build-judge', 'test-planning', 'rebase', 'qa-wait', 'validation', 'validation-judge', 'human-review', 'finalize', 'done'], 60 * 26, 60 * 20, { 3: 'PASS', 7: 'APPROVE', 12: 'PASS' }),
    },
    {
      slug: 'image-cdn',
      feature: 'Serve product images from the CDN',
      minutes: 60 * 50,
      job: {
        stage: 'done', waitingFor: null, waitingSince: null, planned: true, trip: 3, discovery: [{ n: 1, verdict: 'PASS' }], pr: PR(36), ready: false,
        trips: [trip(1, 1, { buildJudge: 'CHANGES' }), trip(1, 2, { buildJudge: 'CHANGES' }), trip(1, 3, { buildJudge: 'CHANGES' })],
      },
      activity: history(['build-judge', 'needs-human', 'finalize', 'done'], 60 * 50, 60 * 47, {}, [[60 * 48, 'approve: needs-human → finalize']]),
    },
    {
      slug: 'graphql-cart',
      feature: 'Rewrite the cart on GraphQL',
      minutes: 60 * 30,
      job: { stage: 'discarded', waitingFor: null, waitingSince: null, planned: false, pr: PR(39) },
      activity: history(['requirements', 'tech-discovery', 'discarded'], 60 * 30, 60 * 29, {}, [[60 * 29, 'discard: tech-discovery → discarded']]),
    },
  ]
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: bun src/__tests__/fixtures/seed-demo.ts <dir>')
    process.exit(2)
  }
  const repo = resolve(dir)
  // Re-seeding wipes <dir>/.factory: only in an empty folder or one this script seeded before.
  const marker = join(repo, MARKER)
  if (existsSync(repo) && readdirSync(repo).length && !existsSync(marker)) {
    console.error(`seed-demo: refusing to seed ${repo}: it isn't empty and has no ${MARKER} file from an earlier seed`)
    process.exit(1)
  }
  mkdirSync(repo, { recursive: true })
  writeFileSync(marker, 'Seeded by seed-demo.ts; seeding again replaces .factory/ here.\n')
  if (!existsSync(join(repo, '.git'))) {
    const r = await realExec.run(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
    if (r.code !== 0) throw new Error(`git init: ${r.stderr}`)
  }
  rmSync(join(repo, '.factory'), { recursive: true, force: true })
  const jobs = seeds().map((s, i) => seed(repo, s, i + 1))
  console.log(`seeded ${jobs.length} jobs in ${repo}`)
}

await main()
