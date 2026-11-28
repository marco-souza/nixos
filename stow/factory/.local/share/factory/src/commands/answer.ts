import { grillTurn } from '../driver'
import { isWaiting } from '../machine'
import { paint, whatFor } from '../ui'
import { ok, printNext, restartDriver, findJob, type Args, type Cli } from './shared'

/**
 * Runs one grill turn and prints what comes next: the next question, or (grill over) the driver taking the job on.
 * The orchestrator relays the question to the human and the answer back; nobody opens another session.
 */
export async function relayGrill(repo: string, id: string, cli: Cli, answer: string | null): Promise<void> {
  const r = await grillTurn(repo, id, cli.deps(repo, { inline: true }), answer)
  if (r.kind === 'question') {
    cli.out(`QUESTION for ${id}:\n\n${r.text}\n\nnext: factory answer ${id} -- "<the human's answer>"`)
    return
  }
  if (isWaiting(r.job)) {
    // Preflight stopped it (a missing access). `!` marks a line the relaying agent must pass on.
    cli.out(paint('yellow', `! requirements written, but ${id} stopped: ${whatFor(r.job)}`))
  } else {
    await restartDriver(r.job, cli.deps(repo))
    cli.out(ok(`requirements written; the driver goes on with ${r.job.stage} in the background`))
  }
  printNext(r.job, cli)
}

export async function answerCommand(args: Args, cli: Cli, repo: string): Promise<void> {
  const [id, ...words] = args.pos
  findJob(repo, id!)
  await relayGrill(repo, id!, cli, words.length ? words.join(' ') : null)
}
