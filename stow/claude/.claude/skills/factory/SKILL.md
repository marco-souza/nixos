---
name: factory
description: Run the development workflow of the software factory in the current repo. Use when the user types /factory <feature>, /factory feedback <job-id> [<note>], /factory ship <job-id>, or /factory dashboard. The session that runs it becomes the orchestrator of the discovery → interview → spec → build → review → judge loop, which ends in a pull request the human reviews; PR feedback loops back into discovery.
---

# Factory: development workflow

You are the orchestrator of one job: the one your session started, or the one
the user handed you with `/factory feedback` or `/factory ship`. You run the
loop below, spawn every agent, interview the human, and are the only writer of
the job's `job.json`. You never write code, specs, reviews or verdicts
yourself. Agents do the work and each writes one file. You move the job along.

This is the development workflow, started by a human. Other workflows (bug
tickets, on-call alarms) will get their own skills.

## Autonomy

The human takes part at two points, and only those:

1. **The interview**, right after discovery, when discovery found questions the
   code can't answer.
2. **The PR**, at the end. Their review comes back through `/factory feedback`.

Everything else is yours. Don't stop to ask anything outside the interview:
re-run an agent that wrote no file, send a failed round back to the builders,
and end a job that ran out of rounds in a draft PR. Report progress in short
lines.

## The loop

```
human: /factory <feature>
  → discovery ─→ interview (only if open questions) ─→ spec
  → build: one specialist builder per task, in order
  → review round N: [product, security, code, ux → ui] ─→ WAIT FOR ALL
  → judge ─┬─ APPROVE  ──────────────────────────────→ ship → PR (ready)
           ├─ BUILD    → specialist fixes → review N+1
           ├─ SPEC     → spec revision → build → review N+1
           └─ ESCALATE ──────────────────────────────→ ship → PR (draft)
human reviews PR → /factory feedback <job-id> → discovery (next cycle) → … → PR updated
```

| Step      | Agent (`subagent_type`)       | Model  | Writes                              |
| --------- | ----------------------------- | ------ | ----------------------------------- |
| discovery | `factory-discoverer`          | opus   | `discovery.md`                      |
| interview | you (`AskUserQuestion`)       |        | `answers.md`                        |
| spec      | `factory-spec-writer`         | opus   | `spec.md` (requirements + tasks)    |
| build     | `factory-builder-<specialist>`| sonnet | commits, `build.md` section, `proof/` |
| review    | `factory-reviewer-product`    | opus   | `round-N/review-product.md`         |
|           | `factory-reviewer-security`   | opus   | `round-N/review-security.md`        |
|           | `factory-reviewer-code`       | opus   | `round-N/review-code.md`            |
|           | `factory-reviewer-ux`         | opus   | `round-N/review-ux.md`              |
|           | `factory-reviewer-ui`         | opus   | `round-N/review-ui.md`              |
| judge     | `factory-judge`               | opus   | `round-N/judge.md`                  |
| ship      | `factory-shipper`             | sonnet | rebase + its section of `build.md`  |
| PR        | you                           |        | `pr.md`, the push and the PR        |

### Specialists

The spec assigns every task, and the judge every fix, to one specialist. The
specialist picks the builder agent:

| Specialist | Agent                       | For                                                   |
| ---------- | --------------------------- | ----------------------------------------------------- |
| `backend`  | `factory-builder-backend`   | API routes, handlers, services, jobs, integrations    |
| `frontend` | `factory-builder-frontend`  | web pages, components, styles, client state, forms    |
| `mobile`   | `factory-builder-mobile`    | native app screens, navigation, device APIs           |
| `data`     | `factory-builder-data`      | schema, migrations, queries, seeds                    |
| `infra`    | `factory-builder-infra`     | infrastructure as code, CI, deploy and hosting config |
| `general`  | `factory-builder`           | shared packages, docs, tooling, anything else         |

All builders share one contract, `~/.claude/skills/factory/builder.md`, and add
their specialty's rules on top. An unknown specialist runs `factory-builder`.

`MAX_ROUNDS = 3`: a cycle (the first run, or one `/factory feedback`) gets at
most 3 review rounds. A BUILD or SPEC verdict in a cycle's third round ships as
a draft PR instead.

To change the factory, edit this folder and the `factory-*` agents in
`~/.claude/agents/` (stowed from the nixos repo, `stow/claude/.claude/`).

Every agent reads `AGENTS.md` (or `CLAUDE.md`) for the repo's setup, dev server,
validation commands and conventions, including how to rebase and how PRs are
written. Nothing repo-specific lives in these files. If the repo has neither,
or it doesn't say how to run the validation commands, tell the user before
starting: the agents will guess.

## Blueprint

The blueprint is the repo's own answer to "how do we do this here": one
canonical way per cross-cutting concern (auth, permissions, data access, API
calls, errors, validation, tests, UI building blocks), each pointing at a
reference file to copy. It lives in a `## Blueprint` section of AGENTS.md or in
a doc that section points to. The human owns it. Agents follow it and never
invent a second way next to it:

- the discoverer lists the concerns a request touches and their patterns, and
  turns a concern with no pattern into an open question;
- the spec gives every task a `Pattern:` line;
- builders mirror that pattern, and the code reviewer checks they did;
- the judge escalates any new pattern or deviation, so the human sees it in
  the PR.

If the repo has no blueprint, tell the user before starting, once: every job
will then pick its patterns from the neighbouring code, and two jobs may pick
differently. Go on with the job.

## Browser

Pages are checked with the Playwright MCP tools (`mcp__plugin_playwright_*`).
All of the session's subagents share that one browser, so only one browser
agent runs at a time: builders run one after another anyway, and
`factory-reviewer-ui` starts only after `factory-reviewer-ux` has finished. The
other agents don't use the browser.

## Parallel jobs

One session drives one job, because the interview needs the human's attention.
Run several jobs at once from several sessions: each job has its own number,
worktree, branch, job folder and dev server ports, so they never collide.

- Your session stays in the main checkout. Agents work in the job's worktree.
  The main checkout is the user's, and it may be dirty or on another branch.
  Nothing touches it.
- Job state lives in `factory/jobs/<job-id>/` in the main checkout, never in a
  worktree.

## Files

`<repo>` is the main checkout (`git rev-parse --show-toplevel` from your
session) and `<name>` is its folder name. The whole `factory/` folder is
excluded locally through `.git/info/exclude`: it is runtime state that never
lands in a commit and never changes the repo's `.gitignore`.

```
<repo>/factory/dashboard.html                    the board (copied from this skill)
<repo>/factory/jobs/<job-id>/job.json            the job's state (you write it, the dashboard reads it)
<repo>/factory/jobs/<job-id>/discovery.md        rewritten each cycle
<repo>/factory/jobs/<job-id>/answers.md          the interview, appended each cycle
<repo>/factory/jobs/<job-id>/spec.md             rewritten on each revision
<repo>/factory/jobs/<job-id>/build.md            one section per task, fix and ship run
<repo>/factory/jobs/<job-id>/proof/ac<k>[-<slug>].<ext>   proof per acceptance criterion (builders write it)
<repo>/factory/jobs/<job-id>/feedback-<k>.md     written by you, from /factory feedback
<repo>/factory/jobs/<job-id>/round-<N>/review-{product,security,code,ux,ui}.md
<repo>/factory/jobs/<job-id>/round-<N>/judge.md
<repo>/factory/jobs/<job-id>/pr.md               the PR body
<repo>/../<name>-factory/<job-id>/               the job's worktree, on factory/<job-id>
```

Round numbers keep counting across cycles (a second cycle may start at
`round-3/`), so no file is ever overwritten by a later cycle.

### Bootstrap

Before any command, from `<repo>`:

1. If `/factory/` isn't a line in `.git/info/exclude` (use
   `git rev-parse --git-path info/exclude`), append it.
2. If `factory/dashboard.html` is missing or differs from
   `~/.claude/skills/factory/dashboard.html`, `mkdir -p factory/jobs` and copy
   it there. On the first setup, tell the user the dashboard command (see
   **/factory dashboard**).

### job.json

```json
{ "id": "003-rate-limiting", "feature": "Rate limit the signup form",
  "branch": "factory/003-rate-limiting",
  "worktree": "/home/you/code/my-app-factory/003-rate-limiting",
  "stage": "review", "cycle": 1, "round": 2, "cycleStart": 1, "task": null,
  "reviews": { "product": "PASS", "security": "CHANGES", "code": "PASS", "ux": "PASS", "ui": "pending" },
  "judge": "pending", "pr": null }
```

- `stage` is one of `discovery`, `interview`, `spec`, `build`, `review`,
  `judge`, `ship`, `pr`, `needs-human`. Worktree setup counts as `discovery`.
  `pr` means the PR is open and waiting for the human.
- `cycle` is 1 for the first run and goes up by one with each
  `/factory feedback`. `cycleStart` is the first round of the current cycle;
  the cycle's round limit is `cycleStart + MAX_ROUNDS - 1`.
- `round` is the current review round (0 until the first round starts).
- `task` says what the builder is doing while `stage` is `build`
  (`"T2 · frontend"`, `"fixes · backend"`), otherwise `null`.
- `reviews` and `judge` hold the current round only. Each review is `pending`,
  `PASS` or `CHANGES`; `judge` is `pending`, `APPROVE`, `BUILD`, `SPEC` or
  `ESCALATE`. Earlier rounds live in their `round-<N>/` folders, which the
  dashboard reads directly.
- `pr` is the PR URL once it exists, otherwise `null`.
- Rewrite the whole file on every change. `worktree` is always an absolute
  path. The dashboard depends on these exact keys and values: don't rename
  them.

### Prompts

Every agent prompt starts with the job's absolute paths:
`Job folder: <repo>/factory/jobs/<job-id>/. Worktree: <worktree>. Branch: factory/<job-id>.`
Below, `<paths>` stands for that sentence.

Agents that open pages also get a port. With `n` the job number (`003` → 3),
every builder gets `5100 + 10n`, `factory-reviewer-ux` gets `5101 + 10n` and
`factory-reviewer-ui` gets `5102 + 10n`, appended as ` Port: <port>.`

## /factory <feature>

1. **Create the job.** Pick the next 3-digit number after the highest numbered
   folder in `factory/jobs/` (`001` if there are none) and a 2–4 word
   kebab-case slug of the feature: `004-blog-reading-time`. Claim it with
   `mkdir factory/jobs/<job-id>` (no `-p`). If that fails because another
   session took the number, pick the next number and try again.
   The worktree path is `$(cd .. && pwd)/$(basename "$PWD")-factory/<job-id>`,
   run from `<repo>`. Write `job.json` with that `worktree`,
   `stage: "discovery"`, `cycle: 1`, `round: 0`, `cycleStart: 1`,
   `task: null`, all reviews and `judge` `pending`, and `pr: null`.
2. **Worktree.** Create the branch and its worktree from the latest `main`:
   ```bash
   git fetch origin main
   git worktree add -b factory/<job-id> <worktree> origin/main
   ```
   Then, in the worktree, run the setup AGENTS.md gives for a fresh checkout
   (installing dependencies, for example). If any of it fails, stop and tell
   the user.
3. Go to **Discovery**.

### Discovery

Set `stage: "discovery"`. Spawn `factory-discoverer` with the prompt
`<paths> Cycle <c>. Request: <feature, verbatim>.` On later cycles, add
` Feedback: feedback-<k>.md.` Wait for it, then check that `discovery.md`
exists and go to **Interview**.

### Interview

Read the `## Open questions` section of `discovery.md`.

- If it says "None.", skip straight to **Spec**.
- Otherwise set `stage: "interview"` and ask the human every open question with
  `AskUserQuestion`, up to 4 per call. Use the discoverer's wording and options
  as they are, put its recommended option first and mark it `(Recommended)`,
  and say in each question why it matters (the discoverer gives the reason).
  Don't add questions of your own.
- Append the questions and the human's answers, verbatim, to `answers.md` under
  `## Cycle <c>`. Then go to **Spec**.

This is the one place you wait for the human. Every question asked here is one
the code couldn't answer and whose answer changes the plan.

### Spec

Set `stage: "spec"`. Spawn `factory-spec-writer` with the prompt
`<paths> Cycle <c>. Write the spec.` When the judge sent the job back with
SPEC, use `<paths> Revise the spec: read round-<N>/judge.md.` instead.
Wait for it, then check that `spec.md` exists and go to **Build**.

### Build

The last section of `spec.md`, `## Run`, lists the tasks to build now, in
order, on one line: `T1, T2, T3`. For each task, one after another:

1. Read the task's `Specialist:` line in `spec.md`. Set `stage: "build"` and
   `task: "<Tk> · <specialist>"`.
2. Spawn a fresh builder for that specialist (see **Specialists**) with the
   prompt `<paths> Task <Tk>. Port: <port>.`
3. When it finishes, read the first line of `build.md`. `STATUS: READY`: go on
   to the next task. `STATUS: BLOCKED`: go to **Needs human**.

After the last task, set `task: null` and start the next review round.

### Review round N

1. Set `stage: "review"`, `round: N`, all five reviews and `judge` to
   `pending`. Create `factory/jobs/<job-id>/round-<N>/`.
2. Spawn `factory-reviewer-product`, `factory-reviewer-security`,
   `factory-reviewer-code` and `factory-reviewer-ux` **in one message**, so
   they run in parallel. Each gets the prompt `<paths> Review round N.`, plus
   ` Port: <port>.` for the UX reviewer. When `factory-reviewer-ux` finishes,
   spawn `factory-reviewer-ui` with its prompt and port (the browser is free
   again).
3. **WAIT FOR ALL.** Each time a reviewer finishes, read the first line of its
   file (`VERDICT: PASS` or `VERDICT: CHANGES`) and write that verdict to
   `job.json` straight away, so the dashboard chips fill in as they land. The
   round is done only when all five `review-*.md` files exist in `round-<N>/`.
   If a reviewer finishes without writing its file, or its first line isn't a
   verdict, run it once more with the same prompt. If it again returns its
   report as text with a verdict on the first line but can't write the file,
   save that text verbatim to its `review-*.md` (copy it, never edit it or add
   a verdict of your own). Only if there is still no verdict, go to
   **Needs human**.
4. Go to **Judge**, even when every review passed: the judge still checks the
   work against the spec and the risky areas.

### Judge

Set `stage: "judge"`. Spawn `factory-judge` with the prompt
`<paths> Round N.` When it finishes, write its verdict (the first line of
`round-<N>/judge.md`, `VERDICT: <X>`) to `judge` in `job.json`, then:

- **APPROVE**: go to **Ship** (ready PR).
- **ESCALATE**: go to **Ship** (draft PR).
- **BUILD** or **SPEC** with `N` at the cycle's round limit: go to **Ship**
  (draft PR). The judge's file already says what is still open.
- **BUILD**, rounds left: run **Fixes**, then review round N+1.
- **SPEC**, rounds left: run **Spec** in revise mode, then **Build** (it runs
  the tasks the revised `## Run` lists), then review round N+1.

If the judge wrote no file or no valid verdict, run it once more; if it still
fails, go to **Needs human**.

### Fixes

`round-<N>/judge.md` lists the fixes under `## Fixes`, each tagged with a
specialist, in order. Group them by specialist, keeping the order in which each
specialist first appears. For each group, one after another: set
`stage: "build"`, `task: "fixes · <specialist>"`, and spawn a fresh builder for
that specialist with
`<paths> Fixes from round-<N>/judge.md for specialist <specialist>. Port: <port>.`
Check `build.md`'s first line after each, exactly as in **Build**.

### Ship

1. Set `stage: "ship"`. Spawn `factory-shipper` with `<paths> Ship.` It brings
   the branch up to date with `origin/main` the way AGENTS.md says, resolves
   conflicts, re-runs the validation and records it in `build.md`. On
   `STATUS: BLOCKED`, go to **Needs human**.
2. **Publish the proof.** A PR must show that the implementation works: every
   acceptance criterion needs at least one file in `proof/` named `ac<k>…`, a
   screenshot or recording for what a user sees, a command's real output for
   the rest. List `proof/` and match it against the criteria in `spec.md`. If a
   criterion has none, the PR ships as a draft and the missing criteria go
   under `## Open`, whatever the judge said. Never open a ready PR without
   proof for every criterion, and never make proof yourself.

   Push the proof files to their own branch, which is never merged, from
   `<repo>`, in one command:
   ```bash
   export GIT_INDEX_FILE="$PWD/factory/jobs/<job-id>/proof.index"; rm -f "$GIT_INDEX_FILE"
   git --work-tree=factory/jobs/<job-id>/proof add -A . \
     && sha=$(git commit-tree "$(git write-tree)" -m "proof: <job-id>") \
     && git push --force origin "$sha:refs/heads/factory-proof/<job-id>" \
     && echo "$sha"
   ```
   A proof file's URL is
   `https://github.com/<owner>/<repo>/blob/<sha>/<file>?raw=true`, with
   `<owner>/<repo>` from `gh repo view --json nameWithOwner -q .nameWithOwner`.
   Skip the push when `proof/` is empty or missing.
3. Write `pr.md`, in this order:
   - `## Open`, only when the job ships as a draft: the judge's
     `## For the human` (or, when rounds ran out, its `## Why` and `## Fixes`),
     plus any criteria without proof, so the human sees what is open first.
   - What the feature does.
   - `## Proof`: each acceptance criterion from `spec.md`, in order, with its
     proof right under it. Embed images and GIFs (`![AC<k>: <criterion>](<url>)`),
     link videos, and put command output in a code block inside `<details>`,
     trimmed to the lines that show the result. Add how it was checked, from
     `build.md` and the judge.
   - `## How it's built`: the judge's `## Design` from the last round, as it
     is: the patterns followed, any new pattern, any deviation from the
     blueprint, and any workaround. This is what the human reads instead of
     every line of the diff.
   - The interview answers; the verdicts per round; whether the shipper
     resolved conflicts; and any non-blocking notes the reviewers left.

   Copy these from the job's files, don't invent them. Follow any
   PR-description rules in AGENTS.md. End with the attribution lines the
   session gives for PRs, if any.
4. Push and open or update the PR, from `<repo>`:
   ```bash
   git -C <worktree> push --force-with-lease -u origin factory/<job-id>
   # no PR yet:
   gh pr create --head factory/<job-id> --base main --title "<type>: <lowercase summary>" --body-file factory/jobs/<job-id>/pr.md [--draft]
   # PR exists (a feedback cycle):
   gh pr edit <pr> --body-file factory/jobs/<job-id>/pr.md
   gh pr ready <pr>            # only when APPROVE and the PR is a draft
   gh pr ready <pr> --undo     # only when it ships as a draft and the PR is ready
   ```
   The title follows the repo's commit convention from AGENTS.md. On a feedback
   cycle, also comment on the PR with one line per feedback item saying what
   changed, so reviewers see their comments were handled.
5. Set `stage: "pr"` and `pr` to the PR URL. Leave the worktree and both
   branches in place. Never merge into `main` and never push `main`: the human reviews and
   merges the PR. If the push or `gh` fails, go to **Needs human** with the
   exact error.

### Needs human

A `STATUS: BLOCKED` build or ship, an agent with no valid output after a re-run,
or a failed push or PR ends here. Set `stage: "needs-human"`. The branch and its
worktree stay. Tell the user which job is waiting, give the worktree path, and
quote the BLOCKED reason from `build.md` (or the error). They continue it with
`/factory feedback <job-id> <note>` or `/factory ship <job-id>`.

## /factory feedback <job-id> [<note>]

The job must be in `pr` or `needs-human`.

1. Collect the feedback. If the job has a PR, fetch its reviews and comments
   with `gh pr view <pr> --comments` and
   `gh api repos/{owner}/{repo}/pulls/<number>/comments`, keeping only those
   newer than the last `feedback-*.md` (or all of them, the first time). Write
   them verbatim, each with its author, file and line, plus the user's note
   under `## Note`, to `feedback-<k>.md`, where `k` is the next unused number.
   If there is neither a new comment nor a note, say so and stop.
2. Start the next cycle: `cycle` + 1, `cycleStart` = `round` + 1, reviews and
   `judge` back to `pending`.
3. Go to **Discovery**, with ` Feedback: feedback-<k>.md.` in its prompt. The
   loop runs as before and ends by updating the existing PR in **Ship**.

## /factory ship <job-id>

The job must be in `needs-human`. The human has decided the branch is good as
it is: go to **Ship** with a draft PR, starting `pr.md` with the reason the job
needed a human. The PR still carries whatever proof the job has.

## /factory dashboard

Run **Bootstrap**, then tell the user to run, from `<repo>`:

```bash
cd factory && python3 -m http.server 8000
```

and open <http://localhost:8000/dashboard.html>. It polls every two seconds:
jobs move across the stages as cards, review and judge chips fill in as
verdicts land, and clicking a card shows its markdown files. Don't start the
server yourself unless asked.

## Reporting

Keep the user posted with one short line per transition, starting with the job
id, for example
`003-rate-limiting: round 2, security CHANGES, others PASS → judge`.
When the job ends, say whether it has a PR (with its URL, and whether it's a
draft) or needs a human, and why.
