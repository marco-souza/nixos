#!/usr/bin/env bun
/**
 * Serves the dashboard on a seeded demo repo with fake deps: the actions run the real command cores,
 * but tmux, git, gh and notifications are fakes, so nothing is launched, pushed or closed.
 *
 *   bun src/__tests__/fixtures/serve-demo.ts /tmp/factory-demo [port]
 *
 * Every call that would have reached the outside is printed.
 */
import { resolve } from 'node:path'
import type { Deps } from '../../deps'
import { Git, GitHub } from '../../git'
import { startServer } from '../../server'
import type { Spawner } from '../../spawn'
import { FakeExec } from '../helpers'

const print = (...call: string[]) => console.log(`fake: ${call.join(' ')}`)

/** Records the call and does nothing. */
const spawner: Spawner = {
  ensureSession: async (jobId) => print('ensureSession', jobId),
  start: async (req) => print('start', req.jobId, req.window),
  isAlive: async () => false,
  kill: async (jobId, window) => print('kill', jobId, window),
  killAgents: async (jobId) => print('killAgents', jobId),
  killSession: async (jobId) => print('killSession', jobId),
  respawnDriver: async (jobId) => print('respawnDriver', jobId),
}

/** git and gh succeed with empty output. */
class PrintingExec extends FakeExec {
  override async run(cmd: string[]) {
    print(...cmd)
    return super.run(cmd)
  }
}

const dir = process.argv[2]
if (!dir) {
  console.error('usage: bun src/__tests__/fixtures/serve-demo.ts <dir> [port]')
  process.exit(2)
}
const repo = resolve(dir)
const exec = new PrintingExec()
const deps: Deps = {
  exec,
  spawner,
  git: new Git(exec, repo),
  gh: new GitHub(exec, repo),
  rolesDir: '',
  notify: async (n) => print('notify', n.title),
  now: () => new Date(),
  sleep: async () => {},
  log: (line) => console.log(line),
}
const server = startServer(repo, deps, { port: Number(process.argv[3] ?? 8123) })
console.log(`Factory demo dashboard: http://127.0.0.1:${server.port}`)
