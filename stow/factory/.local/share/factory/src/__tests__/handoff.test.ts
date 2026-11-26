import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig } from '../config'
import {
  builderFor,
  checkOutput,
  hasHumanQuestions,
  outputPath,
  parseDiscoveryReview,
  parsePlan,
  parseTestPlan,
  type OutputKind,
} from '../handoff'
import { jobPaths } from '../paths'

const cfg = loadConfig('/nonexistent-repo')
const paths = jobPaths('/r', '260101-x')

const ok = (kind: OutputKind, text: string, verdict: string | null = null) =>
  expect(checkOutput(kind, text, cfg)).toEqual({ ok: true, verdict })
const bad = (kind: OutputKind, text: string, problem: string) =>
  expect(checkOutput(kind, text, cfg)).toEqual({ ok: false, problem })

const PLAN = `# Spec

## Acceptance criteria

1. It works
2. It is fast

## Tasks

### T1 Backend bits
Specialist: backend

do it

### T2 Screens
Specialist: Frontend

Lenses: code, Product

## Run

T1, T2
`

test('outputPath resolves every kind', () => {
  const a = { paths, cfg, id: '260101-x', trip: 2, n: 3 }
  expect(outputPath('requirements', a)).toBe(join('/r/.factory/260101-x', cfg.docs.requirements, '260101-x.md'))
  expect(outputPath('tech-discovery', a)).toBe(join('/r/.factory/260101-x', cfg.docs.techDiscovery, '260101-x.md'))
  expect(outputPath('design', a)).toBe(join('/r/.factory/260101-x', cfg.docs.design, '260101-x.md'))
  expect(outputPath('spec', a)).toBe(join('/r/.factory/260101-x', cfg.docs.specs, '260101-x.md'))
  expect(outputPath('test-plan', a)).toBe(join('/r/.factory/260101-x', cfg.docs.testPlans, '260101-x.md'))
  expect(outputPath('discovery-review', a)).toBe('/r/.factory/jobs/260101-x/discovery-review-3.md')
  expect(outputPath('build', a)).toBe('/r/.factory/jobs/260101-x/trip-2/build.md')
  expect(outputPath('review', { ...a, name: 'code' })).toBe('/r/.factory/jobs/260101-x/trip-2/review-code.md')
  expect(outputPath('build-judge', a)).toBe('/r/.factory/jobs/260101-x/trip-2/build-judge.md')
  expect(outputPath('validation', { ...a, name: 'e2e' })).toBe('/r/.factory/jobs/260101-x/trip-2/validation-e2e.md')
  expect(outputPath('validation-judge', a)).toBe('/r/.factory/jobs/260101-x/trip-2/validation-judge.md')
  expect(outputPath('rebase', a)).toBe('/r/.factory/jobs/260101-x/trip-2/rebase.md')
  expect(outputPath('pr', a)).toBe('/r/.factory/jobs/260101-x/pr.md')
})

test('outputPath requires name for review and validation', () => {
  const a = { paths, cfg, id: 'x', trip: 1, n: 1 }
  expect(() => outputPath('review', a)).toThrow('name')
  expect(() => outputPath('validation', a)).toThrow('name')
})

test('requirements', () => {
  ok('requirements', '# Title\n\n## Intent\nx\n## Requirements\ny\n## Decisions\nz\n')
  bad('requirements', '## Intent\n## Requirements\n## Decisions\n', 'first line must start with "# "')
  bad('requirements', '# T\n## Intent\n## Requirements\n', 'missing "## Decisions"')
  bad('requirements', '# T\n## Intentional\n## Requirements\n## Decisions\n', 'missing "## Intent"')
})

test('tech-discovery', () => {
  ok('tech-discovery', '## Findings\n## Risks\n')
  bad('tech-discovery', '## Findings\n', 'missing "## Risks"')
})

test('design', () => {
  ok('design', '## Approach\n## Alternatives\n## Questions for the human\nNone\n')
  bad('design', '## Approach\n## Alternatives\n', 'missing "## Questions for the human"')
})

test('discovery-review', () => {
  ok('discovery-review', 'VERDICT: PASS\n', 'PASS')
  ok('discovery-review', 'VERDICT: REWORK tech-discovery\n', 'REWORK')
  ok('discovery-review', 'VERDICT: REWORK design\n', 'REWORK')
  ok('discovery-review', 'VERDICT: ASK\n\n## Questions\n- which db?\n', 'ASK')
  bad('discovery-review', 'VERDICT: ASK\n', 'missing "## Questions"')
  bad('discovery-review', 'VERDICT: ASK\n## Questions\n\n', 'empty "## Questions"')
  bad(
    'discovery-review',
    'VERDICT: REWORK\n',
    'first line must be "VERDICT: PASS", "VERDICT: REWORK tech-discovery", "VERDICT: REWORK design" or "VERDICT: ASK"',
  )
})

test('spec', () => {
  ok('spec', PLAN)
  bad('spec', PLAN.replace('## Acceptance criteria', '## Acceptance'), 'missing "## Acceptance criteria"')
  bad('spec', PLAN.replace(/^\d\. .*$/gm, '- item'), 'no numbered acceptance criteria')
  bad('spec', PLAN.replace('## Tasks', '## Work'), 'missing "## Tasks"')
  bad('spec', PLAN.replace('Specialist: backend\n', ''), 'task T1 has no "Specialist: <s>" line')
  bad('spec', PLAN.replace('Lenses: code, Product\n', ''), 'missing "Lenses:" line')
  bad('spec', PLAN.replace('T1, T2', 'T1, T9'), 'Run lists unknown task "T9"')
  bad('spec', PLAN + '\n## Notes\nx\n', 'missing "## Run" as the last section')
  bad('spec', PLAN.replace('## Run', '## Rerun'), 'missing "## Run" as the last section')
})

test('spec lenses must be known', () => {
  bad('spec', PLAN.replace('code, Product', 'code, vibes'), 'unknown lens "vibes"')
})

test('builder and build-judge and resolver', () => {
  ok('build', 'STATUS: READY\nstuff', 'READY')
  ok('build', '﻿STATUS: BLOCKED  \n', 'BLOCKED')
  bad('build', 'done\n', 'first line must be "STATUS: READY" or "STATUS: BLOCKED"')
  ok('rebase', 'STATUS: READY\n', 'READY')
  bad('rebase', '', 'first line must be "STATUS: READY" or "STATUS: BLOCKED"')
  ok('build-judge', 'VERDICT: APPROVE\n', 'APPROVE')
  ok('build-judge', 'VERDICT: CHANGES\n', 'CHANGES')
  ok('build-judge', 'VERDICT: ESCALATE\n## Questions\nwhy?\n', 'ESCALATE')
  bad('build-judge', 'VERDICT: ESCALATE\n', 'missing "## Questions"')
  bad('build-judge', 'VERDICT: PASS\n', 'first line must be "VERDICT: APPROVE", "VERDICT: CHANGES" or "VERDICT: ESCALATE"')
})

test('review and validation', () => {
  ok('review', 'VERDICT: PASS\n', 'PASS')
  ok('review', 'VERDICT: CHANGES\n', 'CHANGES')
  bad('review', 'VERDICT: FAIL\n', 'first line must be "VERDICT: PASS" or "VERDICT: CHANGES"')
  ok('validation', 'VERDICT: FAIL\n', 'FAIL')
  bad('validation', 'VERDICT: CHANGES\n', 'first line must be "VERDICT: PASS" or "VERDICT: FAIL"')
  ok('validation-judge', 'VERDICT: ENV\n', 'ENV')
  ok('validation-judge', 'VERDICT: ESCALATE\n## Questions\nq\n', 'ESCALATE')
  bad('validation-judge', 'VERDICT: ESCALATE\n## Questions\n', 'empty "## Questions"')
  bad(
    'validation-judge',
    'VERDICT: MAYBE\n',
    'first line must be "VERDICT: PASS", "VERDICT: FAIL", "VERDICT: ENV" or "VERDICT: ESCALATE"',
  )
})

test('verdict line tolerates trailing spaces but not prose', () => {
  ok('review', 'VERDICT: PASS  \n', 'PASS')
  expect(checkOutput('review', 'VERDICT: PASS, mostly\n', cfg).ok).toBe(false)
})

test('test-plan', () => {
  ok('test-plan', '## Cases\n1. a\n\nValidators: e2e, User\n')
  bad('test-plan', 'Validators: e2e\n', 'missing "## Cases"')
  bad('test-plan', '## Cases\n', 'missing "Validators:" line')
})

test('test plan validators must be allowed by config', () => {
  bad('test-plan', '## Cases\nValidators: load\n', 'validator "load" is not enabled in .factory.json')
  bad('test-plan', '## Cases\nValidators: e2e, nope\n', 'validator "nope" is not enabled in .factory.json')
})

test('pr', () => {
  ok('pr', '# Add thing\n\nbody')
  bad('pr', 'Add thing\n', 'first line must be "# <PR title>"')
  bad('pr', '# \nbody', 'first line must be "# <PR title>"')
})

test('parsePlan reads Run order, specialists and AC numbers', () => {
  expect(parsePlan(PLAN)).toEqual({
    tasks: [
      { id: 'T1', specialist: 'backend' },
      { id: 'T2', specialist: 'frontend' },
    ],
    run: ['T1', 'T2'],
    lenses: ['code', 'product'],
    criteria: [1, 2],
  })
})

test('parseTestPlan and parseDiscoveryReview', () => {
  expect(parseTestPlan('## Cases\nValidators: E2E, user\n')).toEqual({ validators: ['e2e', 'user'] })
  expect(parseDiscoveryReview('VERDICT: PASS\n')).toEqual({ verdict: 'PASS' })
  expect(parseDiscoveryReview('VERDICT: REWORK design\n')).toEqual({ verdict: 'REWORK', step: 'design' })
  expect(parseDiscoveryReview('VERDICT: REWORK tech-discovery \n')).toEqual({ verdict: 'REWORK', step: 'tech-discovery' })
  expect(parseDiscoveryReview('VERDICT: ASK\n')).toEqual({ verdict: 'ASK' })
  expect(() => parseDiscoveryReview('hello')).toThrow()
})

test('hasHumanQuestions', () => {
  const d = (body: string) => `## Approach\nx\n## Questions for the human\n${body}`
  expect(hasHumanQuestions(d('None'))).toBe(false)
  expect(hasHumanQuestions(d('None.\n'))).toBe(false)
  expect(hasHumanQuestions(d(''))).toBe(false)
  expect(hasHumanQuestions(d('- which db?\n'))).toBe(true)
  expect(hasHumanQuestions(d('None\n## After\nx'))).toBe(false)
  expect(hasHumanQuestions('## Approach\nx')).toBe(false)
})

test('builderFor', () => {
  expect(builderFor('frontend')).toBe('builder-frontend')
  expect(builderFor('general')).toBe('builder-general')
  expect(builderFor('weird')).toBe('builder-general')
})

test('markdown variants: bold keys, bullets, messy specialists', () => {
  const plan = [
    '# S',
    '## Acceptance criteria',
    '1. a',
    '## Tasks',
    '### T1 a',
    '- **Specialist:** `backend`',
    '### T2 b',
    '**Specialist:** Front-end',
    '### T3 c',
    'Specialist: **backend**,',
    '### T4 d',
    'Specialist: Quantum',
    '**Lenses:** code, UI',
    '## Run',
    '**Run:** T1, T2',
    '',
  ].join('\n')
  expect(parsePlan(plan).tasks.map((t) => t.specialist)).toEqual(['backend', 'frontend', 'backend', 'Quantum'])
  expect(parsePlan(plan).lenses).toEqual(['code', 'ui'])
  expect(parsePlan(plan).run).toEqual(['T1', 'T2'])
  expect(builderFor('`Front-end`')).toBe('builder-frontend')
  expect(builderFor('Quantum')).toBe('builder-general')
})

test('multi-line and bullet Run lists', () => {
  const head = PLAN.slice(0, PLAN.indexOf('## Run'))
  expect(parsePlan(`${head}## Run\n\nT1,\nT2\n`).run).toEqual(['T1', 'T2'])
  expect(parsePlan(`${head}## Run\n- T1\n- T2\n`).run).toEqual(['T1', 'T2'])
  ok('spec', `${head}## Run\n1. T1\n2. T2\n`)
  bad('spec', `${head}## Run\n- T1\n- T9\n`, 'Run lists unknown task "T9"')
})

test('CRLF input and trailing colon headings', () => {
  ok('spec', PLAN.replace(/\n/g, '\r\n'))
  ok('requirements', '# T\r\n\r\n## Intent:\r\nx\r\n## Requirements \r\ny\r\n## Decisions\r\nz\r\n')
  ok('review', 'VERDICT: PASS\r\n', 'PASS')
})

test('hasHumanQuestions tolerates emphasis and explanations', () => {
  const d = (body: string) => `## Questions for the human\n${body}\n`
  expect(hasHumanQuestions(d('**None**'))).toBe(false)
  expect(hasHumanQuestions(d('N/A'))).toBe(false)
  expect(hasHumanQuestions(d('None — all decided in requirements'))).toBe(false)
  expect(hasHumanQuestions(d('None: nothing open'))).toBe(false)
  expect(hasHumanQuestions(d('Nonetheless, which db?'))).toBe(true)
})
