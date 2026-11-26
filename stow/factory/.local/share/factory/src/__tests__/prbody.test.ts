import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realExec } from '../exec'
import { createJob, type Job } from '../job'
import type { FactoryConfig } from '../config'
import { initialBody, mergeDecision, mergeStatus, proofCoverage, pushProof, renderStatus } from '../prbody'
import { FakeExec, tempRepo } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const cfg = { maxTrips: 3 } as FactoryConfig
const links = { requirements: 'https://x/req', 'tech discovery': null, design: 'https://x/design', spec: null, 'test plan': null }

function job(over: Partial<Job> = {}): Job {
  return { ...createJob({ id: '261126-rate-limit', feature: 'f', repo: '/r', slot: 1, now: new Date(0) }), ...over }
}

const reviewJob = () =>
  job({
    stage: 'review',
    waitingFor: null,
    planned: true,
    trip: 2,
    trips: [
      { cycle: 1, trip: 1, reviews: {}, buildJudge: null, validations: {}, validationJudge: null },
      {
        cycle: 1,
        trip: 2,
        reviews: { code: 'PASS', ux: 'PASS', ui: 'CHANGES', security: 'pending', product: 'pending' },
        buildJudge: null,
        validations: {},
        validationJudge: null,
      },
    ],
  })

describe('renderStatus', () => {
  test('review stage', () => {
    const s = renderStatus(reviewJob(), cfg, links)
    expect(s).toContain('**🏭 Factory** · `261126-rate-limit` · cycle 1 · trip 2/3 · ⏳ **Building: review (3/5)**')
    expect(s).toContain('| Discovery | ✅ requirements · ✅ tech discovery · ✅ design · ✅ AI review |')
    expect(s).toContain('| Building | ✅ plan · ✅ build · ⏳ review (3/5) · ⬜ judge |')
    expect(s).toContain('| Validation | ⬜ test plan · ⬜ rebase · ⬜ QA ready · ⬜ validators · ⬜ judge |')
    expect(s).toContain('| Deploy | ⬜ your review · ⬜ ready |')
    expect(s).toContain('Docs: [requirements](https://x/req) · [design](https://x/design)')
    expect(s.startsWith('<!-- factory:status -->\n')).toBe(true)
    expect(s.endsWith('\n<!-- /factory:status -->')).toBe(true)
  })

  test('trip cap includes extraTrips; no trip part in discovery; no docs line when none', () => {
    expect(renderStatus(reviewJob(), cfg, {})).not.toContain('Docs:')
    expect(renderStatus({ ...reviewJob(), extraTrips: 2 }, cfg, {})).toContain('trip 2/5')
    const s = renderStatus(job({ stage: 'tech-discovery', waitingFor: null }), cfg, {})
    expect(s).not.toContain('trip ')
    expect(s).toContain('⏳ **Discovery: tech discovery**')
    expect(s).toContain('| Discovery | ✅ requirements · ⏳ tech discovery · ⬜ design · ⬜ AI review |')
  })

  test('requirements wait, human review, done', () => {
    const r = renderStatus(job(), cfg, {})
    expect(r).toContain('⏸ **Waiting for you: answer the grill**')
    expect(r).toContain('⏸ requirements')
    const h = renderStatus(job({ stage: 'human-review', waitingFor: 'human-review', planned: true, trip: 1 }), cfg, {})
    expect(h).toContain('⏸ **Waiting for your review**')
    expect(h).toContain('⏸ your review · ⬜ ready')
    expect(h).toContain('✅ validators · ✅ judge')
    const d = renderStatus(job({ stage: 'done', waitingFor: null, trip: 1 }), cfg, {})
    expect(d).toContain('✅ **Done**')
    expect(d).not.toContain('⬜')
  })

  test('needs-human', () => {
    const fail = renderStatus(
      job({ stage: 'needs-human', waitingFor: 'failure', reason: 'tests red', resumeStage: 'build', trip: 1 }),
      cfg,
      {},
    )
    expect(fail).toContain('⏸ **Waiting for you: tests red**')
    expect(fail).toContain('| Building | ✅ plan · ❌ build · ⬜ review · ⬜ judge |')
    expect(fail).toContain('| Discovery | ✅ requirements · ✅ tech discovery · ✅ design · ✅ AI review |')
    const esc = renderStatus(job({ stage: 'needs-human', waitingFor: 'escalation', resumeStage: 'validation-judge', trip: 1 }), cfg, {})
    expect(esc).toContain('⏸ **Waiting for you: escalation**')
    expect(esc).not.toContain('❌')
  })

  test('discarded', () => {
    const s = renderStatus(job({ stage: 'discarded', waitingFor: null, planned: true }), cfg, {})
    expect(s).toContain('🗑 **Discarded**')
    expect(s).toContain('| Discovery | ✅ requirements · ✅ tech discovery · ✅ design · ✅ AI review |')
    expect(s).toContain('| Building | ⬜ plan')
  })

  test('validation counter', () => {
    const j = reviewJob()
    j.stage = 'validation'
    j.trips[1]!.validations = { e2e: 'PASS', user: 'pending' }
    expect(renderStatus(j, cfg, {})).toContain('⏳ **Validation: validators (1/2)**')
  })
})

describe('mergeStatus', () => {
  const a = renderStatus(job(), cfg, {})
  const b = renderStatus(reviewJob(), cfg, {})
  test('prepends when absent', () => {
    expect(mergeStatus('hello\n', a)).toBe(`${a}\n\nhello\n`)
  })
  test('idempotent and replaces', () => {
    const once = mergeStatus('hello\n', a)
    const twice = mergeStatus(mergeStatus(once, a), b)
    expect(twice.split('<!-- factory:status -->').length).toBe(2)
    expect(twice).toContain('trip 2/3')
    expect(twice).not.toContain('answer the grill')
    expect(twice.endsWith('\n\nhello\n')).toBe(true)
  })
  test('replacement text with $ is literal', () => {
    const s = `<!-- factory:status -->\nx $& $1\n<!-- /factory:status -->`
    expect(mergeStatus(`<!-- factory:status -->\nold\n<!-- /factory:status -->\nrest`, s)).toBe(`${s}\nrest`)
  })
})

describe('mergeDecision', () => {
  const status = renderStatus(job(), cfg, {})
  const body = `${status}\n\nhello\n`
  const D = '<!-- factory:decision -->'
  const E = '<!-- /factory:decision -->'
  test('goes right below the status block', () => {
    expect(mergeDecision(body, '## Q\n- one?')).toBe(`${status}\n\n${D}\n## Q\n- one?\n${E}\n\nhello\n`)
  })
  test('replaces an earlier decision and null removes it', () => {
    const once = mergeDecision(body, 'first')
    const twice = mergeDecision(once, 'second')
    expect(twice.split(D).length).toBe(2)
    expect(twice).toContain('second')
    expect(twice).not.toContain('first')
    expect(mergeDecision(twice, null)).toBe(body)
    expect(mergeDecision(body, null)).toBe(body)
  })
  test('prepends without a status block, and $ stays literal', () => {
    expect(mergeDecision('hello\n', 'x $& $1')).toBe(`${D}\nx $& $1\n${E}\n\nhello\n`)
  })
})

test('initialBody', () => {
  const b = initialBody(job())
  expect(b).toContain('<!-- factory:status -->')
  expect(b).toContain('_Work in progress by the factory. Docs and commits land here as they are written._')
})

test('proofCoverage', () => {
  expect(proofCoverage([1, 2, 3], ['ac1.png', 'ac3-login.gif'])).toEqual([2])
  expect(proofCoverage([1, 2], ['AC2.PNG', 'ac10.png', 'ac1x.png'])).toEqual([1])
})

describe('pushProof', () => {
  test('null for an empty or missing dir, without running git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proof-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const exec = new FakeExec()
    expect(await pushProof(exec, '/r', dir, 'j', join(dir, 'idx'))).toBeNull()
    expect(await pushProof(exec, '/r', join(dir, 'nope'), 'j', join(dir, 'idx'))).toBeNull()
    expect(exec.calls).toEqual([])
  })

  test('pushes an orphan ref containing the files', async () => {
    const t = await tempRepo()
    cleanups.push(t.cleanup)
    const proof = join(t.repo, '.factory', 'jobs', 'j1', 'proof')
    await mkdir(proof, { recursive: true })
    await writeFile(join(proof, 'ac1.txt'), 'ok\n')
    const sha = await pushProof(realExec, t.repo, proof, 'j1', join(t.repo, '.factory', 'jobs', 'j1', 'proof.index'))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const ref = await realExec.run(['git', 'rev-parse', 'refs/heads/factory-proof/j1'], { cwd: t.origin })
    expect(ref.stdout.trim()).toBe(sha!)
    const show = await realExec.run(['git', 'show', `${sha}:ac1.txt`], { cwd: t.origin })
    expect(show.stdout).toBe('ok\n')
    const parents = await realExec.run(['git', 'rev-list', '--parents', '-n1', sha!], { cwd: t.origin })
    expect(parents.stdout.trim()).toBe(sha!)
  })

  test('throws on non-zero exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proof-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'a.png'), 'x')
    const exec = new FakeExec([{ match: ['git', `--work-tree=${dir}`, 'add'], result: { code: 128, stderr: 'boom\n' } }])
    await expect(pushProof(exec, '/r', dir, 'j', join(dir, 'idx'))).rejects.toThrow(/failed \(exit 128\): boom/)
  })
})
