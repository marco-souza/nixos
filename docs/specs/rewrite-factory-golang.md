# Spec: Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

## Context

The factory today is Bun + TypeScript in `stow/factory/.local/share/factory/`
(the module folder), launched by `stow/factory/.local/bin/factory`. The
reference behaviour is `origin/main` at `f7fb2cf`. This branch starts at
`f0be919` plus docs commits, so its copy of `stow/factory` is stale: it has
`attach` and lacks `answer`, `unblock` and the headless grill. T1 merges
`origin/main` first, and every later task ports from the merged tree (or
`git show origin/main:<path>`), never from `f0be919`.

Paths below that start with `cmd/`, `internal/`, `roles/` or name a module
file (`go.mod`, `mise.toml`, `.golangci.yml`, `assets.go`, `README.md` in a
task's module list) are relative to the module folder. Repo-root files are
named as such. Reference TS files are under the module folder's `src/`.

The design (`docs/design-docs/rewrite-factory-golang.md`) is the plan to
build. Each task names the design sections it builds. Its "Decided without
asking" list is settled for this spec. In short:

- Each TS module maps to a Go package (design §2). Everything the binary
  needs (roles, dashboard assets, config defaults, the Playwright server) is
  compiled in with `go:embed` or Go values (§1).
- Cross-cutting patterns are in design §3. The repo has no Go code and
  `AGENTS.md` has no `## Blueprint`, so those patterns are new, chosen in the
  design. T9 records them in the package `README.md` and points `AGENTS.md`
  at them.
- Job docs live at `<jobDir>/docs/<kind>.md` and are never committed or
  pushed. The draft PR opens at the first build push. The proof ref is pushed
  with `--no-verify` (§4).
- The harness is chosen per job with `--harness` (§4). Browser roles get
  Playwright on both harnesses (§6).
- Config is `.factory.json`, deep-merged over the defaults as raw JSON, then
  strictly decoded. State is `job.json` v3 (§7, Data).
- The dashboard is server-rendered: `html/template`, htmx 2, Tailwind 4,
  daisyUI 5, plus a small `app.js` (§9, API, UI).
- Toolchain and tests are in §10. Docs and skills are in §11.

Two corrections to the design, found while planning:

- `app` imports `driver` (`app.New` calls `driver.GrillTurn`), and `driver`
  needs `Deps`. Go forbids that cycle, so the `Deps` struct lives in a leaf
  package `internal/deps`. `app.MakeDeps` still builds the real set.
- `lefthook run` installs the git hooks unless it gets `--no-auto-install`
  (`lefthook run --help`, lefthook 2.2.3). Every `lefthook run` in this spec
  carries `--no-auto-install`, and `AGENTS.md` says so (T9). Nobody but
  Marco installs the hooks.

Agents never run `./stow.sh`, `make switch|boot|mac|update|hardware`,
`lefthook install`, or `mise run install` without `FACTORY_BIN_DIR` set to a
temp folder (`AGENTS.md` "Setup", design §10).

## Requirements

1. The branch contains `origin/main` at `f7fb2cf` (T1 merges it; the later
   rebase stage may rebase onto a newer main). Behaviour is ported from that
   commit.
2. `stow/factory/.local/share/factory/` is a Go 1.27.4 module whose CLI is
   built with cobra. Its only Go dependencies are cobra and goldmark.
3. No TypeScript, Bun tests, `package.json`, `bun.lock`, `tsconfig.json` or
   Bun launcher is left in `stow/factory`.
4. Every capability of the reference stays:
   - the commands `new`, `status`, `logs`, `approve`, `feedback`, `answer`,
     `unblock`, `run`, `discard`, `dashboard`, and the hidden `tail` and
     `run --here`
   - the headless grill, both harnesses, every role, `pr` and `report`
     deliverables
   - the hooks `prOpened`, `qaUrl` and `qaReady`
   - desktop notifications on macOS and Linux, and the dashboard
5. The harness is chosen once per job with `factory new --harness claude|pi`.
   The config's `defaultHarness` (`claude`) applies when the flag is not
   given. Every role of the job runs on that harness, browser roles
   included. Per-role harness overrides are gone.
6. Browser roles get the isolated, headless Playwright MCP server on both
   harnesses.
7. The dashboard is rebuilt with Go templates, htmx, Tailwind and daisyUI.
   It has the same features as today's `dashboard.html` and a new look. It
   is served on `localhost` with no auth, behind the Host, Origin and
   `X-Factory` guards and a strict CSP.
8. Job docs stay in `.factory/jobs/<id>/docs/`. They are never committed to
   the branch or pushed, the `factory-proof/<id>` ref included. The PR
   body's `Docs:` line lists their repo-relative paths as code spans, not
   links.
9. The draft PR opens at the first build push that puts the branch ahead of
   its base. A build that leaves no commit ahead fails with a clear reason.
10. The proof ref is pushed with `--no-verify`.
11. A failed command's reason holds a summary line plus the last 20 output
    lines. One-line places show only the summary line.
12. `mise.toml` in the module folder pins Go, golangci-lint, lefthook and
    Tailwind. `mise run install` builds `factory` into
    `${FACTORY_BIN_DIR:-$HOME/.local/bin}`. The binary is static, so it runs
    on macOS and NixOS.
13. A repo-root `lefthook.yml` formats and lints staged Go files in the
    module on pre-commit, and runs the Go tests on pre-push. Nothing else is
    checked.
14. Go tests port every case of the reference `e2e.test.ts`,
    `machine.test.ts` and `spawn.test.ts`, with fake `claude`, `pi` and `gh`
    and real git, and pass with `-race`. Tests never touch the real repo,
    even when run from a git hook.
15. `go vet`, `golangci-lint fmt --diff` and `golangci-lint run` report
    nothing.
16. `mise run demo` serves a seeded demo dashboard with fake deps.
17. One real job runs end to end with the Go binary: a scratch repo with a
    local bare origin, real `claude` agents, and a fake `gh`. Nothing is
    written to GitHub.
18. Roles, the two `factory` skills, `AGENTS.md` and `README.md` change only
    where the new CLI, config, state or toolchain needs it.
19. The PR description has a "Before merging" note for the summarizer to
    carry. It tells Marco to:
    - delete this job's own `docs/*/rewrite-factory-golang.md` from the
      branch (the TS factory driving this job commits them);
    - follow the package README's switch-over steps on each host;
    - run the manual pi browser check from design §6.

## Acceptance criteria

1. The branch contains `f7fb2cf`. Check:
   `git merge-base --is-ancestor f7fb2cf HEAD && echo contains` prints
   `contains`.
   Proof: output of that command and of `git log --oneline -3 HEAD`
2. The module is Go 1.27.4 with cobra, and it builds. Check: in the module
   folder, `go list -m -f '{{.GoVersion}}'` prints `1.27.4`,
   `go list -m all | grep -E 'spf13/cobra'` prints cobra, and
   `go build ./...` exits 0.
   Proof: output of `go list -m -f '{{.GoVersion}}' && go list -m all && go build ./... && echo built`
3. `.factory.json` is deep-merged over the defaults, then strictly decoded.
   Check: `go test -race -v -run TestLoad ./internal/config/` passes cases
   where:
   - no file gives `Defaults()`;
   - `{"models":{"claude":{"low":"x"}}}` keeps `medium: sonnet` and
     `high: opus`;
   - a partial `timeoutsMin` and a single `hooks` key keep the rest;
   - `validators` replaces the array, and `"base": null` gives `""`;
   - `docs`, `docsCommitType` and `roles.<name>.harness` fail as unknown
     fields, with the file path in the message;
   - an unknown validator, a bad `defaultHarness` and a non-object file
     fail with the reference messages.
   Proof: output of `go test -race -v -run TestLoad ./internal/config/`
4. The state machine is ported case for case. Check:
   `go test -race -v ./internal/machine/` passes, and each `test` and
   `test.each` in the reference `src/__tests__/machine.test.ts` (53 calls at
   `f7fb2cf`) has a Go test or table row named after it. Both "never mutates
   its input" cases compare against a `Clone()` taken before the call.
   Proof: output of `go test -race -v ./internal/machine/`
5. Browser roles get Playwright on both harnesses, and other roles get
   neither. Check: `go test -race -v -run TestCommand ./internal/harness/`
   passes cases where:
   - a claude browser role's command has
     `--mcp-config <jobDir>/run/playwright.mcp.json` and the 12
     `mcp__playwright__browser_*` tools;
   - a pi browser role's command has `-e <jobDir>/run/playwright.pi.js`,
     and its `--tools` names those 12 tools;
   - both files are written with mode `0600`, outside the worktree, and
     name `@playwright/mcp@0.0.86` with `--isolated --headless`;
   - a non-browser role on either harness gets no MCP flag and no file.
   Proof: output of `go test -race -v -run TestCommand ./internal/harness/`
6. Agent processes are detached, killable as a tree, and reaped, and
   notifications use the OS tool. Check: `go test -race -v ./internal/proc/`
   passes:
   - the two cases of the reference `spawn.test.ts`: a background agent is
     alive, then `Kill` takes its whole tree; a quick agent leaves its exit
     code, and `IsAlive` is false afterwards;
   - an `ExitError` test: 25 output lines keep the last 20 non-empty ones
     under the summary line `<cmd> failed (exit N): <last line>`;
   - a `Notify` test with a fake runner: `osascript` on darwin,
     `notify-send` on linux, and no error when the tool fails.
   Proof: output of `go test -race -v ./internal/proc/`
7. Tests that run git never touch the real repo, even with git's
   repo-location variables set. Check:
   `go test -race -v -run 'TestTempRepo|TestGitEnvCleared' ./internal/testkit/`
   passes. `TestGitEnvCleared` reruns `TestTempRepo` with `GIT_DIR`,
   `GIT_WORK_TREE` and `GIT_INDEX_FILE` pointing at a sentinel repo, and the
   sentinel's `HEAD`, refs and `.git/config` are unchanged.
   Proof: output of that command
8. The end-to-end suite ports every reference case, with real git, the
   embedded roles, fake agents and fake `gh`. Check:
   `go test -race -v ./internal/e2e/` passes a test named after each of the
   12 tests in the reference `src/__tests__/e2e.test.ts`. They run from
   happy path through "an answer with no pending question, or outside the
   grill, is refused". The tests below (criteria 9 to 13) pass too.
   Proof: output of `go test -race -v ./internal/e2e/`
9. The harness is chosen per job. Check:
   `go test -race -v -run Harness ./internal/e2e/` passes cases where:
   - `factory new --harness pi` writes `"harness": "pi"` to `job.json`,
     and every agent the job starts gets harness `pi` in `CommandFor`,
     browser roles included;
   - no flag gives `"harness": "claude"`;
   - `--harness foo` fails before any job folder, branch or worktree
     exists.
   Proof: output of that command
10. Job docs never leave the job folder. Check: the e2e happy path asserts
    that:
    - the five docs exist as `<jobDir>/docs/{requirements,tech-discovery,design,spec,test-plan}.md`;
    - origin's job branch has no `docs/` file and no `docs: … for <id>`
      commit;
    - `factory-proof/<id>` on origin holds only proof files;
    - the PR body's `Docs:` line holds repo-relative code-span paths and no
      `](` link;
    - each task prompt's `Docs:` line holds absolute `<jobDir>/docs/` paths.
    Proof: output of `go test -race -v -run 'TestE2E/happy' ./internal/e2e/`
    (or the happy-path test's actual name)
11. The proof ref is pushed with `--no-verify`. Check: the e2e temp repo has
    a `pre-push` hook that rejects `refs/heads/factory-proof/*`, and the
    happy path still ends `done` with `factory-proof/<id>` on origin.
    Proof: the same test output as criterion 10, plus
    `grep -n 'no-verify' internal/driver/*.go`
12. The draft PR opens at the first build push. Check: the e2e happy path
    asserts that the job's `activity.log` shows `opened draft PR` after the
    first builder's line and not during preflight, and that fakegh's
    `calls.jsonl` has exactly one `pr create`. A test where every builder leaves
    no commit ends with the reason
    `build made no commits ahead of <base>: nothing to open a PR for` and no
    `pr create`.
    Proof: output of `go test -race -v -run 'TestE2E/(happy|NoCommits)' ./internal/e2e/`
    (or the tests' actual names)
13. A failure's reason shows the last lines of output, and one-line places
    show only its first line. Check: an e2e test runs a `prOpened` hook that
    prints 25 lines and exits 1, and asserts that:
    - `job.json`'s `reason` holds the summary line plus the last 20 lines;
    - `factory status <id>` prints all of them;
    - the `factory status` table row, the activity line and the PR headline
      hold only the summary line.
    `go test -race -v -run Headline ./internal/ui/` passes too.
    Proof: output of both test commands
14. The dashboard serves on `localhost` behind its guards. Check:
    `go test -race -v ./internal/dashboard/` passes cases where:
    - a Host other than `localhost:<port>` or `127.0.0.1:<port>` gets 403;
    - a POST with a foreign Origin, or without `X-Factory: 1`, gets 403;
    - doc and file paths outside the job folder, a symlink escape included,
      get 403, and a missing file gets 404;
    - a doc containing `<script>` and a `javascript:` link renders with
      neither;
    - approve and retry get 409 while a live driver holds the lock;
    - every response carries
      `Content-Security-Policy: default-src 'self'; img-src 'self' data:` and
      `Cache-Control: no-store`;
    - the page's `htmx-config` meta has `"includeIndicatorStyles":false`
      and `"allowEval":false`.
    Then `factory dashboard --port 0` prints `http://localhost:<port>`, and
    `curl -sI` on it shows the CSP header.
    Proof: output of the test command and of the `curl -sI`
15. The demo dashboard shows the board and the "Needs you" list. Check:
    `mise run demo`, then open `http://localhost:8000`. The page shows:
    - the header: project name, counts of running, needs-you and done jobs,
      a green sync dot, "Notify me" while the permission is undecided, and
      `?`;
    - "Needs you", with one ticket per waiting job (grill, review, env,
      escalation and failure in the demo), each with its kind's actions
      (design UI section). The failure ticket shows the reason's headline,
      with a "details" toggle that shows the tail;
    - the columns Discovery, Building, Validation, Deploy and Done, with
      cards showing id, feature, step `(k/n)` and age;
    - discarded jobs after "Show discarded" is turned on.
    Proof: screenshot of the demo page, and screenshot with "Show discarded"
    on and a failure ticket's details open
16. The job drawer has Timeline, Docs, Trips and Logs. Check: in the demo,
    click a card (or select it and press Enter):
    - Timeline lists activity lines;
    - Docs lists the five docs as present or "not yet", and a click renders
      one from `<jobDir>/docs/` as Markdown;
    - Trips lists trip files, and a click renders one;
    - Logs shows a picker, newest first, and the view follows the end;
    - Esc closes the drawer;
    - the browser console shows no CSP error while tabs load.
    Proof: one screenshot per tab
17. Actions, toasts, shortcuts and live refresh work. Check: in the demo:
    - Approve on a review ticket removes it from "Needs you" without a page
      reload;
    - Feedback text survives a poll and sends on ⌘/Ctrl+Enter;
    - Discard asks before it acts;
    - an action the server refuses (for example approving a job that isn't
      waiting) shows a toast with the server's message;
    - a stage change between polls shows a `<id>: <from> → <to>` toast;
    - `j`/`k` move the selection, `a` approves, `f` focuses feedback, `?`
      opens help, Esc closes it, and keys are ignored while typing.
    Proof: screenshots of the board before and after Approve, the error
    toast, the stage-change toast and the help dialog
18. No TypeScript or Bun file is left in the factory package. Check:
    `git ls-files stow/factory | grep -E '\.ts$|(^|/)(package\.json|bun\.lock|tsconfig\.json)$|^stow/factory/\.local/bin/'`
    prints nothing.
    Proof: output of that command and of `git ls-files stow/factory | head -50`
19. The binary has every command and no `attach`. Check:
    `"$d/factory" --help` lists `answer`, `approve`, `dashboard`,
    `discard`, `feedback`, `logs`, `new`, `run`, `status` and `unblock`.
    `"$d/factory" new --help` shows `--harness`. `"$d/factory" attach` fails
    as an unknown command. Here `$d` is the folder of criterion 20.
    Proof: output of the three commands
20. `mise run install` builds a static binary into `FACTORY_BIN_DIR`, with
    `~/.local/bin` as the default. Check: in the module folder:
    - `mise.toml` pins exact versions of `go` (1.27.4), `golangci-lint`,
      `lefthook` and `github:tailwindlabs/tailwindcss`;
    - `d=$(mktemp -d) && FACTORY_BIN_DIR="$d" mise run install && "$d/factory" --help`
      succeeds;
    - `mise tasks info install` shows `${FACTORY_BIN_DIR:-$HOME/.local/bin}`;
    - `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$d/factory-linux" ./cmd/factory && file "$d/factory-linux"`
      reports a statically linked x86-64 ELF;
    - `ls -la ~/.local/bin/factory` is the same before and after.
    Proof: output of those commands
21. lefthook checks only the module's Go files. Check: at the repo root:
    - `lefthook validate` passes;
    - `lefthook dump` shows the `factory fmt` and `factory lint` pre-commit
      jobs and the `factory test` pre-push job, each with
      `root: stow/factory/.local/share/factory/` and `glob: "*.go"`;
    - `lefthook run pre-commit --all-files --no-auto-install --no-stage-fixed`
      runs both pre-commit jobs, and they pass;
    - `lefthook run pre-push --all-files --no-auto-install` runs
      `factory test`, and it passes;
    - `lefthook run pre-commit --file README.md --no-auto-install` skips
      every job;
    - `ls "$(git rev-parse --git-common-dir)/hooks"` shows no new lefthook
      hook.
    Proof: output of those commands
22. Format, vet, lint and tests are clean. Check: `mise run check` in the
    module folder exits 0. `golangci-lint fmt --diff` prints nothing,
    `go vet ./...` is silent, `golangci-lint run ./...` reports `0 issues`,
    and `go test -race ./...` passes every package.
    Proof: output of `mise run check`
23. Docs, skills and roles change only where the Go CLI needs it. Check:
    - `git diff --stat origin/main...HEAD -- stow/factory/.local/share/factory/roles/`
      lists only `_common.md`, whose `Docs` line says the docs are in the
      job folder;
    - `grep -n bun AGENTS.md README.md stow/claude/.claude/skills/factory/SKILL.md stow/pi/.pi/agent/skills/factory/SKILL.md`
      shows only `task-pipeline` lines;
    - `AGENTS.md` names `mise run check`, `mise run demo`, `localhost`,
      `lefthook.yml`, `--no-auto-install`, a `## Blueprint` pointer to the
      package README, and `lefthook install` plus `mise run install`
      without `FACTORY_BIN_DIR` in the commands agents never run;
    - both skills say to run `mise run install` in the module folder, and
      mention `--harness pi`;
    - the package `README.md` covers the commands with `--harness`, the
      config keys and merge rule, the state, browser roles with the two pi
      notes, install, checks, tests, the demo, the conventions and the
      switch-over steps.
    Proof: output of the `git diff --stat` and `grep` commands, plus
    `grep -n -E 'mise run (check|demo|install)|Blueprint|no-auto-install|localhost' AGENTS.md`
24. A real job runs end to end with the Go binary and writes nothing to
    GitHub. Check: in a scratch repo with a local bare `origin`, `fakegh`
    first on `PATH` as `gh`, and real `claude`, a tiny request goes from
    `factory new` to `done`:
    - `factory status <id>` shows `done`;
    - fakegh's `calls.jsonl` has `pr create --draft` and `pr ready`;
    - the bare origin has the job branch and `factory-proof/<id>`, and the
      branch has no `docs/` file;
    - `.factory/jobs/<id>/docs/` holds the five docs.
    Proof: output of those four checks, and the job's `activity.log`

## Out of scope

- chrome-relay; `task-pipeline` and the pi skills and workflows built on it.
- Migrating, detecting or explaining old `job.json` v2 files or old
  `.factory.json` keys. Unknown keys simply fail decoding.
- New dashboard features, the `/api/*` JSON endpoints (dropped), dashboard
  auth.
- A Nix package, any `.nix` change, hooks for non-Go files.
- This job's own `docs/*/rewrite-factory-golang.md`. Don't edit or delete
  them: the TS factory driving this job reads and recommits them.
- The untracked `feedback.md` in the main checkout.
- Running `lefthook install`, `mise run install` without a temp
  `FACTORY_BIN_DIR`, `./stow.sh` or any `make` target that changes the
  system.
- A live pi agent run: the job's access has no pi (requirements, Access).
- Role changes beyond `roles/_common.md`'s `Docs` line.
- Test libraries (testify and the like) and Go dependencies other than
  cobra and goldmark.

## Assumptions

- [impl] `Deps` lives in `internal/deps`, not `internal/app`: `app` imports
  `driver` (`New` → `GrillTurn`), and `driver` needs `Deps`. Go forbids the
  cycle.
- [impl] The backend port is split into six tasks by layer (T2–T7).
  Builders run at the medium tier (30-minute timeout), and the reference is
  about 4.5k lines of TS plus 1k of tests. Each task leaves the module
  building, with its tests passing.
- [impl] `factory dashboard`'s cobra command lands with the dashboard (T8),
  so no stub command ever exists.
- [impl] Tailwind in `mise.toml`, plus the `css` and `demo` tasks, land with
  the dashboard (T8). T1 writes the tools and tasks it can already run.
- [impl] Go tests are named after the reference test titles, so criteria 4,
  6 and 8 can be checked with `go test -v`.
- [impl] Every `lefthook run` carries `--no-auto-install`. Without it,
  lefthook installs hooks into the shared `.git/hooks` (`lefthook run
  --help`).
- [impl] NixOS is checked by cross-compiling for `linux/amd64`. `laptop` and
  `homelab` are `x86_64-linux` (`hosts/*/hardware-configuration.nix:43`),
  and no Linux host is reachable from this job.
- [impl] `AGENTS.md` gets a `## Blueprint` section that points at the
  package README's conventions. The planning rules require new patterns to
  be recorded in the blueprint.
- [impl] The real run is its own task (T10). It works in a fixed scratch
  folder, `${TMPDIR:-/tmp}/factory-real-run`, so a retried builder resumes
  the same job: a full job with real agents can take longer than one
  builder's 30-minute window. Its `.factory.json` follows design Risk 16:
  `validators: ["e2e"]`, `maxTrips: 1`, `models.claude.high: "sonnet"`.
- [impl] The merge commit message follows the repo's convention:
  `enh: merge main at f7fb2cf`.
- [behaviour] Requirement 6's "a browser role run on pi can drive a browser"
  is proven by the command-line test and the generated extension
  (criterion 5), not by a live pi run. The requirements' Access excludes
  pi. The manual check from design §6 goes in the PR's "Before merging"
  note (requirement 19) and the package README.

## Tasks

### T1: Merge main and set up the Go module and toolchain
- Specialist: general
- Files: `go.mod`, `go.sum`, `mise.toml`, `.golangci.yml`,
  `cmd/factory/main.go`, `internal/cli/root.go`, `assets.go`, repo-root
  `lefthook.yml`
- Pattern: CLI entry: new: a thin `main` that calls
  `os.Exit(cli.Execute(ctx, args, stdout, stderr))` (design §3, §5,
  `stow/claude/.claude/skills/go-service-setup/SKILL.md`); toolchain: new:
  mise tasks plus golangci-lint v2 plus lefthook (design §10)
- Does:
  - Run `git fetch origin && git merge origin/main -m "enh: merge main at f7fb2cf"`.
    Never rebase (design §0). The merge is clean, since the branch only
    adds `docs/` files.
  - Create the module per design §2 and §10: `go.mod` with
    `module github.com/marco-souza/nixos/stow/factory`, `go 1.27.4`, and
    cobra.
  - `mise.toml`: `[tools]` pins `go = "1.27.4"`, `golangci-lint` and
    `lefthook` to exact versions (`mise latest`: 2.15.0 and 2.2.4). Add the
    `install` and `check` tasks exactly as design §10 has them
    (`FACTORY_BIN_DIR`, build to `.factory.new`, then `mv -f`, with
    `CGO_ENABLED=0`).
  - `.golangci.yml` v2 per design §10: `standard` plus the listed linters,
    gosec G204 and G304 excluded with a comment, and gofumpt and goimports
    with `local-prefixes` set to the module path.
  - Repo-root `lefthook.yml`: the three jobs of design §10.
  - `assets.go` (`package factory`) embeds `roles/*.md` as `Roles fs.FS`.
  - `internal/cli/root.go`: `Execute` builds the cobra root with
    `SilenceUsage` and `SilenceErrors`, and the persistent `--repo` flag.
    Errors print as `factory: <msg>` in red.
  - Check with `go build ./...`, `mise run check`, `lefthook validate` and
    `lefthook run pre-commit --all-files --no-auto-install --no-stage-fixed`.
    If mise refuses the untrusted `mise.toml`, run `mise trust` on that file
    only. Never run `lefthook install`.
  - Leave the TS files in place: later tasks port from them, and T9 removes
    them.
- Done when: acceptance criteria 1, 2

### T2: Port config, job state and the state machine
- Specialist: backend
- Files: `internal/config/config.go`, `internal/config/config_test.go`,
  `internal/job/job.go`, `internal/job/paths.go`, `internal/job/lock.go`,
  `internal/job/ids.go`, `internal/job/job_test.go`,
  `internal/machine/machine.go`, `internal/machine/machine_test.go`
- Pattern: persistence: new: JSON to `<file>.tmp`, then rename (design §3),
  ported from `src/job.ts` `saveJob`; errors: new: typed errors matched with
  `errors.As` (design §3); state: new: by-value functions over `Clone()`
  (design §3 Concurrency); tests: new: stdlib `testing` table tests
  (design §10)
- Does:
  - `config`: port `src/config.ts` and `config.json` per design §7 and Data.
    - `Defaults()` is today's `config.json` minus `docs` and
      `docsCommitType`.
    - `Load(repo)`: defaults to a map, deep-`merge` the `.factory.json`
      object, then decode strictly with `DisallowUnknownFields`, then
      validate validators, `defaultHarness` and tiers.
    - `RoleOverride` has only `tier` and `timeoutMin`.
  - `job`: port the pure parts of `src/job.ts`, `src/paths.ts`,
    `src/lock.ts` and `src/ids.ts` per the design's Data section.
    - `Job` v3 adds `Harness`. `Load` rejects any version but 3, and `List`
      skips such files.
    - `Clone()` deep-copies `Trips` (with their maps and `Built`),
      `Decisions`, `Running` and `Discovery`.
    - `Paths` gains `DocsDir` and `Doc(kind)` (`<jobDir>/docs/<kind>.md`).
    - `Lock` uses `O_EXCL` and takes over a dead pid's lock (EPERM counts
      as alive).
    - `TakenIDs` is the job folder names plus the reserved `jobs` and
      `archive`. It no longer scans a requirements folder.
  - `machine`: port `src/machine.ts`. `Route` and `Apply` take `job.Job` by
    value, start with `in.Clone()`, and never touch the input.
    `CommandError` is a type.
  - Tests:
    - `machine_test.go` ports every case of `machine.test.ts`, named after
      it, with tables where the reference uses `test.each`.
    - `config_test.go` holds the `TestLoad` table of criterion 3.
    - `job_test.go` covers `Clone` independence, the save/load round trip,
      the v2 rejection, `TakenIDs`' reserved names and the dead-pid lock
      takeover.
- Done when: acceptance criteria 3, 4

### T3: Port handoff, harness and roles, ui and tail
- Specialist: backend
- Files: `internal/handoff/handoff.go`, `internal/handoff/handoff_test.go`,
  `internal/harness/role.go`, `internal/harness/harness.go`,
  `internal/harness/command.go`, `internal/harness/playwright.go`,
  `internal/harness/command_test.go`, `internal/ui/ui.go`,
  `internal/ui/prbody.go`, `internal/ui/ui_test.go`, `internal/tail/tail.go`,
  `internal/tail/tail_test.go`
- Pattern: errors: `internal/machine/machine.go` (`CommandError` style);
  tests: `internal/machine/machine_test.go`; embedded data: `assets.go`
- Does:
  - `handoff`: port `src/handoff.ts`. `OutputPath` puts the five docs at
    `paths.Doc(kind)` (`requirements`, `tech-discovery`, `design`, `spec`,
    `test-plan`). The output checks and parsers keep the reference rules.
  - `harness`: port `src/roles.ts` and `src/harness.ts` per design §4 and
    §6.
    - `LoadRole(fs.FS, name)` joins the includes.
    - `Resolve(role, job.Harness, cfg)` takes the harness only from the
      job. No browser forcing and no per-role harness. The model comes from
      `cfg.Models[harness][tier]`, and the timeout from
      `roles.<name>.timeoutMin`, else `timeoutsMin[tier]`.
    - `TaskPrompt` writes the reference lines. `Docs:` holds absolute
      `<jobDir>/docs/<kind>.md` paths.
    - `Command` builds the claude and pi command lines. For browser roles
      it writes `run/playwright.mcp.json` (claude) or `run/playwright.pi.js`
      (pi, `exposure: "direct"`) with mode `0600`, from the one
      `Playwright` value and `PlaywrightTools`.
    - `command_test.go` holds the `TestCommand` cases of criterion 5.
  - `ui`: port `src/ui.ts` and the pure parts of `src/prbody.ts`:
    `WhatFor`, `NextHint`, `StatusTable`, `Steps`, `Paint`, `Ago`,
    `Headline`, `RenderStatus`, `MergeStatus`, `MergeDecision`,
    `InitialBody`, `ProofCoverage`.
    - `RenderStatus(job, cfg, docs)` prints repo-relative doc paths as code
      spans, with no links.
    - `InitialBody` reads "_Work in progress by the factory. Commits land
      here as they are pushed._"
    - `Headline` returns a reason's first line. Test both, `Headline` with
      a multi-line reason.
  - `tail`: port `src/tail.ts`: the claude `stream-json` and pi
    `--mode json` formatters, `LastTool`, and the
    `NO_COLOR`/`FORCE_COLOR`/TTY rules. Test one sample stream per harness.
- Done when: acceptance criterion 5

### T4: Port processes and git, and add the git test kit
- Specialist: backend
- Files: `internal/proc/runner.go`, `internal/proc/exiterror.go`,
  `internal/proc/spawn.go`, `internal/proc/script.go`,
  `internal/proc/notify.go`, `internal/proc/spawn_test.go`,
  `internal/proc/proc_test.go`, `internal/git/git.go`,
  `internal/git/github.go`, `internal/testkit/gitenv.go`,
  `internal/testkit/repo.go`, `internal/testkit/testkit_test.go`
- Pattern: external commands: new: `proc.Runner.Run(ctx, argv, Opts) (Result, error)`
  with `proc.Check` (design §3), ported from `src/exec.ts`; processes: new:
  `Setsid` plus a `Wait` goroutine (design §3 Processes); failure reasons:
  new: `proc.ExitError` with a 20-line tail (design §3); git test isolation:
  new: `testkit.ClearGitEnv` in `TestMain` (design §10)
- Does:
  - `proc` (design §3):
    - `Runner` and the real runner, which fills `Combined` in write order.
    - `ExitError{Cmd, Code, Tail}`: the last 20 non-empty lines, one
      constant, and `Error()` = summary line, blank line, tail.
    - `ProcessSpawner` (`//go:build unix`): `bash <script>` with
      `SysProcAttr{Setsid: true}`, `<name>.pid`, `go cmd.Wait()`,
      `IsAlive` via `Kill(pid, 0)` (nil or EPERM is alive), and `Kill` as
      `Kill(-pid, SIGTERM)`.
    - `InlineSpawner`, the run-script writer, `WaitForFile`,
      `ReadExitCode` and `Shq`, ported from `src/spawn.ts` and
      `src/shell.ts`. The script pipes through `<Self> tail --format <h>`.
    - `Notify`: `osascript` on darwin, `notify-send` on linux, then the
      bell. It never errors.
  - `git`: port `src/git.ts` over `proc.Runner`. `GitError` goes; failures
    are `ExitError`s. Branch pushes never pass `--no-verify`, as today. Add
    `Ahead(worktree, base)` (`git rev-list --count origin/<base>..HEAD`).
  - `testkit` (design §10 "Git's environment"):
    - `ClearGitEnv()` unsets git's `--local-env-vars` list, kept as a
      constant.
    - `TempRepo(t)` makes a repo plus a bare `origin`, and fails at once
      while any of those variables is set.
    - `testkit_test.go` has a `TestMain` that calls `ClearGitEnv`, plus
      `TestTempRepo` and `TestGitEnvCleared` as design §10 describes.
  - Tests: `spawn_test.go` ports both `spawn.test.ts` cases. `proc_test.go`
    covers `ExitError` and `Notify` (criterion 6). Any package whose tests
    run git calls `testkit.ClearGitEnv()` in its `TestMain`.
- Done when: acceptance criteria 6, 7

### T5: Port the driver
- Specialist: backend
- Files: `internal/deps/deps.go`, `internal/driver/run.go`,
  `internal/driver/grill.go`, `internal/driver/step.go`,
  `internal/driver/agents.go`, `internal/driver/stages.go`,
  `internal/driver/hooks.go`, `internal/driver/pr.go`,
  `internal/driver/driver_test.go`
- Pattern: concurrency: new: a `run` struct with a mutex, `update` and
  `snapshot` (design §3 Concurrency); external commands:
  `internal/proc/runner.go`; failure reasons: `internal/proc/exiterror.go`;
  dependency injection: new: one `Deps` struct (design §3), in
  `internal/deps/deps.go`
- Does:
  - `deps.Deps`: the fields in design §3 (`Exec`, `Spawner`, `Git`, `GH`,
    `Roles`, `Self`, `CommandFor(role, files)` with the harness in `files`,
    `Notify`, `Now`, `Sleep`, `Log` (goroutine-safe), `Heartbeat`).
  - `driver`: port `src/driver.ts`, `src/stages.ts`, `src/hooks.ts` and
    `pushProof` from `src/prbody.ts` per design §4.
    - `Run` takes the lock, stops leftovers, steps until the job waits,
      then notifies. `GrillTurn` runs the headless grill with preflight
      inline.
    - Visit markers, reusable outputs, `<role>-<n>` attempts, the
      heartbeat, the 2 s done-file poll, tier timeouts and "window closed"
      detection port one to one.
    - `runAgents` starts every agent from the caller, waits on each in its
      own goroutine, and joins errors. `onResult` and heartbeats touch the
      job only through `update`.
    - No doc commits: `commitDoc`, the doc pushes, `alsoCommit` and
      `docLinks` go. Preflight only runs the access check.
    - `build` calls `ensurePR` after each push. `ensurePR` is a no-op while
      `Ahead` is 0, else it finds or creates the draft PR, then runs
      `prOpened` and `qaUrl`. When every task is done and `job.PR` is still
      empty, `build` fails with
      `build made no commits ahead of <base>: nothing to open a PR for`.
    - `updatePR` passes repo-relative paths of the docs that exist to
      `ui.RenderStatus`. One-line places use `ui.Headline(reason)`. The
      decision block fences the full reason.
    - `pushProof` keeps today's recipe and runs only in finalize. Its push
      is `git push --no-verify --force origin <sha>:refs/heads/factory-proof/<id>`.
    - Hooks run `bash -c` in the worktree with `JOB`, `PR`, `BRANCH` and
      `SHA`. `qaReady` polls until it passes or times out.
    - The driver keeps Go's default signal handling (design §3 Signals).
  - `driver_test.go` (fake `proc.Runner`):
    - `ensurePR` makes no gh call while `Ahead` is 0;
    - `pushProof`'s argv carries `--no-verify` and adds only the proof
      folder;
    - concurrent `update` calls don't race under `-race`.
- Done when: `go build ./... && go vet ./... && go test -race ./internal/driver/`
  pass. Criteria 9 to 13 are proven end to end by T7.

### T6: Port the operations and the cobra commands
- Specialist: backend
- Files: `internal/app/deps.go`, `internal/app/new.go`,
  `internal/app/answer.go`, `internal/app/status.go`,
  `internal/app/logs.go`, `internal/app/approve.go`,
  `internal/app/feedback.go`, `internal/app/unblock.go`,
  `internal/app/run.go`, `internal/app/discard.go`, `internal/cli/*.go`
  (one file per command), `cmd/factory/main.go`
- Pattern: CLI: `internal/cli/root.go` (from T1); dependency injection:
  `internal/deps/deps.go`; errors: `internal/machine/machine.go`
  `CommandError` and `job.LockError`, mapped in one place in `cli`
  (design §3 table)
- Does:
  - `app`: port the logic of `src/commands/*.ts` and `src/deps.ts`.
    - `MakeDeps(repo, inline)` builds the real set, with `Self` from
      `os.Executable()`.
    - `New`:
      - takes `Harness`, validated before anything is created;
      - names the branch with the job's harness (`nameBranch`), and claims
        the id with `TakenIDs` and `branchExists`;
      - runs `setup`; its failure reason is an `ExitError` tail;
      - rolls back on failure, then runs the first `GrillTurn`.
    - `Answer`, `Status`, `Logs` (`-f` follows until the done file),
      `Approve`, `Feedback`, `Unblock` and `Retry`/`Run` keep the reference
      behaviour. `Run` respawns `<Self> run <id> --here --repo <repo>`.
    - `Discard` confirms, takes `--yes`, refuses without a TTY, and
      archives to `.factory/archive/<id>-<ms>`.
  - `cli`: one cobra command per operation, plus hidden `tail --format`
    and `run --here`.
    - The `new`, `status`, `logs`, `approve`, `feedback`, `answer`,
      `unblock`, `run` and `discard` flags are in the design's API table.
    - Positionals before and after `--` join into one string.
    - `--repo` refuses a linked worktree.
    - `status <id>` prints the full multi-line reason. The table shows
      `ui.Headline`. `--json` prints v3 jobs plus `hint` and `whatFor`.
    - `!` lines stay warnings. Errors print as `factory: <msg>` and exit 1.
  - Don't add `dashboard` here (T8 does).
- Done when: `go build ./... && go vet ./...` pass, and
  `go run ./cmd/factory --help` lists every command but `dashboard`.
  Behaviour is proven by T7.

### T7: Add the fakes and port the end-to-end suite
- Specialist: backend
- Files: `internal/testkit/bins.go`, `internal/testkit/scenario.go`,
  `internal/testkit/clock.go`, `internal/testkit/fakeagent/main.go`,
  `internal/testkit/fakegh/main.go`, `internal/e2e/e2e_test.go`
- Pattern: tests: new: fake binaries built once in `TestMain` (design §10),
  with `internal/testkit/testkit_test.go` for `ClearGitEnv` in `TestMain`;
  external commands: `internal/proc/runner.go`
- Does:
  - `testkit`:
    - `BuildBins` runs `go build` once into a temp `bin/` for `factory`,
      `fake-agent` and `gh` (fakegh).
    - `Scenario` holds verdicts per role and visit in a JSON file.
    - `FakeClock` advances on `Sleep`.
  - `fakeagent`: port `src/__tests__/fixtures/fake-agent.ts`. Builders
    commit, validators write `proof/ac<k>-…`, the grill asks once and then
    writes the doc, and `sleepMs` drives the heartbeat. Output is claude
    `stream-json`. It reads the spec from the absolute `Docs:` path.
  - `fakegh`: state in `$FAKE_GH_DIR`, every call appended to
    `calls.jsonl`. It answers the calls listed in design §10, and any other
    call exits 1 and names itself.
  - `e2e_test.go`:
    - `TestMain` calls `ClearGitEnv`, then `BuildBins`. `gh` goes first on
      `PATH`, next to `claude` and `pi` stubs that exit 99. Hooks log to a
      file. The temp repo gets a `pre-push` hook that rejects
      `refs/heads/factory-proof/*`.
    - Port all 12 tests of `src/__tests__/e2e.test.ts`, named after them,
      with the assertions design §10 changes (criteria 10 to 12).
    - Add the harness tests (criterion 9), a no-commit build test
      (criterion 12) and the failure-tail test (criterion 13).
- Done when: acceptance criteria 8, 9, 10, 11, 12, 13

### T8: Rebuild the dashboard and the demo
- Specialist: frontend
- Files: `internal/dashboard/server.go`, `internal/dashboard/handlers.go`,
  `internal/dashboard/markdown.go`, `internal/dashboard/templates/*.html`,
  `internal/dashboard/web/app.css`, `internal/dashboard/web/daisyui.mjs`,
  `internal/dashboard/static/app.css`, `internal/dashboard/static/htmx.min.js`,
  `internal/dashboard/static/app.js`, `internal/dashboard/server_test.go`,
  `internal/cli/dashboard.go`, `internal/testkit/demo/main.go`,
  `internal/testkit/demo/seed.go`, `mise.toml`
- Pattern: HTTP server: new: `http.Server` with `ReadHeaderTimeout` and
  graceful `Shutdown` under `signal.NotifyContext`
  (`stow/claude/.claude/skills/go-service-setup/SKILL.md`, design §9); UI:
  new: `html/template` plus htmx 2, Tailwind 4 and daisyUI 5, with a small
  `app.js` (design §9); Markdown: new: goldmark GFM, safe defaults (design
  §9); operations: `internal/app/*.go`; errors: the design §3 table
- Does:
  - Build the server, routes and guards of design §9 and the API table:
    - `Serve(ctx, repo, port, deps)` listens on `localhost:<port>` and
      prints `http://localhost:<port>`. The mux is built in its own
      function.
    - The Host, Origin and `X-Factory` guards, the CSP and `no-store`
      headers.
    - `/jobs/{id}/doc` and `/jobs/{id}/file` go through
      `os.OpenRoot(jobDir)`.
    - POST handlers call `app.Approve`, `app.Retry`, `app.Feedback` and
      `app.Discard`, returning the board fragment, or the error message
      with 400, 409 or 500.
  - Build the UI of the design's UI section, at feature parity with the
    reference `dashboard.html`:
    - the header, "Needs you" with actions per kind, the board and the
      Show discarded toggle;
    - the drawer with its four tabs;
    - the `htmx-config` meta with `allowEval: false` and
      `includeIndicatorStyles: false`, and the indicator styles in
      `web/app.css`.
  - `app.js` does only what htmx can't: toasts on stage changes, browser
    notifications, keyboard shortcuts, keeping the selection, log
    auto-follow, and ⌘/Ctrl+Enter.
  - Vendor `htmx.min.js` (2.x) and `daisyui.mjs` (5.x) at pinned versions.
    Add `"github:tailwindlabs/tailwindcss" = "4.3.5"` and the `css` and
    `demo` tasks to `mise.toml` (design §10). Commit the built
    `static/app.css`.
  - `internal/cli/dashboard.go`: `factory dashboard [--port <n>]`, default
    8000, where 0 picks a free port.
  - `demo`: port `src/__tests__/fixtures/seed-demo.ts`. Seed a temp repo
    with jobs in every state, docs in `<jobDir>/docs/`, and a failure with
    a multi-line reason. Serve with fake deps: actions apply
    `machine.Apply` and save, and nothing is spawned. Leave out the tmux
    leftovers of `serve-demo.ts`. Flags: `-dir` and `-port`.
  - `server_test.go` (httptest) holds the cases of criterion 14.
  - Capture screenshots from `mise run demo` in a browser.
- Done when: acceptance criteria 14, 15, 16, 17

### T9: Remove the TypeScript package and update docs and skills
- Specialist: general
- Files: remove `src/`, `package.json`, `bun.lock`, `tsconfig.json`,
  `.gitignore`, `config.json`, `mcp/`, `dashboard.html` (module folder) and
  `stow/factory/.local/bin/factory`; edit `roles/_common.md`, `README.md`
  (module folder), repo-root `AGENTS.md`, repo-root `README.md`,
  `stow/claude/.claude/skills/factory/SKILL.md`,
  `stow/pi/.pi/agent/skills/factory/SKILL.md`
- Pattern: docs: new: the package README records the module's conventions
  (design §3, §11), and `AGENTS.md` `## Blueprint` points at it
- Does:
  - Delete the files above (design §1, requirement 3). Leave
    `docs/*/rewrite-factory-golang.md` alone.
  - `roles/_common.md`: replace "relative to the worktree" on the `Docs`
    line with "in the job folder" (design §11). No other role changes.
  - Both `factory` skills: "if `factory` is not found" says to run
    `mise run install` in `stow/factory/.local/share/factory`. The
    `/factory <feature>` row adds `--harness pi` when the user asks for pi.
  - `AGENTS.md`:
    - the changes of design §11;
    - the layout table names `lefthook.yml`;
    - Setup uses mise's Go and `mise run install`, and adds
      `lefthook install` and `mise run install` without `FACTORY_BIN_DIR`
      to the commands agents never run;
    - every `lefthook run` gets `--no-auto-install`;
    - the `stow/factory/` validation row is `mise run check` in the module
      folder, with known failures "none";
    - the demo is `mise run demo` on `localhost`;
    - a `## Blueprint` section points Go work in the module at the package
      README's conventions.
    - Don't touch the `task-pipeline` rows.
  - Repo-root `README.md` lines 23, 51 and 53 (at `f7fb2cf`): Go, installed
    with `mise run install`.
  - Rewrite the package `README.md` per design §11:
    - the commands with `--harness`;
    - the config keys and merge rule;
    - the state: docs in the job folder, the proof ref, the PR at the first
      build push;
    - browser roles on both harnesses, with the two pi notes and the manual
      pi check;
    - embedded roles, install (`FACTORY_BIN_DIR`), checks, tests
      (`ClearGitEnv` in `TestMain`) and the demo;
    - the design §3 conventions;
    - the switch-over steps.
  - Run the final checks from the module folder and the repo root:
    criteria 18 to 23. Install only into a temp `FACTORY_BIN_DIR`.
- Done when: acceptance criteria 18, 19, 20, 21, 22, 23

### T10: Run one real job end to end with the Go binary
- Specialist: general
- Files: none in the repo. Proof only.
- Pattern: none
- Does:
  - Work in `S=${TMPDIR:-/tmp}/factory-real-run`. If it already holds a job
    (an earlier attempt), resume that job with `factory status` and
    `factory run`, instead of starting over.
  - Build the binary:
    `FACTORY_BIN_DIR="$S/bin" mise run install` in the module folder. Build
    fakegh: `go build -o "$S/bin/gh" ./internal/testkit/fakegh`. Put
    `$S/bin` first on `PATH` and set `FAKE_GH_DIR="$S/gh"`.
  - Make the scratch repo `$S/repo` with a bare `$S/origin.git` as
    `origin`, one commit on `main`, a short `AGENTS.md` (a `bash -n`
    validation rule), and a `.factory.json` with
    `{"validators":["e2e"],"maxTrips":1,"models":{"claude":{"high":"sonnet"}}}`.
  - Start a tiny request with `factory new --repo "$S/repo" -- "add a hello.sh script that prints hello"`.
  - Answer each grill question with `factory answer <id> -- …`, as a human
    who wants exactly that script, deliverable `pr`, with access to `bash`
    only.
  - Poll `factory status <id>` every minute. Approve at human review, and
    approve or retry where a cap or env stop needs a human. Stop when it
    shows `done`.
  - Real `gh` must never run: check `command -v gh` resolves to `$S/bin/gh`
    before starting.
  - Capture criterion 24's checks into the proof folder. Keep local paths
    as they are, and include no tokens.
- Done when: acceptance criterion 24

## Review
Lenses: product, code, security, ux, ui
The dashboard is rebuilt with a new stack and look, so a user sees the
board, tickets, drawer, toasts and shortcuts change. The CLI gains
`--harness`, and status output changes for multi-line reasons.

## Run
T1, T2, T3, T4, T5, T6, T7, T8, T9, T10
