# Tech discovery: Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

The reference is `origin/main` at `f7fb2cf`. This worktree is at `f0be919` plus
the requirements commit (`6f44902`), so its copy of `stow/factory` is stale: it
still has `src/commands/attach.ts` and lacks `answer.ts` and `unblock.ts`
(`git diff --stat f0be919 origin/main`, 42 files, +1142/-369). Everything below
was read from an extract of `origin/main` (`git archive origin/main stow/factory …`).
Paths are relative to `stow/factory/.local/share/factory/` unless they start
with `stow/`, `modules/`, `hosts/` or a repo-root file.

## Findings

### Where it lives

Install and launch today

- `stow/factory/.local/bin/factory`: a two-line bash launcher,
  `exec bun "$HOME/.local/share/factory/src/cli.ts" "$@"`. On this host
  `~/.local/bin/factory` is a stow symlink to it, and `~/.local/share/factory`
  is a folded stow symlink to the main checkout's package folder (`ls -la`
  shows both). [high]
- The running TS factory, which drives this job, calls the main checkout's code,
  not the worktree's. `run/tech-discoverer-1.sh` pipes through
  `'…/bun/1.4.4/bin/bun' '/Users/marco/w/marco-souza/nixos/stow/factory/.local/share/factory/src/cli.ts' tail --format claude`.
  Edits in this worktree do not change the job's own machinery. [high]
- `modules/nixos/common.nix:138` and `hosts/macos/default.nix:109` run
  `sh stow.sh stow zsh tmux ghostty pi mise factory` on every system
  activation. [high]
- `stow/zsh/.zshrc:1` puts `~/.local/bin` on PATH, and `:5` runs
  `mise activate`. [high]

CLI, config, state (`src/`, 4.5k lines of TS, no runtime dependencies)

- `cli.ts` (166 lines): a hand-written argv parser and a command table (usage,
  about, example, positional min/max, allowed flags). `--repo <path>` works on
  every command and refuses a linked worktree. `--` ends options. Valued flags:
  `repo, port, format, base, stack`. Hidden commands are `tail --format claude|pi`
  (used by run scripts) and `run --here` (the background driver). Errors print
  as `factory: <msg>` in red, `FACTORY_DEBUG=1` adds the stack, and
  `ReportedError` means "already printed, exit 1". [high]
- `config.ts` (72 lines): `config.json` (package defaults) is deep-merged with
  the repo's `.factory.json`. Objects merge; arrays and scalars replace. It
  checks validators against `e2e, user, load, capacity`. Other keys: `base`,
  `prTitle`, `setup`, `docs.*`, `hooks.{prOpened,qaUrl,qaReady}`,
  `roles.<name>.{harness,tier,timeoutMin}`, `defaultHarness`,
  `models.{claude,pi}.<tier>`, `timeoutsMin`, `maxTrips`, `maxDiscoveryLoops`,
  `qaReadyTimeoutMin`, `qaPollSec`, `docsCommitType`. [high]
- `paths.ts` (63 lines): `findRepo` runs
  `git rev-parse --path-format=absolute --git-dir --git-common-dir`.
  `jobPaths` lays out `.factory/jobs/<id>/` as `job.json`, `activity.log`,
  `logs/`, `done/`, `run/`, `grill/`, `proof/`, `pr.md`, `report.md`,
  `access.md`, `trip-<t>/`, `discovery-review-<n>.md`, `feedback-<k>.md` and
  `decision-<k>.md`, with the worktree at `.factory/<id>`. `PACKAGE_DIR` is the
  source folder; `CLI_PATH` is how the CLI calls itself again. [high]
- `job.ts` (162 lines): the `Job` v2 record. `saveJob` writes a tmp file and
  renames it. `listJobs` sorts newest first and skips unreadable files.
  `appendActivity` writes `HH:MM:SS <line>`. Slots come from `nextSlot` and
  `heldSlots`. [high]
- `machine.ts` (223 lines): a pure state machine with no I/O.
  `route(job, outcome, limits, now)` and `applyCommand(job, command, now)`
  cover approve, feedback, retry, unblock and discard. It handles waiting
  stages, the trip, discovery-loop and ENV caps, and how `stamp` sets
  `waitingSince`. [high]
- `driver.ts` (402 lines):
  - `runJob` takes the lock, stops leftover agents, steps until the job waits,
    then notifies.
  - `grillTurn` is the headless grill: a `grill/visit` key, `transcript.md` and
    `question.md`. It also runs preflight inline.
  - `step` runs stage → outcome → route → save → activity line → `updatePr`.
  - A per-visit marker file plus mtimes decide whether an output was "written
    this visit".
  - `runAgents` skips reusable outputs, starts all agents before waiting on
    any, retries each failed agent once, and calls `onResult`.
  - `startAgent` names attempts `<role>-<n>` and writes `.system.md`,
    `.task.md` and `.sh`.
  - A heartbeat logs every 30 s with the agent's last tool.
  - `finishAgent` polls the done file every 2 s, applies the per-tier timeout,
    and detects a window that died without a done file. [high]
- `stages.ts` (480 lines): one effect per stage. preflight runs the
  access-checker, commits the requirements doc, opens the draft PR, runs the
  `prOpened` marker and `qaUrl`. build runs one builder per task, keeps a
  `built` resume list and pushes after each task. review runs the lenses in
  parallel. rebase fetches, rebases, runs the resolver on conflict, and pushes
  with `--force-with-lease` (line 359). qa-wait moves validation files aside on
  an ENV retry. finalize runs `pushProof`, the summarizer, proof coverage, the
  title template, `ready`. `docLinks` (line 473) builds the PR's `Docs:` links
  as `github.com/<nwo>/blob/<branch>/<docs path>`. Browser roles get
  `http://localhost:${5100+10*slot+i}`. [high]
- `handoff.ts` (304 lines): output path per kind. The five docs go to
  `<worktree>/<cfg.docs.*>/<id>.md` (line 55). It holds the output checks
  (first line, headings, verdict words, `## Questions`) and the parsers: plan
  tasks, run, lenses and criteria; test-plan validators; the discovery verdict;
  the requirements title, deliverable and access; design questions. [high]
- `harness.ts` (125 lines):
  - `resolveHarness` forces browser roles onto claude
    (`role.browser ? 'claude' : …`, line 37). It applies per-role overrides and
    maps tier to model and timeout.
  - `renderTaskPrompt` writes the `Job/Request/Worktree/Job folder/Cycle
    Trip/Base/Docs/Assignment/Output/Inputs/Target` lines.
  - `buildCommand` for claude: `-p "$(cat task)"`,
    `--append-system-prompt-file`, `--model`, `--permission-mode auto`,
    `--add-dir <jobDir>`, `--mcp-config mcp/playwright.json` and 12
    `mcp__playwright__browser_*` tools for browser roles, allowed and
    disallowed tools, `--output-format stream-json --verbose`.
  - `buildCommand` for pi (line 116-124): `-p --append-system-prompt <file>
    --model --tools <read,grep,find,ls,bash,edit,write subset> --mode json
    "<task>"`, with no browser. [high]
- `roles.ts` (79 lines): parses frontmatter (`name, description, tools,
  browser, tier, include`) and joins the includes (`_common`, `_builder`). [high]
- `spawn.ts` (159 lines):
  - The run script does `cd … || echo 97 > done`, then
    `<cmd> 2>&1 | tee -a <log> | <bun> <cli.ts> tail --format <h>`, then writes
    `${PIPESTATUS[0]}` to the done file (line 34).
  - `ProcessSpawner` uses `Bun.spawn(…, {detached: true})` plus `unref()`, one
    `<name>.pid` per process in `run/`, and kills with `process.kill(-pid)`
    (lines 63, 97).
  - `InlineSpawner` runs the script to completion.
  - It also defines `waitForFile` and `readExitCode`. [high]
- `lock.ts` (51 lines): `driver.lock` created with `wx` (O_EXCL). A dead pid's
  lock is taken over; EPERM counts as alive. [high]
- `git.ts` (226 lines):
  - `Git`: `ensureExcluded` adds `/.factory/` to info/exclude. `createWorktree`
    marks `branch.<b>.factory=true`. Also `commitPaths`, `head`, `push` (factory
    branches only), `rebase`, `removeWorktree`, `deleteBranch` (local and
    remote), `branchExists`.
  - `GitHub` over `gh`: `auth status`, `repo view` (defaultBranchRef and
    nameWithOwner), `pr view --json headRefName|body|comments,reviews`,
    `pr list --head`, `pr create --draft --assignee @me`,
    `pr edit --body-file|--title`, `pr ready [--undo]`, `pr close`,
    `api repos/{owner}/{repo}/pulls/<n>/comments --paginate`. Bot comments are
    dropped.
  - `GitError` keeps only the first non-empty stderr line (line 8). [high]
- `hooks.ts` (45 lines): runs `bash -c <script>` in the worktree with
  `JOB, PR, BRANCH, SHA` and the process env. qaReady polls until exit 0 or the
  timeout. A hook failure reports only its first stderr line
  (`stages.ts:123`). [high]
- `prbody.ts` (176 lines): the status block between
  `<!-- factory:status -->` markers (step table, marks, `Docs:` links), the
  decision block, the initial body, `proofCoverage`, and `pushProof`. `pushProof`
  uses a temp `GIT_INDEX_FILE`, `commit-tree`, and
  `git push --force origin <sha>:refs/heads/factory-proof/<id>` with
  `cwd: repo`, the main checkout, and no `--no-verify` (line 174). [high]
- `tail.ts` (222 lines): formats claude `stream-json` and pi `--mode json`
  events. The pi event names match pi 1.5.2's `docs/json.md`
  (`message_end`, `tool_execution_start/end`, `auto_retry_end`,
  `agent_settled`). It has `lastTool` for heartbeats, and colors follow
  `NO_COLOR`/`FORCE_COLOR`/TTY. [high]
- `ui.ts` (157 lines): `whatFor`, `nextHint`, `nextLines`, `pipelineLine`,
  `statusTable`, `ago`, `prNumber`, `paint`. The CLI, the driver and the
  dashboard share them, so all three say the same thing. [high]
- `notify.ts` (27 lines): `osascript` on darwin, `notify-send` on linux, then a
  terminal bell. It never throws. [high]
- `ids.ts` (70 lines): the branch name comes from the default harness's
  low-tier model (`claude -p … --strict-mcp-config --model haiku`, or
  `pi -p`), with `feature/<slug>` as fallback. Also `caseBranch`, `jobIdFor`,
  `ticketOf`, and `takenIds`, which also scans the requirements docs folder.
  [high]
- `server.ts` (262 lines):
  - Bun.serve on `127.0.0.1` (line 248), with Origin and Host checks against
    DNS rebinding (line 198).
  - `GET /` serves `dashboard.html` with `{{PROJECT}}` filled in.
    `GET /api/jobs` returns jobs plus `hint`, `whatFor` and `steps`, the
    `STEPS` table and limits. `GET /api/jobs/:id` returns docs (with
    `exists`, read from `<worktree>/docs`), trip folders, the last 200 activity
    lines and log names. `GET …/file?path=` serves the job dir or
    `<worktree>/docs/` only, symlink-safe, with 403/404 (line 116-133).
    `GET …/log?name=&lines=` returns formatted lines with ANSI stripped.
  - `POST …/{approve,retry,feedback,discard}` needs `X-Factory: 1`. approve
    and retry return 409 when a live driver holds the lock. [high]
- `commands/`:
  - `new`: gh preflight, info/exclude, base from `--base`, `--stack`, config or
    the default branch, branch naming, id claim with `-2…` suffixes, worktree,
    `setup` commands (last 30 output lines on failure), rollback, then the first
    grill turn.
  - `answer`: one grill turn. Prints `QUESTION for <id>:` or starts the driver,
    or prints a `!` warning.
  - `status`: the table plus hints, a detail view, `--json`.
  - `logs`: the latest or a role's log, `detectFormat`, the last 200 lines,
    `-f` follows until the done file appears.
  - `approve`, `unblock` (`decision-<k>.md` plus retry), `run` (retries when
    needs-human, `--inline`, background respawn).
  - `feedback`: PR comments since the last feedback file, plus the note, go to
    `feedback-<k>.md`. It kills the driver and agents, turns a done PR back to
    draft, and moves the job to a free slot.
  - `discard`: confirm, `--yes`, or refuse without a TTY. Best-effort teardown,
    then the folder moves to `.factory/archive/<id>-<ms>`.
  - `dashboard`: port 8000 by default; 0 picks a free port. [high]
- `dashboard.html` (1644 lines of vanilla JS and CSS, no build step):
  - It polls `/api/jobs` every 2 s and shows header counts, a sync dot, a
    "Notify me" button and help.
  - "Needs you" tickets carry per-kind actions:
    - grill: discard
    - review: approve, feedback, Open PR, discard
    - env: retry, approve, Read why, discard
    - escalation: approve, feedback, Read why, Open PR, discard, plus the
      judge's first question, fetched from its file
    - failure: retry, Open logs, discard
  - The inline feedback box sends on ⌘/Ctrl+Enter.
  - The board has one column per step group plus Done; discarded jobs sit
    behind a toggle.
  - The drawer has Timeline, Docs, Trips and Logs tabs. A client-side Markdown
    renderer sanitizes URLs (`safeUrl`, `safeHref`). The log view follows the
    end.
  - Toasts show on stage changes. A browser `Notification` fires when a job
    starts needing you.
  - Keys: `j`/`k`, Enter, `a`, `f`, `?`, Esc.
  - The page has no `answer` or `unblock` action, so the reference offers
    exactly approve, feedback, retry (`run`) and discard. [high]
- Data files: `config.json`, `mcp/playwright.json`
  (`npx -y @playwright/mcp@0.0.86 --isolated --headless`), `roles/*.md` (27
  files with `_common.md` and `_builder.md`), `README.md`, `package.json`,
  `bun.lock`, `tsconfig.json`, and `.gitignore` (`node_modules/`). [high]
- Tests:
  - `src/__tests__/e2e.test.ts` (401 lines) uses real git, real roles and inline
    fake agents. `gh` is answered in process. `claude`, `pi` and `gh` stubs that
    exit 99 sit first on PATH. Hooks log to a file.
  - `machine.test.ts` (453 lines, about 45 cases, `test.each` included) and
    `spawn.test.ts` (2 tests with real processes).
  - `helpers.ts` has `FakeExec` and `tempRepo`, a repo with a bare origin.
  - `fixtures/fake-agent.ts` is driven by a scenario of verdicts per visit.
    Builders commit, validators write `proof/ac<k>-…`, the grill asks once and
    then writes the doc, and `sleepMs` exercises the heartbeat.
  - `fixtures/seed-demo.ts` (510 lines) and `fixtures/serve-demo.ts` back the
    demo dashboard.
  - `bun test` on the extract gave 98 pass, 0 fail, 3 files, 27.6 s (ran). [high]
- Other files that name the factory:
  - `stow/claude/.claude/skills/factory/SKILL.md` and
    `stow/pi/.pi/agent/skills/factory/SKILL.md` both say "if `factory` is not
    found … run `./stow.sh stow factory`".
  - `AGENTS.md` lines 17, 35, 56, 70, 72-76 (Bun, `bun test`, the demo
    commands).
  - `README.md` lines 23, 51, 53.
  - `roles/_common.md:18` says the Docs are "relative to the worktree".
  - `roles/requirements.md:117` names `factory discard <job>`. [high]
- Toolchain on this host:
  - `go1.27.4 darwin/arm64` comes from mise (`~/.config/mise/config.toml`, not
    stow-managed, `go = "latest"`). Homebrew Go and nixpkgs `go`
    (`modules/shared/default.nix:37`) are also on the host.
  - `golangci-lint` 2.15.0 was built with go1.27.2.
  - `lefthook` 2.2.3 comes from mise global.
  - `gofumpt`, `goimports` and `gopls` are not on PATH.
  - The repo has no Go file, `go.mod`, `.golangci.yml`, `lefthook.yml`,
    root `.gitignore` or CI (`git ls-files`, `ls -a`). [high]

### Blueprint

`AGENTS.md` has no `## Blueprint` section, and the repo has no Go code. The
closest thing to a Go convention is Marco's own skill
`stow/claude/.claude/skills/go-service-setup/SKILL.md`. It covers `cmd/<name>/main.go`
plus `internal/<domain>/`, a thin `main` that calls `run()`, which returns an
error, with one `os.Exit`, `signal.NotifyContext`, and an `http.Server` with
`ReadHeaderTimeout` and graceful `Shutdown`. It is stdlib first ("no deps unless
forced"). It gives a `lefthook.yml` shape (gofmt plus `golangci-lint run --fix`
on staged `*.go`, `go test ./...` on pre-push). It notes that golangci-lint v2
already runs govet but checks no formatting without a config. It is written for
services (slog JSON logs, env config, Dockerfile), so only part of it fits a
CLI. [high for the content, medium for the fit]

- CLI: cobra, settled in the requirements. The reference's semantics to keep
  or decide are `--` before free text (both skills always pass it), positionals
  joined into one string, `--repo` on every command, and the hidden
  `tail`/`run --here`. Reference: `src/cli.ts`. [high]
- Dependency injection and testability: one `Deps` bag (exec, spawner, git,
  gh, rolesDir, `commandFor`, notify, now, sleep, log, heartbeatMs) and one `Cli`
  (out, err, confirm, terminal, deps). Tests swap the fakes in. Reference:
  `src/deps.ts`, `src/commands/shared.ts`. In Go these map to interfaces.
  [high]
- External commands: all git, gh, hook and setup calls go through
  `Exec.run(cmd[], {cwd, env, input}) → {code, stdout, stderr}`. Reference:
  `src/exec.ts`. [high]
- Errors: typed errors map to exit codes and HTTP status. `CommandError` is
  400, `LockError` 409, `HttpError` carries its own status, anything else is
  500. `ReportedError` means already printed. Reference: `src/server.ts:250-258`,
  `src/cli.ts:160`. Go equivalent: typed errors with `errors.As`. [high]
- Persistence: JSON files with tmp+rename. Reference: `src/job.ts` `saveJob`.
  [high]
- Concurrency: none to copy. TS relies on one thread (`Promise.allSettled` in
  `driver.ts:286`). Go needs its own pattern, which is a gap. [high]
- HTTP: `Bun.serve` today. The skill's `net/http` server pattern applies. [high]
- UI building blocks: no Go templates, htmx, Tailwind or daisyUI exist in the
  repo. Each is a gap: how assets are built and embedded, and how Markdown is
  rendered. [high]
- Logging and output: the CLI prints human lines with ANSI through `ui.paint`.
  The skill's `slog` JSON is for services and conflicts with that. This is a gap.
  [medium]
- Tests: there is no Go test convention. Stdlib `testing` or testify, and how to
  fake `claude`/`pi`/`gh` (helper-process re-exec, built fixture binaries, or the
  in-process `Exec` fake as today), are gaps. The skill asks for table tests.
  [medium]
- Lint and format config: none exists. Which golangci-lint linters, and gofmt or
  gofumpt or goimports, is a gap. [high]

### Reuse

- `src/machine.ts` and `machine.test.ts`: the state machine is pure, and its
  about 45 cases can serve as the Go table tests one-to-one. [high]
- E2e harness design: a real repo with a bare origin (`helpers.ts tempRepo`),
  the scenario-driven fake agent (`fixtures/fake-agent.ts`), stubs first on PATH
  that exit 99, an in-process gh fake that records calls and fails unknown ones,
  and hooks that log to a file. This covers requirement 14's "fake claude, pi
  and gh, real git". [high]
- The roles, `_common.md`, `_builder.md` and `mcp/playwright.json` carry over.
  Only the Docs line and doc paths need to change. [high]
- `go-service-setup` skill: the `http.Server` and graceful shutdown snippet, and
  the `lefthook.yml` shape. [high]
- pi has built-in MCP (pi 1.5.2: `pi mcp …`, `--no-mcp`). There is no per-run
  `--mcp-config`. Servers come from `~/.pi/agent/mcp.json`, from `.pi/mcp.json`
  in a trusted project (`--approve` trusts it for one run), or from an extension
  passed with `-e <file>` that calls `pi.registerMcpServer(name, {command, args,
  exposure})` (pi `docs/extensions.md` "MCP Servers", `docs/mcp.md`,
  `docs/cli.md:121-158`). MCP tools default to `codemode` exposure. A plain
  `--tools` list declares no MCP tool unless an entry matches it, for example
  `'mcp__playwright__*'`. [medium: read in the docs, not run]
- golangci-lint v2 has built-in formatters: gofmt, gofumpt, goimports, gci and
  golines (`golangci-lint help formatters`). One tool could format and lint.
  [high]
- mise already installs Go and lefthook here. A `mise.toml` with only `[tools]`
  and `[tasks]` ran from an untrusted folder with no trust prompt (`mise run
  hello` in `/tmp`, ran). [high]
- NixOS has `programs.nix-ld.enable = true` (`modules/nixos/common.nix:71`), so
  the prebuilt binaries mise downloads (golangci-lint, lefthook, a Tailwind
  standalone CLI) should run there. [medium]

### Constraints

- Agents never run `./stow.sh`, `make switch|boot|mac|update|hardware`: they
  change the running system, `$HOME` or `flake.lock`. Source: `AGENTS.md`
  "Setup". `mise run install`, which writes `~/.local/bin/factory`, and
  `lefthook install`, which writes the shared `.git/hooks`, change `$HOME` and
  the main checkout in the same way. Source: `AGENTS.md`, `_common.md`
  "Never".
- `$HOME` symlinks point at the main checkout. Worktree edits are not live until
  merged. Source: `AGENTS.md`.
- Commits are `<type>: <lowercase summary>` with `fea`/`enh`/`fix`. Source:
  `AGENTS.md` "Conventions".
- Factory files hold nothing repo-specific. Source: `AGENTS.md`,
  `README.md` of the package.
- Flakes only see tracked files. A Nix eval is only needed if a `.nix` file
  changes. Source: `AGENTS.md`.
- Settled in the requirements: Go 1.27, cobra, TS, Bun tests, `package.json`,
  `bun.lock`, `tsconfig.json` and the Bun launcher all removed;
  `--harness claude|pi` per job, with no per-role harness override; Playwright
  for browser roles on both harnesses; the dashboard on `localhost` with no
  auth; job docs never committed; the proof push with `--no-verify`; failures
  show the last lines of output; `mise.toml` pins Go, golangci-lint and
  lefthook; lefthook only checks Go. Source: requirements doc.
- Out of scope: `task-pipeline`, chrome-relay, migrating old jobs and configs,
  a Nix package. Source: requirements doc.
- No direct commits to `main`, because other repos still use the TS factory
  from main. Source: requirements "Decisions".

### Weak spots

- Package-dir coupling: roles, `config.json`, `mcp/playwright.json` and
  `dashboard.html` are found through `PACKAGE_DIR = import.meta.dir/..`
  (`paths.ts:4`), and run scripts and the driver call the CLI again through
  `process.execPath` plus `CLI_PATH` (`spawn.ts:34`, `driver.ts:26`). A copied Go
  binary in `~/.local/bin` has neither. Roles must be embedded or read from a
  known folder. Role edits are live today with no build step. [high]
- Docs-in-worktree is baked in at about eight places: `handoff.ts:55`;
  `stages.ts` `commitDoc`, `writeDoc` and `docLinks`; `server.ts`
  `jobDetail`/`readJobFile` (`<worktree>/docs` root); `ids.ts takenIds`;
  `_common.md:18`; `fake-agent.ts criteria()`, which reads the spec from the
  worktree; and the e2e assertions on `docs/*` files and the
  `docs: … for <id>` commits. Requirement 9 removes all of them. Requirement 9
  also makes the config keys `docs` and `docsCommitType` meaningless. [high]
- First-line-only failure reasons: `git.ts:8` and `stages.ts:123`. This is the
  root cause behind the `feedback.md` report. [high]
- One-thread assumptions: `runAgents` runs agents side by side, and each
  `onResult` calls `c.update` (`setTrip`), which saves `job.json`. The heartbeat
  timers read logs. That is safe on JS's one thread. Go goroutines would race on
  the job and its file. `route` and `applyCommand` must "never mutate" their
  input (`machine.test.ts:225`, `:446`). Go slices and maps in `Job.Trips`, the
  `reviews` and `validations` maps, and `decisions` share backing storage unless
  copied. [high]
- Child reaping: Bun reaps detached children. In Go, an un-`Wait`ed child
  becomes a zombie, and `kill(pid, 0)` on a zombie succeeds. `isAlive` would
  then stay true, `finishAgent` would never see "window closed", and
  `spawn.test.ts` "is not alive afterwards" would fail. [high: Unix semantics]
- Detach semantics: the reference relies on `detached: true`, a new session and
  process group, so `kill(-pid)` takes the tree and a closed terminal does not.
  The Go side needs `SysProcAttr{Setsid: true}`. [medium: from Node's
  documented `detached`; Bun's is inferred]
- Self-invocation in tests: run scripts pipe through `<cli> tail`, and the
  driver respawns `<cli> run <id> --here`. In `go test`, `os.Executable()` is the
  test binary. A test must build the binary or inject the CLI path. [high]
- `fixtures/serve-demo.ts` still implements `ensureSession` and `killSession`,
  tmux leftovers that `Spawner` no longer has. `tsconfig.json` `include` does
  not cover `fixtures/`, so the demo code was never type-checked. [high]
- The dashboard is a client-side SPA. Server-rendered htmx fragments can replace
  the board and drawer rendering. They cannot replace the JS for toasts on stage
  changes, browser notifications on "needs you", keyboard shortcuts, focus kept
  across refreshes, log auto-follow, or the ⌘/Ctrl+Enter send. Those need JS, or
  htmx events/`HX-Trigger` plus a small script. This is the largest and least
  one-to-one part of the port. [medium]
- Stow folds the package: any file at `stow/factory/` root is linked into
  `$HOME`. A `stow -n -v` simulation shows `LINK: go.mod => …` and
  `LINK: mise.toml => …` (ran). Activation runs it on every switch. [high]
- `go build -o ~/.local/bin/factory` onto a symlink to an existing non-binary
  file fails with "already exists and is not an object file". Onto a dangling
  symlink it replaces the link with the binary. Tested in `/tmp`. Until the TS
  launcher is gone from the main checkout, an install into `~/.local/bin`
  fails. [high]

### Validation

- Reference baseline: `bun test` in an extract of `origin/main`'s package gives
  98 pass, 0 fail across `e2e.test.ts`, `machine.test.ts` and `spawn.test.ts`
  (ran). The Go tests should cover the same cases: requirement 14. [high]
- Go checks, from the Go module folder: `go build ./...`, `go vet ./...`,
  `gofmt -l .` (or the chosen formatter through `golangci-lint fmt --diff`),
  `golangci-lint run ./...`, `go test -race ./...`. Use `-race` because of the
  goroutine weak spot. `golangci-lint` 2.15 ran clean on a scratch module with
  `go 1.27` and with `go 1.27.4` (ran). [high]
- Hooks without installing them: `lefthook validate`,
  `lefthook run pre-commit --all-files`, `lefthook run pre-push --force`.
  Never `lefthook install` from an agent. [high]
- Install task: run `mise run install` only with a temp destination or `HOME`,
  never the real `~/.local/bin`. [high]
- Demo dashboard: the Go equivalent of `seed-demo` plus `serve-demo` (fake
  deps), opened in the browser roles' Playwright at the job's `Target`
  (`http://localhost:5110+` for slot 1, `stages.ts localUrl`). [high]
- Real run (requirement 17): a scratch repo with a local bare origin, real
  `claude`, and a fake `gh` first on PATH that answers every call in the
  `GitHub` list above and records `pr create`/`pr edit`. The binary is built to a
  temp path. [high]
- `nix eval` and `nix fmt` only if a `.nix` file changes. `bash -n stow.sh` only
  if `stow.sh` changes. Source: `AGENTS.md` "Validation". [high]

## Risks

1. Stale base, and a rebase that breaks the build-stage push: `HEAD` is
   `f0be919` plus `6f44902`, and `origin/feature/rewrite-factory-golang` is
   already at `6f44902` (`git ls-remote`).
   - Builders who read the worktree's `stow/factory` port the wrong version: it
     has `attach`, and lacks `answer`, `unblock` and the headless grill.
   - The TS build stage pushes after each task without force (`stages.ts:97`,
     `:303`). A builder who rebases onto `f7fb2cf` rewrites pushed history, so
     the next push is rejected and the stage fails.
   - If the branch is not updated first, the later `rebase` stage hits
     modify/delete conflicts on every TS file `f7fb2cf` changed and the build
     deleted.
   - A merge of `origin/main` keeps the push fast-forward, and requirement 1
     only asks that the branch contain `f7fb2cf`. That is an inference from the
     push code.
2. Agents touching `$HOME` or the shared git dir:
   - `mise run install` into `~/.local/bin` either fails, because the TS
     launcher symlink is still there, or, if it removes the link, it breaks the
     `factory` command other repos still use from main (requirements
     "Decisions").
   - `lefthook install` writes the shared `.git/hooks`. The TS factory's own
     pushes of this job, and every commit in the main checkout, would then run Go
     lint and tests.
   - Both commands are part of the deliverable, but only the human may run them.
3. Stow links package-root files into `$HOME`. If `go.mod`, `mise.toml`,
   `.golangci.yml`, `cmd/` or `internal/` sit at `stow/factory/` root, every
   activation links `~/go.mod`, `~/mise.toml`, and so on. A `~/mise.toml` would
   pin Go for every project under `$HOME`. The fix is to put them under
   `.local/share/factory/` or add a `stow/factory/.stow-local-ignore`, which
   replaces stow's default ignore list. Locations: `modules/nixos/common.nix:138`,
   `hosts/macos/default.nix:109`.
4. lefthook config location: lefthook reads `lefthook.yml` from the git
   toplevel. `LEFTHOOK_CONFIG` exists, but git does not set it when it runs
   hooks. So the config is a new repo-root file, scoped with `root:` and
   `glob: "*.go"` to the factory module. Once installed, pre-push runs the Go
   tests on every push of this repo, factory job branches included. A slow or
   flaky e2e test then blocks pushes.
5. Doc links in the PR body (requirement 9) have no target yet. Today's
   `Docs:` line links `github.com/<nwo>/blob/<branch>/docs/…`
   (`stages.ts:473`). Files in `.factory/jobs/<id>/` have no GitHub URL. A
   `localhost` dashboard link only works on Marco's host. Pushing them to
   `factory-proof/<id>` puts them on a ref of the repo, which may count as
   "committed".
6. pi and Playwright (requirement 6): pi has no per-run MCP flag. Two ways work:
   - An extension file loaded with `-e`, which is TypeScript run by pi, next to
     a requirement that removes the factory's TS. That file is pi config, not
     factory source.
   - A `.pi/mcp.json` written into the worktree plus `--approve`. It could be
     committed by a builder's `git add -A` and would shadow a repo's own file.

   Either way `--tools` must name `mcp__playwright__*` (or set `direct`
   exposure), or the browser tools stay hidden. None of this has been run. The
   real run (requirement 17) uses claude only, so pi browser support is proven
   only by tests or by hand.
7. Data races and aliasing in the Go driver: parallel agents update
   `job.json`, heartbeats read logs, and `route` and `applyCommand` must copy
   slices and maps. Without a mutex and deep copies, the e2e test can pass while
   `-race` fails, or saved state can be lost.
8. Zombies and process groups: Go must `Wait` every spawned child and start it
   with `Setsid`. Otherwise `isAlive` lies, timeouts replace "window closed"
   detection, and killing a driver leaves agents running.
9. Multi-line failure reasons (requirement 11): `job.reason` goes into
   one-line places: the status table, the PR headline
   `⏸ **Waiting for you: <reason>**` (`prbody.ts headline`), the activity log
   (one line per entry, parsed by the timeline), the desktop notification and
   `factory status`. Putting the last N output lines into it as is would break
   those formats.
10. Dashboard security: everything is local with no auth, but its POSTs approve
    and discard jobs, and discard closes PRs and deletes branches.
    - Today it guards with the `X-Factory` header plus Origin and Host checks
      (`server.ts:194-199`, `:243`) and confines the file endpoint to job paths
      (`server.ts:116-133`).
    - Agent-written Markdown shown in the Docs and Trips tabs is untrusted. A
      server-side renderer must escape raw HTML and unsafe URLs, as
      `safeUrl`/`safeHref` do today, or a doc becomes a script that can press
      Discard.
    - htmx requests must still send the custom header.
    - The Host check must accept `localhost:<port>`.
11. New dependencies and build steps:
    - cobra is settled (latest v1.10.2, resolved through `proxy.golang.org`).
    - Markdown (goldmark v1.8.7 or a port of the 120-line JS renderer), htmx (a
      vendored file) and Tailwind plus daisyUI CSS are not. Tailwind needs either
      a CLI build (a standalone binary through mise, then committed or
      install-time CSS) or a runtime CDN, which needs the network and is not
      meant for production. Any CSS build output must be reproducible on all
      three hosts.
    - `npx` (node) is still needed for `@playwright/mcp`.
12. Test-harness pitfalls: the binary path for `tail` and `run --here`, and a
    fake agent that is no longer a Bun script. The tests must build or re-exec
    Go fakes. `now`/`sleep` must be injected (the TS fake clock advances on
    `sleep`). `spawn.test.ts` runs real processes and needs reaping. The e2e
    uses real roles, so role-file parsing stays covered.
13. Switch-over on each host: after the merge, the stow package has no
    `.local/bin/factory`. `~/.local/bin/factory` stays a dangling link until
    `mise run install` runs on that host, and until then `factory` fails there.
    Old v2 jobs and `.factory.json` files (mycelium) may break, which is
    accepted. Other repos' running TS jobs stop working once the main checkout
    drops `src/`. Run scripts call `<main>/…/src/cli.ts tail` by absolute path.
14. This PR will carry job docs: the TS factory running this job commits
    `docs/requirements|tech-discovery|design-docs|specs|test-plans/rewrite-factory-golang.md`
    into this branch (`6f44902` is the first). Each later commit re-adds what a
    builder deletes (the test plan lands after build). The PR will show the very
    docs requirement 9 keeps out of PRs, unless the human removes them after the
    job.
15. Real run cost: requirement 17 runs every role with real `claude`, opus for
    high-tier roles, with 45-minute tier timeouts. It is long and costly. The
    scratch repo must have a local bare `origin`, and `gh` must be faked on
    PATH. The Go `new` still calls `gh auth status` and `git remote get-url
    origin` (`git.ts preflight`).

## Open points

- Where the Go module lives and how the binary finds its data. Option one: the
  module at `stow/factory/` root plus `.stow-local-ignore`. Option two: under
  `stow/factory/.local/share/factory/`. Then, roles, `config.json`, MCP config
  and dashboard assets either `go:embed`ded (a role edit needs a reinstall) or
  read at runtime from `~/.local/share/factory` (live edits, binary tied to
  stow). Requirements 12-13 say "the factory package" without naming the
  folder.
- How `f7fb2cf` gets into the branch before the build: a merge of
  `origin/main`, which keeps the build-stage push a fast-forward, or a rebase,
  which needs the job's push to be forced. See Risk 1.
- What the PR body's doc links point to (Risk 5): the dashboard URL, the proof
  ref, or something else. Requirement 9 says only "links to them".
- Wiring Playwright into pi (Risk 6): a `-e` extension file or a worktree
  `.pi/mcp.json` with `--approve`; and `direct` or `codemode` exposure.
- The dashboard asset pipeline: Tailwind standalone pinned in `mise.toml` with
  CSS committed or built at install, or a CDN. Markdown rendered by goldmark or
  by a small ported JS renderer.
- Config and state format: keep JSON deep-merge or change. Drop
  `docs`, `docsCommitType` and `roles.*.harness`. Add `harness` to the job.
  Bump `version`. The reference keeps `roles.*.tier` and `timeoutMin`.
- Which golangci-lint linters, and which formatter (gofmt, gofumpt or
  goimports). There is no repo config and the skill only says "keep the gofmt
  check".
- How a failure keeps "the last lines of output" yet stays readable in one-line
  places: a short `reason` plus a file, or multi-line only in some outputs.
  See Risk 9.
- The test library (stdlib `testing` or testify) and the fake mechanism
  (helper-process re-exec or binaries built in `TestMain`).
- The form of the demo dashboard: a hidden subcommand, a separate `cmd/`, or a
  test helper.
- Whether this PR should drop the `docs/*/rewrite-factory-golang.md` files the
  TS factory commits (Risk 14). It can only happen after the job's last doc
  commit.
