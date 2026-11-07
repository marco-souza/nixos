---
name: factory
description: Run the software factory in the current repo. Use when the user types /skill:factory or /factory <feature>, /factory next [<n>], /factory approve <job-id>, /factory rework <job-id> <note>, or /factory dashboard. The session that runs it becomes the orchestrator of the spec → build → review → approve loop, which merges into main locally.
---

# Factory

You are the orchestrator for the job or jobs your session started or was
handed. You run the loop below for each of them, spawn every agent, and are the
only writer of each of those jobs' `job.json`. You never write code, specs,
reviews or decisions yourself. Agents do the work and each writes one file; you
move each job along and keep its `job.json` current.

Adapted from zazencodes' software-factory-claude-code (v1, local merge, no PRs).
This is the pi port of `~/.claude/skills/factory`; keep the two in sync.

## Spawning agents

Agents run through the `subagent` tool (pi's bundled subagent extension), each
in its own `pi` process, defined in `~/.pi/agent/agents/factory-*.md`. Always
pass `cwd: <worktree>` once the worktree exists.

- One agent: `{ agent, task, cwd }`.
- Several in parallel: `{ tasks: [{ agent, task, cwd }, ...] }`.

If the `subagent` tool is missing, stop and tell the user to enable the
extension in `~/.pi/agent/settings.json`. pi agents can't be resumed, so each
build round starts a fresh `factory-builder` that reads its history from files.

## The loop

```
feature → spec-writer → builder → [security, code, ux → ui] → WAIT FOR ALL
                           ▲                                      │
                           └──── any CHANGES: rerun builder ◄─────┤
                                                                  ▼ all PASS
                                     merge to main ◄─ APPROVE ─ approver ─ ESCALATE → needs-human
```

| Step    | Agent (`subagent` name)     | Writes                                     |
| ------- | --------------------------- | ------------------------------------------ |
| spec    | `factory-spec-writer`       | `spec.md`                                  |
| build   | `factory-builder`           | `build.md` + commits on `factory/<job-id>` |
| review  | `factory-reviewer-security` | `round-N/review-security.md`               |
|         | `factory-reviewer-code`     | `round-N/review-code.md`                   |
|         | `factory-reviewer-ux`       | `round-N/review-ux.md`                     |
|         | `factory-reviewer-ui`       | `round-N/review-ui.md`                     |
| approve | `factory-approver`          | `decision.md`                              |

`MAX_REBUILDS = 2`: after round 1 the builder can be rerun at most twice, so a
run has at most 3 review rounds. To change the factory, edit this file and the
`factory-*` agents in `~/.pi/agent/agents/` (in the nixos repo,
`stow/pi/.pi/agent/`).

Every agent reads `AGENTS.md` (or `CLAUDE.md`) for the repo's setup, dev server,
validation commands and conventions. Nothing repo-specific lives in these files.
If the repo has neither, or it doesn't say how to run the validation commands,
tell the user before starting a job: the agents will guess.

## Browser

Pages are checked with the pi-browser-bridge `browser_*` tools when they are
loaded; each agent opens its own tab. To keep the shared browser calm, the
builder runs alone and `factory-reviewer-ui` starts only after
`factory-reviewer-ux` has finished. Without the bridge, the agents review from
code and say so.

## Parallel jobs

Every job runs in its own git worktree on its own branch, so several jobs can run
at once, in one pi session or across several. Your session orchestrates the
job or jobs it started or was handed, and is the only writer of each of those
jobs' `job.json`.

- Each job follows the loop independently. One job's CHANGES, BLOCKED, ESCALATE
  or failure never stops or changes another job: a job that stops for a human
  goes to **Needs human** while the others continue.
- Jobs are created one after another (steps 1 and 2 of **/factory <feature>**),
  so their numbers and worktrees never collide. Once created, they advance
  concurrently.
- When your session drives more than one job, advance them in waves. A wave is
  one parallel `subagent` call holding the next step of every job that has one
  (for example the spec-writer of one job, the three first reviewers of another,
  the builder of a third), each task with its own job's `cwd`. A wave with more
  than 8 tasks is split into consecutive calls. After each call, process every
  returned task with the rules of its job (**Build check**, verdicts into
  `job.json`, Decide), then start the next wave. Inside one job the order stays
  the same: the builder alone, then the three reviewers, then
  `factory-reviewer-ui`.
- Your session stays in the main checkout. Agents work in the job's worktree.
  The main checkout is the user's, and it may be dirty or on another branch.
  Only **Merge** touches it.
- Job state lives in `factory/jobs/<job-id>/` in the main checkout, never in a
  worktree. Each job has its own `job.json`, so sessions never write the same
  file.
- Each job gets its own dev server ports (see **Prompts**).
- Merges happen one job at a time (see **Merge**).

## Files

`<repo>` is the main checkout (`git rev-parse --show-toplevel` from your
session) and `<name>` is its folder name. The whole `factory/` folder is
excluded locally through `.git/info/exclude`: it is runtime state that never
lands in a commit and never changes the repo's `.gitignore`.

```
<repo>/factory/dashboard.html                  the board (copied from this skill)
<repo>/factory/backlog.md                      queue for /factory next
<repo>/factory/jobs/<job-id>/job.json          the job's state (you write it, the dashboard reads it)
<repo>/factory/jobs/<job-id>/spec.md
<repo>/factory/jobs/<job-id>/build.md
<repo>/factory/jobs/<job-id>/rework-<k>.md     written by you, from /factory rework
<repo>/factory/jobs/<job-id>/round-<N>/review-{security,ux,ui,code}.md
<repo>/factory/jobs/<job-id>/decision.md
<repo>/../<name>-factory/<job-id>/             the job's worktree, on factory/<job-id>
```

### Bootstrap

Before any command, from `<repo>`:

1. If `/factory/` isn't a line in `.git/info/exclude` (use
   `git rev-parse --git-path info/exclude`), append it.
2. If `factory/dashboard.html` is missing, `mkdir -p factory/jobs` and copy
   `~/.pi/agent/skills/factory/dashboard.html` there. If `factory/backlog.md` is
   missing, write:
   ```markdown
   # Backlog

   `/factory next` builds the first unchecked item and checks it off with its job id.

   ```
   On this first setup, tell the user the dashboard command (see
   **/factory dashboard**).

### job.json

```json
{ "id": "003-rate-limiting", "feature": "Rate limit the signup form",
  "branch": "factory/003-rate-limiting",
  "worktree": "/home/you/code/my-app-factory/003-rate-limiting",
  "stage": "review", "round": 2,
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" } }
```

- `stage` is one of `spec`, `build`, `review`, `approve`, `merged`,
  `needs-human`. Worktree setup counts as `spec`.
- `round` is the current review round (0 until the first round starts).
- `reviews` holds the current round only. Each value is `pending`, `PASS` or
  `CHANGES`. Earlier rounds live in their `round-<N>/` folders, which the
  dashboard reads directly.
- Rewrite the whole file on every change. `worktree` is always an absolute path.
  The dashboard depends on these exact keys and values: don't rename them.

### Prompts

Every agent task starts with the job's absolute paths:
`Job folder: <repo>/factory/jobs/<job-id>/. Worktree: <worktree>. Branch: factory/<job-id>.`
Below, `<paths>` stands for that sentence.

Agents that open pages also get a port. With `n` the job number (`003` → 3),
the builder gets `5100 + 10n`, `factory-reviewer-ux` gets `5101 + 10n` and
`factory-reviewer-ui` gets `5102 + 10n`, appended as ` Port: <port>.`

## /factory <feature>

1. **Create the job.** Pick the next 3-digit number after the highest numbered
   folder in `factory/jobs/` (`001` if there are none) and a 2–4 word
   kebab-case slug of the feature: `004-blog-reading-time`. Claim it with
   `mkdir factory/jobs/<job-id>` (no `-p`). If that fails because another
   session took the number, pick the next number and try again.
   The worktree path is `$(cd .. && pwd)/$(basename "$PWD")-factory/<job-id>`,
   run from `<repo>`. Write `job.json` with that `worktree`, `stage: "spec"`,
   `round: 0` and all reviews `pending`.
2. **Worktree.** Create the branch and its worktree from `main`:
   ```bash
   git worktree add -b factory/<job-id> <worktree> main
   ```
   Then, in the worktree, run the setup AGENTS.md gives for a fresh checkout
   (installing dependencies, for example). If any of it fails, stop and tell
   the user.
3. **Spec.** Run `factory-spec-writer` with the task
   `<paths> Feature: <feature, verbatim>`.
   Wait for it to finish, then check that `spec.md` exists.
4. **Build.** Set `stage: "build"`. Run `factory-builder` with the task
   `<paths> Build round 1. Port: <port>.` Then go to **Build check**.

### Build check

Read the first line of `build.md`.

- `STATUS: READY`: start the next review round.
- `STATUS: BLOCKED`: go to **Needs human**.

### Review round N

1. Set `stage: "review"`, `round: N` and all four reviews to `pending`. Create
   `factory/jobs/<job-id>/round-<N>/`.
2. Run `factory-reviewer-security`, `factory-reviewer-code` and
   `factory-reviewer-ux` in one parallel `subagent` call. Each gets the task
   `<paths> Review round N.`, plus ` Port: <port>.` for the UX reviewer.
3. When that call returns, read the first line of each of the three files
   (`VERDICT: PASS` or `VERDICT: CHANGES`) and write the verdicts to `job.json`
   straight away, so the dashboard chips fill in. Then run
   `factory-reviewer-ui` with its task and port, and write its verdict too.
4. **WAIT FOR ALL.** The round is done only when all four `review-*.md` files exist in `round-<N>/`.
   Never rerun the builder mid-round. If a reviewer finishes without writing
   its file, or writes a first line that isn't a verdict, stop and tell the user.
5. Decide:
   - **All PASS**: go to **Approve**.
   - **Any CHANGES, rebuilds left**: set `stage: "build"`, then run a fresh
     `factory-builder` with the task
     `<paths> Round N reviews are in <repo>/factory/jobs/<job-id>/round-<N>/. Address every review with VERDICT: CHANGES, commit, and update build.md for round N+1. Port: <port>.`
     Then go to **Build check**.
   - **Any CHANGES, no rebuilds left**: write `decision.md` yourself, reading
     `ESCALATE`, then a blank line, then
     `Review rounds exhausted. Outstanding CHANGES in round-<N>/ from: <reviewers>.`
     Go to **Needs human**.

### Approve

Set `stage: "approve"`. Run `factory-approver` with the task
`<paths> Final round: N.` When it finishes, read the first line of `decision.md`:

- `APPROVE`: go to **Merge**.
- `ESCALATE`: go to **Needs human**.

### Merge

Merge one job at a time: when several of your jobs are approved, merge each
when it reaches this step, never two at once. The merge happens in the main
checkout, so it must be clean and on `main`:
`git status --porcelain` prints nothing (`factory/` is excluded, so job state
never counts) and `git branch --show-current` prints `main`. If not, set
`stage: "needs-human"` and tell the user the job is approved but the main
checkout is busy; they run `/factory approve <job-id>` once it is clean.
Otherwise:

```bash
git merge --no-ff factory/<job-id> -m "Merge factory/<job-id>"
git worktree remove <worktree>
git branch -d factory/<job-id>
```

Set `stage: "merged"`. If the merge fails, run `git merge --abort` (when a merge
is in progress), set `stage: "needs-human"` and tell the user why. This
includes a conflict with lines an earlier parallel job already merged. If removing the
worktree fails, the job is still merged: tell the user what `git worktree remove`
printed. Never push and never open a PR: the user pushes `main` themselves.

### Needs human

Set `stage: "needs-human"`. The branch and its worktree stay for the human to
inspect. Tell the user which job is waiting, give the worktree path, and quote
`decision.md` (or the BLOCKED reason from `build.md`).

## /factory next [<n>]

`<n>` is a positive integer. Plain `/factory next` means one item (`<n>` = 1).

Read `factory/backlog.md` and take the first `- [ ]` item. Claim it with one
Edit that replaces its exact line with `- [x] <item> → claimed`. If the edit
fails because the line changed, another session claimed it: re-read the backlog
and try the next `- [ ]` item. If none is left, stop claiming.

Claim up to `<n>` items this way, one at a time. For each claimed item, run steps
1 and 2 of `/factory <item>` before claiming the next one, and once step 1 has
given it a job id, replace `claimed` on its backlog line with the job id. Then
drive every job you created from step 3 (see **Parallel jobs**). If fewer than
`<n>` items were left, run the ones you got and tell the user how many. If none
was left, say so and stop.

## /factory approve <job-id>

The job must be in `needs-human`. Run **Merge** with that job id.

## /factory rework <job-id> <note>

The job must be in `needs-human`.

1. Write the note, verbatim, to `factory/jobs/<job-id>/rework-<k>.md`, where `k`
   is the next unused number.
2. Set `stage: "build"`.
3. Run `factory-builder` with the task
   `<paths> Rework: read rework-<k>.md and address it, then update build.md for round N+1. Port: <port>.`
   (`N` is the job's last round.) A rework run gets a fresh `MAX_REBUILDS`.
4. Continue from **Build check**, exactly like a new job.

## /factory dashboard

Run **Bootstrap**, then tell the user to run, from `<repo>`:

```bash
cd factory && python3 -m http.server 8000
```

and open <http://localhost:8000/dashboard.html>. It polls every two seconds:
jobs move across the stages as cards, review chips fill in as verdicts land, and
clicking a card shows its markdown files. Don't start the server yourself unless
asked.

## Reporting

Keep the user posted with one short line per transition, each starting with its
job id, for example
`003-rate-limiting: round 2, security CHANGES, ux/ui/code PASS → resuming builder`.
When a job ends, say whether it merged or needs a human, and why. When the last
job of the session ends, give one line per job saying whether it merged or needs
a human, and why.
