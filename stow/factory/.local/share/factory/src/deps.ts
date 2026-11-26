import { join } from 'node:path'
import { realExec, type Exec } from './exec'
import { Git, GitHub } from './git'
import { notify } from './notify'
import { PACKAGE_DIR } from './paths'
import { InlineSpawner, TmuxSpawner, type Spawner } from './spawn'

/** Everything the driver touches outside its own job folder. Tests swap these for fakes. */
export interface Deps {
  exec: Exec
  spawner: Spawner
  git: Git
  gh: GitHub
  rolesDir: string
  notify(n: { title: string; message: string }): Promise<void>
  now(): Date
  sleep(ms: number): Promise<void>
  log(line: string): void
}

export function makeDeps(repo: string, o: { inline?: boolean } = {}): Deps {
  return {
    exec: realExec,
    spawner: o.inline ? new InlineSpawner(realExec) : new TmuxSpawner(realExec),
    git: new Git(realExec, repo),
    gh: new GitHub(realExec, repo),
    rolesDir: join(PACKAGE_DIR, 'roles'),
    notify: (n) => notify(n, realExec),
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    log: (line) => console.log(line),
  }
}
