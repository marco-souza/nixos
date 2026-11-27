# factory

One job per feature. `factory new "<feature>"` opens a requirements grill, then
agent roles do tech discovery, design, planning, build, review and validation
in a git worktree, and the driver opens a PR. PR comments start a new cycle.
Bun + TypeScript, no runtime dependencies. Linked into `~/.local/bin/factory`
by `./stow.sh stow factory`.

## Commands

Every command takes `--repo <path>`.

- `factory new "<feature>" [--no-attach]`: start a job and answer its grill
- `factory status [<id>] [--json]`: every job and what it needs; or one job
- `factory attach <id>`: open the job's tmux session
- `factory logs <id> [<role>] [-f]`: an agent's log (default: the latest)
- `factory approve <id>`: accept the PR, or an escalation, and go on
- `factory feedback <id> [<note>…]`: send new PR comments and a note; new cycle
- `factory run <id> [--inline]`: (re)start the job's driver in its tmux session
  and return; retries a failed step. `--inline` drives it in this terminal
  instead, without tmux
- `factory discard <id> [--yes]`: close the PR, delete the branch and worktree
- `factory dashboard [--port <n>]`: serve the dashboard on 127.0.0.1 (port 8000)

## Configuring a repo

Optional `.factory.json` in the repo root, merged over `config.json` in this
folder (objects merge, arrays and scalars replace). Keys: `base`, `setup`
(commands run in a fresh worktree), `docs` (`requirements`, `techDiscovery`,
`design`, `specs`, `testPlans`), `hooks` (`prOpened`, `qaUrl`, `qaReady`),
`validators` (`e2e`, `user`, `load`, `capacity`), `roles` (per-role `harness`,
`tier`, `timeoutMin`), `defaultHarness`, `models`, `timeoutsMin`, `maxTrips`,
`maxDiscoveryLoops`, `qaReadyTimeoutMin`, `qaPollSec`, `docsCommitType`.

```json
{
  "base": "main",
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
job's worktree on branch `factory/<job>`, and `.factory/jobs/<job>/` holds the
job state, activity log, agent logs, reviews and `pr.md`. Each job runs in the
tmux session `factory-<job>`. Job ids look like `261126-rate-limit`. Jobs from
the v1 skill show as legacy and are never driven.

## Roles

`roles/*.md`: one prompt per role (`requirements`, `planner`, `builder-<specialist>`,
`reviewer-<lens>`, `validator-<kind>`, judges, `summarizer`, …). `_common.md` and
`_builder.md` are shared preambles. Role files hold nothing repo-specific.

Claude roles see only the MCP servers the factory gives them, never yours.
Browser roles (`browser: true`) run on claude with the Playwright server in
`mcp/playwright.json`, started with `npx`, so they need node on the PATH.

## Tests

```sh
bun test
```

Run from this folder. For a look at the dashboard with fake data:
`bun src/__tests__/fixtures/seed-demo.ts <dir>`, then
`bun src/__tests__/fixtures/serve-demo.ts`.
