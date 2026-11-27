# factory

One job per feature. `factory new "<feature>"` opens a requirements grill, then
agent roles do tech discovery, design, planning, build, review and validation
in a git worktree, and the driver opens a PR. PR comments start a new cycle.
A job the grill settles as `Deliverable: report` (an audit, an analysis, a
filled-in sheet) skips all that: one `reporter` agent does the work and writes
`.factory/jobs/<job>/report.md`, with no PR.
Bun + TypeScript, no runtime dependencies. Linked into `~/.local/bin/factory`
by `./stow.sh stow factory`.

## Commands

Every command takes `--repo <path>`, which must be a main checkout: jobs live
there and read its `.factory.json`, so `--repo` refuses a linked worktree.

Lines starting `!` are warnings for whoever relays the output. A running agent
logs a heartbeat every 30 s (`… <job>: <role> running 2m30s, last: <tool>`).

- `factory new "<feature>" [--base <branch> | --stack <PR#>]`: start a job;
  prints the first grill question. `--base` starts the job from that branch,
  `--stack` from an open PR's branch; either way its PR targets it and the
  rebase stage rebases onto it. The base is stored in the job, so it never
  changes under a running job
- `factory answer <id> [<text>…]`: answer the pending grill question; prints the next one, or
  starts the driver when the requirements are written
- `factory status [<id>] [--json]`: every job and what it needs; or one job
- `factory logs <id> [<role>] [-f]`: an agent's log (default: the latest)
- `factory approve <id>`: accept the PR, or an escalation, and go on
- `factory feedback <id> [<note>…]`: send new PR comments and a note; new cycle
- `factory unblock <id> <decision>…`: settle what a failed or blocked step
  stopped on: the decision goes to `decision-<k>.md`, the step runs again with
  it, and every later agent reads it. Same cycle and trip
- `factory run <id> [--inline]`: (re)start the job's driver in the background
  and return; retries a failed step. `--inline` drives it in this terminal
  instead
- `factory discard <id> [--yes]`: close the PR, delete the branch, its proof
  branch and the worktree, and move the job folder to `.factory/archive/`, so
  the id is free again; asks first, and refuses without `--yes` when there is
  no terminal to ask on
- `factory dashboard [--port <n>]`: serve the dashboard on 127.0.0.1 (port 8000)

## Configuring a repo

Optional `.factory.json` in the repo root, merged over `config.json` in this
folder (objects merge, arrays and scalars replace). Keys: `base` (default:
origin's default branch), `prTitle`, `setup`
(commands run in a fresh worktree), `docs` (`requirements`, `techDiscovery`,
`design`, `specs`, `testPlans`), `hooks` (`prOpened`, `qaUrl`, `qaReady`),
`validators` (`e2e`, `user`, `load`, `capacity`), `roles` (per-role `harness`,
`tier`, `timeoutMin`), `defaultHarness`, `models`, `timeoutsMin`, `maxTrips`,
`maxDiscoveryLoops`, `qaReadyTimeoutMin`, `qaPollSec`, `docsCommitType`.

`prTitle` is a PR title template with `{type}` and `{ticket}` (from the
branch and the request) and `{summary}` (the requirements doc's title, then the
summarizer's). An empty placeholder goes with the brackets around it. Unset,
the summarizer titles the PR by the repo's own PR rules.

```json
{
  "prTitle": "[{type}][{ticket}] {summary}",
  "setup": ["bun install"],
  "validators": ["e2e", "user"],
  "roles": { "builder-frontend": { "tier": "high" } }
}
```

Everything repo-specific comes from the repo's `AGENTS.md` (or `CLAUDE.md`),
which roles read first. It should say:

- how to set up the repo and start the dev server
- the validation commands (tests, build, lint) and how to run the e2e suite
- a `## Blueprint` section (or point to the doc) with the architecture builders follow
- PR rules: title format, commit types, what the PR body needs
- load thresholds, if `load` or `capacity` validators are enabled

## State

In the target repo, under `.factory/` (git-excluded): `.factory/<job>/` is the
job's worktree, and `.factory/jobs/<job>/` holds the job state, activity log,
agent logs, reviews and `pr.md`. Each job's driver and agents are background
processes (pid files in `run/`, driver output in `logs/driver.log`). The grill is
headless turns, one question each, in `grill/` (a transcript and the pending
question); whoever drives the CLI relays them to you, so you never leave that
chat. `factory new` asks the default harness's low-tier model to name
the branch: the repo's convention if its instructions give one, otherwise
`<type>/<TICKET>/<brief-name>` (`fix/WEB-123/raise-cache-timeout`, or
`fix/raise-cache-timeout` when the request names no ticket), all lowercase but
the ticket key. The job id is the branch without its type
(`web-123-raise-cache-timeout`). v1 jobs are ignored; delete their folders by
hand.

The requirements doc lists the access the job needs (MCP connectors, logins,
CLIs, accounts) under `## Access`. Right after the grill, the `preflight` stage
has the `access-checker` agent try each one, results in `access.md` and in
`factory status <job>`, and stops the job before any PR or long work when one
is missing.

## Roles

`roles/*.md`: one prompt per role (`requirements`, `access-checker`, `planner`,
`builder-<specialist>`, `reviewer-<lens>`, `validator-<kind>`, judges, `summarizer`,
`reporter`, …). `_common.md` and
`_builder.md` are shared preambles. Role files hold nothing repo-specific.

Claude roles inherit your MCP servers (tickets, Slack, docs), so the grill and the
research roles can read what the request points to; `--permission-mode auto`
gates what they may change. Browser roles (`browser: true`) always run on
claude, whatever the harness, with the Playwright server in
`mcp/playwright.json` added, started with `npx`, so they need node on the PATH.

## Tests

```sh
bun test
```

Run from this folder. For a look at the dashboard with fake data:
`bun src/__tests__/fixtures/seed-demo.ts <dir>`, then
`bun src/__tests__/fixtures/serve-demo.ts`.
