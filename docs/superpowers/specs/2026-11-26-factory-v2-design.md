# Factory v2 design

Date: 2026-11-26. Source diagram: tldraw "Factory v2" (Discovery → Building →
Validation → Deploy).

## Intent

The factory turns a feature request into a reviewed, validated pull request
with as little human time as possible. v1 works, but:

- the whole loop is a 666-line prose state machine (`skills/factory/SKILL.md`)
  that one LLM session follows, and it drifts (skipped steps, miscounted
  rounds, clobbered `job.json`);
- it exists twice, once for Claude Code and once for pi, and every change has
  to be made in both;
- nothing tests the code against a deployed environment before the human sees
  it;
- the human sees nothing until the end, when the PR opens.

v2 adds a Validation stage, opens the PR at the start so the work is visible
while it happens, keeps durable docs in the repo, and replaces the prose state
machine with code.

## Goals

- The flow from the diagram: Discovery (requirements → tech discovery → design
  doc → AI review), Building (planning → build → review → AI judge),
  Validation (test plan → validators → AI judge), Deploy (human review → ready
  PR + summary).
- A draft PR assigned to the human from the first commit. Every step pushes
  small commits to it.
- Durable docs committed on the job branch under `docs/` (they reach `main`
  when the PR merges).
- One deterministic orchestrator, written in TypeScript and covered by
  `bun test`.
- Every agent runs as its own `claude` or `pi` process in a tmux window that
  the human can attach to. Harness and model are chosen per role.
- One copy of every role prompt, whatever harness runs it.
- Crash-safe: all state is on disk, and `factory run <job>` resumes a job.

## Non-goals

- Merging. The human merges; the factory never pushes `main` or merges.
- Team review tracking (v1's `sync.py`, two teammate approvals, `merge-ready`).
- A separate prototype step.
- Parallel builders on one job. Builders run one at a time on the job branch.
- Changing `task-pipeline`. It stays as it is; v2 borrows its tmux and marker
  approach.

## Anti-goals

- The orchestrator making judgment calls. Anything that needs judgment is an
  agent's output file that the orchestrator reads.
- Repo-specific logic in the factory. It lives in the repo's `AGENTS.md` and
  `.factory.json`.
- Agents pushing, opening PRs or touching `main`. Only the orchestrator talks
  to the remote.

## Approaches considered

**How agents run** (decided by the human: B)

- A. Stage orchestrators in tmux, native subagents inside. Nesting works, but
  in-stage logic stays written twice (Claude and pi).
- **B. Every agent is a tmux process started by one launcher.** One role file
  per agent, harness and model per role, everything attachable. Costs a
  launcher and a few seconds of startup per agent.
- Flat, main session spawns everything (v1). Dropped: no nesting, one session's
  context grows over the whole job.

**Who orchestrates** (decided by the human: code)

- LLM orchestrators. Flexible, and flow changes are prose edits. But they cost
  tokens on bookkeeping, drift, can't be unit-tested and don't repeat.
- **Code orchestrator.** A TS state machine owns stages, gates, caps, `job.json`,
  git pushes and spawns. Deterministic, tested, resumable, zero routing tokens.
  Flow changes need code; routing judgment moves into agents' output files.

## Decided by the human

- Workspace in `<repo>/.factory/`, not `../<name>-factory/` (already true since
  `2926515`).
- The draft PR opens as soon as work on the request starts, assigned to the
  human. Small commits are pushed to it throughout.
- Opening the PR runs the repo's step that assigns a free QA env. After that,
  every push deploys to QA. The factory just keeps pushing.
- Every "no" (discovery review excluded, see below) goes back to Planning,
  including the human's. The human can discard a job at any time: that closes
  the PR and deletes the branch and worktree.
- User validation is an agent playing the user, with Playwright or the browser
  extension depending on the work.
- Docs live in the repo: `docs/tech-discovery/`, `docs/design-docs/`,
  `docs/specs/`, and so on, one folder per step.
- Agents run via tmux + `claude`/`pi` instances (approach B), driven by a code
  orchestrator.
- Accepted proposals: no prototype step, no team review tracking, one doc file
  per job per folder, a cap of 3 trips back to Planning.
- Both judges can ESCALATE to the human, and the validation judge can say ENV
  for environment failures, which retry without spending a trip.
- The discovery review can send work back without the human (REWORK) and
  asks the human only for questions that are theirs (ASK).

## The flow

```
factory new "<feature>"
  requirements (interactive, human)  → docs/requirements/<job>.md, first commit
      → push, open draft PR, run hook prOpened
  tech-discovery                     → docs/tech-discovery/<job>.md
  design                             → docs/design-docs/<job>.md
  discovery-review (AI) ─ ASK ────→ requirements (only the human's questions)
                        ├ REWORK ─→ tech-discovery or design (reviewer's notes, no human)
                        └ PASS
  ┌→ planning                        → docs/specs/<job>.md (tasks, specialists, lenses)
  │  build: one builder per task, in order, push after each
  │  review: the plan's lenses, in parallel
  │  build-judge (AI) ─ CHANGES ──────────────┐
  │                   ├ ESCALATE → pause for the human (see below)
  │                   └ APPROVE               │
  │  test-planning                   → docs/test-plans/<job>.md (cases, validators)
  │  rebase on origin/main, push; wait for hook qaReady
  │  validation: the plan's validators, in parallel
  │  validation-judge (AI) ─ FAIL ────────────┤
  │                        ├ ENV → wait for qaReady, re-run validation once (no trip), then pause
  │                        ├ ESCALATE → pause for the human
  │                        └ PASS             │
  │  human-review: notify with the PR link    │
  │     factory feedback ─────────────────────┤
  │     factory approve                       │
  │  finalize: summarizer writes the PR body, gh pr ready → done
  └───────────────────────────────────────────┘ (trip + 1)
```

- A **trip** is one pass from Planning onward. `MAX_TRIPS = 3` per cycle. A
  fourth trip goes to `needs-human` instead.
- A **cycle** starts with the job and with every `factory feedback`. Feedback
  resets the trip count (my call, as v1 does with rounds).
- `MAX_DISCOVERY_LOOPS = 3`: ASK and REWORK together send the job back at
  most twice. A third non-PASS sends the job to `needs-human`.
- A discovery "no" never goes to Planning: it means the docs don't match what
  the human asked for (ASK) or don't fit the repo (REWORK). The reviewer says
  ASK only for questions only the human can answer, and REWORK names the step
  to redo. The designer can also raise a human-only question, including a real
  design choice, under `## Questions for the human`; the driver then takes the
  ASK path without running the reviewer. That also counts toward the cap.
- **ESCALATE** (either judge) is for what re-planning can't fix: a product
  decision only the human can make, or a risky change (auth, payments,
  migrations, deploy config, a new dependency, a new pattern or a deviation
  from the blueprint). The job pauses in `needs-human` with
  `waitingFor: "escalation"`, the judge's questions go to the top of the draft
  PR body, and the human is notified. `factory feedback` answers it (→
  Planning, new cycle); `factory approve` goes on as if the judge had
  approved. ESCALATE spends no trip.
- **ENV** (validation judge) is for failures of the environment, not the code:
  QA down, a broken deploy, flaky infra. The driver waits for `qaReady` again
  and re-runs validation once without spending a trip. A second ENV pauses the
  job in `needs-human` with the validators' evidence.
- `factory discard <job>` works in any stage.

### Human touchpoints

1. **Requirements.** An interactive `claude`/`pi` window where the
   requirements agent grills the human. `factory new` switches the human's
   tmux client to that window when run inside tmux, and prints the attach
   command otherwise.
2. **Discovery ASK.** When the discovery reviewer or the designer has a
   question only the human can answer (including a real design choice), the
   job goes back to requirements with just those questions, and the human is
   notified.
3. **Escalation.** A judge's ESCALATE, or a second ENV, pauses the job for
   the human (see above).
4. **Human review.** Notified with the PR link. Answers with `factory approve`
   or `factory feedback [note]` (PR comments are collected too).
5. **Any time.** `factory discard`, or reading the draft PR and docs as they
   land.

This replaces my earlier call that design options get picked "during the
grill": the grill runs before the design exists, so a design choice that is
the human's goes through touchpoint 2 instead.

## Architecture

### Package

A new stow package, `stow/factory/`, mirroring `$HOME`:

```
stow/factory/.local/bin/factory                 shim: exec bun ~/.local/share/factory/src/cli.ts "$@"
stow/factory/.local/share/factory/package.json
stow/factory/.local/share/factory/src/          cli, state machine, launcher, harness adapters, git/gh, notify
stow/factory/.local/share/factory/src/__tests__/
stow/factory/.local/share/factory/roles/*.md    one file per agent role
stow/factory/.local/share/factory/config.json   default harness and model tier per role
stow/factory/.local/share/factory/dashboard.html
```

Bun only, no runtime dependencies. `bun` and `tmux` are already in
`modules/shared/default.nix`. `~/.local/bin` is on `PATH` on macOS; the
builder makes sure it is on NixOS too (zsh config).

### CLI

| Command                          | Does                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `factory new "<feature>"`        | create job, worktree, tmux session `factory-<job>`, start the driver |
| `factory run <job>`              | run or resume the state machine from `job.json` (idempotent)        |
| `factory approve <job>`          | human-review → finalize                                              |
| `factory feedback <job> [note]`  | collect new PR comments + note into `feedback-<k>.md`, new cycle → planning |
| `factory discard <job>`          | kill the tmux session, close the PR, delete remote and local branch, remove the worktree, stage `discarded` |
| `factory status [<job>]`         | one line per job: stage, trip, what it waits for                     |
| `factory dashboard [port]`       | serve `.factory/` on localhost (the board reads `job.json`)          |
| `factory attach <job>`           | attach to the job's tmux session                                     |

All commands run from anywhere inside the repo and resolve the main checkout
with `git rev-parse --git-common-dir`.

Command rules (my calls):

- `factory run` on a `needs-human` job retries the step that failed. When the
  cause was the trip cap, it grants one more trip.
- `factory approve` means "accept what is there and go on". In `human-review`
  it finalizes a ready PR. In an escalation pause it goes on to the next stage
  as if the judge had approved. In any other `needs-human` it finalizes a
  draft PR whose body opens with the reason the job stopped (v1's
  `/factory ship`).
- `factory feedback` works in every stage but `discarded`. It kills the job's
  running agents first. It goes to Planning once a plan exists, and to
  requirements before that (so a job stuck at the discovery cap can still be
  steered). On a `done` job it turns the PR back into a draft while the new
  cycle runs.
- When feedback changes what the human wants, the planner also amends
  `docs/requirements/<job>.md` and `docs/design-docs/<job>.md`, adding a line
  that names the feedback file, so the docs that merge describe what was built.

### Job IDs

`<YYMMDD>-<slug>` (e.g. `261126-rate-limiting`), because the ID ends up in
durable paths on `main` and in branch names on the shared remote, where v1's
local numbering would collide across machines and teammates. Before claiming
one, the driver checks `.factory/jobs/`, `git ls-remote origin
'refs/heads/factory/*'` and `docs/requirements/`, and appends `-2`, `-3` on a
clash. Dev server ports come from a slot the driver allocates locally, not
from the ID (my call).

### Roles and the launcher

A role file has neutral frontmatter and a harness-neutral prompt body:

```yaml
---
name: reviewer-code
description: Reviews the branch for correctness, simplicity and conventions.
tools: [read, grep, glob, bash, write]   # neutral names
browser: false                           # true adds the browser tools
interactive: false                       # true: TUI session the human talks to
tier: high                               # high | medium | low, mapped per harness in config
output: trip-{trip}/review-code.md       # the file the driver checks
---
<prompt body>
```

`factory` launches a role as:

- **claude:** `claude -p "<task prompt>" --append-system-prompt "<body>"
  --model <tier model> --allowedTools <mapped tools> --permission-mode auto`
- **pi:** `pi -p "<task prompt>" --append-system-prompt <body file> --model
  <tier model> --tools <mapped tools>`

Interactive roles drop `-p`. Each process runs in its own window of
`factory-<job>`, in the job's worktree, and the window shows readable live
progress (the builder picks how: a stream-json pretty-printer, `--mode json`
for pi). The driver knows a role is done from its exit status plus a
`.done/<role>-<n>` marker it writes after the process exits. An interactive
role is done when its output file and marker exist; the driver then closes the
window.

Harness and tier per role come from `config.json`, overridden by the repo's
`.factory.json`. Default: every role on claude; browser roles always on claude
(pi's browser bridge is one shared browser and can't save screenshots).

Separate processes give every browser role its own Playwright instance, so
reviewers and validators that open pages run in parallel. That removes v1's
one-browser-at-a-time rule.

### Roles

| Role                  | From v1                  | Stage            | Writes                                     |
| --------------------- | ------------------------ | ---------------- | ------------------------------------------ |
| `requirements`        | discoverer (grill part)  | requirements     | `docs/requirements/<job>.md`               |
| `tech-discoverer`     | discoverer (repo part)   | tech-discovery   | `docs/tech-discovery/<job>.md`             |
| `designer`            | new                      | design           | `docs/design-docs/<job>.md`                |
| `discovery-reviewer`  | new                      | discovery-review | `discovery-review-<n>.md` (PASS / REWORK + step / ASK + questions) |
| `planner`             | spec-writer              | planning         | `docs/specs/<job>.md`                      |
| `builder-<specialist>`| builders + `builder.md`  | build            | commits, `trip-<t>/build.md`, `proof/`     |
| `reviewer-<lens>`     | reviewers                | review           | `trip-<t>/review-<lens>.md`                |
| `build-judge`         | judge                    | build-judge      | `trip-<t>/build-judge.md` (APPROVE / CHANGES / ESCALATE) |
| `test-planner`        | new                      | test-planning    | `docs/test-plans/<job>.md`                 |
| `validator-<kind>`    | new: e2e, user, load, capacity | validation | `trip-<t>/validation-<kind>.md`, `proof/` |
| `validation-judge`    | new                      | validation-judge | `trip-<t>/validation-judge.md` (PASS / FAIL / ENV / ESCALATE) |
| `resolver`            | shipper                  | rebase (conflicts only) | commits, `trip-<t>/rebase.md`       |
| `summarizer`          | v1 orchestrator's pr.md  | finalize         | `pr.md`                                    |

Paths without `docs/` are in `.factory/jobs/<job>/`. The planner names the
review lenses (from product, security, code, ux, ui) and the test planner names
the validators; the driver spawns exactly those. Lens and validator names the
driver doesn't know fail the handoff check.

Validators (my call): `e2e` and `user` are built now. `load` and `capacity`
are opt-in: the test planner may only pick validators listed in
`.factory.json` `validators` (default `["e2e", "user"]`), so nothing
load-tests a shared QA env unless the repo says so. When a repo opts in, the
tool, target and pass/fail thresholds come from its `AGENTS.md`, and a
validator with no thresholds there writes FAIL with the reason instead of
guessing. Their role files can come in a later phase.

Every role file keeps v1's rules that still apply (blueprint, no band-aids,
proof per acceptance criterion, read `AGENTS.md` first), rewritten without
harness-specific tool names.

### Commits and pushes

- Agents commit their own work in the worktree. The driver commits the docs an
  agent wrote (`docs: <stage> for <job>`), using the repo's commit convention.
- Only the driver pushes: after every agent that produced commits. The
  rebase step force-pushes with `--force-with-lease`.
- The driver keeps a status checklist at the top of the PR body (stage, trip,
  verdicts so far), updated on every transition (my call).
- The first push needs a commit: the requirements doc is the first commit, so
  the draft PR opens right after the grill.

### Repo config: `.factory.json`

Committed at the repo root. Everything optional:

```json
{
  "base": "main",
  "setup": ["npm ci"],
  "docs": { "requirements": "docs/requirements", "techDiscovery": "docs/tech-discovery",
            "design": "docs/design-docs", "specs": "docs/specs", "testPlans": "docs/test-plans" },
  "hooks": {
    "prOpened": "./scripts/qa-assign.sh",
    "qaUrl": "./scripts/qa-url.sh",
    "qaReady": "./scripts/qa-ready.sh"
  },
  "validators": ["e2e", "user"],
  "roles": { "reviewer-security": { "harness": "pi", "tier": "high" } }
}
```

Hooks are shell commands run in the worktree with `JOB`, `PR`, `BRANCH` and
`SHA` in the environment. `qaUrl` prints the env URL, which validators and
browser reviewers get in their prompt. `qaReady` exits 0 once the deploy of
`SHA` is live; the driver polls it with a timeout. Without hooks, validators
and browser reviewers use a local dev server started the way `AGENTS.md` says,
on v1's port scheme (`5100 + 10n` and up).

Prose instructions (how to run tests, the blueprint, PR rules) stay in
`AGENTS.md`. `.factory.json` holds only what the driver itself needs.

### State: `.factory/`

Excluded locally through `.git/info/exclude`, as in v1:

```
.factory/jobs/<job>/job.json               state, written only by the driver
.factory/jobs/<job>/activity.log           one line per spawn/finish/transition
.factory/jobs/<job>/discovery-review-<n>.md
.factory/jobs/<job>/trip-<t>/              build.md, review-*.md, build-judge.md, validation-*.md, validation-judge.md, rebase.md
.factory/jobs/<job>/feedback-<k>.md
.factory/jobs/<job>/proof/
.factory/jobs/<job>/logs/<role>-<n>.log    each agent's raw output
.factory/jobs/<job>/.done/
.factory/jobs/<job>/pr.md
.factory/<job>/                            the worktree, on factory/<job>
```

`job.json` gets a new schema (stages above, `cycle`, `trip`, `pr`, `qaUrl`,
per-trip verdicts, `waitingFor`). The driver writes it atomically (write to a
temp file, then rename). The dashboard is updated to the new stages, with a
"Needs you" lane for `requirements`, `human-review` and `needs-human`.

### Handoff checks, retries, timeouts

The driver checks each output file the way v1's handoff checks did (first line
verdict, required sections). On a missing or invalid file, or a non-zero exit,
it re-runs the role once with the same prompt; on a second failure the job
goes to `needs-human` with the reason. Each role has a timeout (default from
its tier, overridable in config); a timed-out process is killed and counts as
a failure.

### Notifications

When a job starts waiting on the human: `osascript` on macOS, `notify-send`
on Linux, `tmux display-message`, and the dashboard lane. One line also goes
to the driver window.

### Proof

v1's approach stays: builders and validators write `proof/ac<k>…` files, the
driver pushes `proof/` to an orphan `factory-proof/<job>` branch, and the
summarizer embeds the raw URLs in `pr.md`. A ready PR needs proof for every
acceptance criterion; otherwise finalize leaves it as a draft and lists the
gaps.

## What goes away

- `stow/claude/.claude/skills/factory/` becomes a thin skill: `/factory …`
  runs the matching `factory …` command and reports its output. `builder.md`,
  `sync.py` and `dashboard.html` go.
- `stow/claude/.claude/agents/factory-*.md` and
  `stow/pi/.pi/agent/agents/factory-*.md`: replaced by `roles/`.
- `stow/pi/.pi/agent/extensions/factory/`: replaced by a thin pi skill or
  extension that calls the CLI.
- `AGENTS.md`: the two-copy sync rule goes. Layout and validation tables gain
  `stow/factory` (`bun test`). `README.md`'s stow table gains `factory`.
- The prototyper role and the team-review flow are dropped.

## Constraints

- Agents must never run `./stow.sh` or `make switch` (repo rule); the human
  stows `factory` after merge.
- Factory files stay free of repo-specific content.
- Headless claude runs in `--permission-mode auto`. pi has no permission
  system, only the tool allowlist, so a role on pi can run any shell command
  its `bash` tool allows.
- Existing v1 jobs in `.factory/jobs/` must not crash the driver or the
  dashboard. They show as legacy and are never moved.

## Left to the builder

- How the tmux window renders live progress, and the exact marker protocol.
- `job.json` field names beyond the ones above, and the dashboard rework.
- Whether the driver stays running while it waits on the human or exits and
  is relaunched by `approve`/`feedback`, as long as resume works from disk.
- Default timeouts and the tier → model map.
- Phasing. A sensible order: CLI core and launcher with the Building stage on
  ported roles, then Discovery, then Validation, then dashboard and wrappers.
