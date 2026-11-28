import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobPaths } from '../paths'
import { ProcessSpawner } from '../spawn'
import { tempRepo } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (pred()) return true
    await Bun.sleep(50)
  }
  return pred()
}

test('an agent runs in the background, is seen alive, and is killed with its whole tree', async () => {
  const t = await tempRepo()
  cleanups.push(t.cleanup)
  const p = jobPaths(t.repo, 'j')
  for (const d of [p.runDir, p.logsDir, p.doneDir]) mkdirSync(d, { recursive: true })
  const spawner = new ProcessSpawner(t.repo)
  const req = {
    jobId: 'j', window: 'sleeper', cwd: t.repo, command: 'sleep 30', scriptFile: join(p.runDir, 'sleeper.sh'),
    logFile: join(p.logsDir, 'sleeper.log'), doneFile: join(p.doneDir, 'sleeper'), tail: null,
  }
  await spawner.start(req)
  expect(await spawner.isAlive('j', 'sleeper')).toBe(true)
  await spawner.killAgents('j')
  const dead = async () => !(await spawner.isAlive('j', 'sleeper'))
  for (const t0 = Date.now(); Date.now() - t0 < 5000 && !(await dead()); ) await Bun.sleep(50)
  expect(await dead()).toBe(true)
})

test('a quick agent leaves its exit code and is not alive afterwards', async () => {
  const t = await tempRepo()
  cleanups.push(t.cleanup)
  const p = jobPaths(t.repo, 'j')
  for (const d of [p.runDir, p.logsDir, p.doneDir]) mkdirSync(d, { recursive: true })
  const spawner = new ProcessSpawner(t.repo)
  const doneFile = join(p.doneDir, 'quick')
  await spawner.start({
    jobId: 'j', window: 'quick', cwd: t.repo, command: 'echo hi', scriptFile: join(p.runDir, 'quick.sh'),
    logFile: join(p.logsDir, 'quick.log'), doneFile, tail: null,
  })
  expect(await until(() => existsSync(doneFile))).toBe(true)
  expect(readFileSync(doneFile, 'utf8').trim()).toBe('0')
  await Bun.sleep(300)
  expect(await spawner.isAlive('j', 'quick')).toBe(false)
  writeFileSync(join(p.runDir, 'driver.pid'), 'junk')
  expect(await spawner.isAlive('j', 'driver')).toBe(false)
})
