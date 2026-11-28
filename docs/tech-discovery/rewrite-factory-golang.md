# Tech discovery: Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

The reference is `origin/main` at `f7fb2cf` (`git fetch`; `git ls-remote`
shows `refs/heads/main` at `f7fb2cf`). This worktree is `f0be919` plus four
docs commits (`6f44902`, `e4163c5`, `d5a2bc5`, `cbf72f3`), so its copy of
`stow/factory` is stale: it still has `src/commands/attach.ts` and lacks
`answer.ts` and `unblock.ts` (`git diff --stat f0be919 origin/main`: 42 files,
+1142/-369). Everything below was read from an extract of `origin/main`
(`git archive origin/main stow/factory …`). Paths are relative to
`stow/factory/.local/share/factory/` unless they start with `stow/`,
`modules/`, `hosts/`, `docs/` or a repo-root file.

What changed since the last discovery run: requirement 9 is now settled as
"local only". The job docs live in `.factory/jobs/<id>/docs/`, never reach the
remote (proof ref included), and the PR body's `Docs:` line lists their
job-folder paths as plain text. The new section "Job docs and the PR body
today" and Risks 1 and 6 cover it. The design draft
(`docs/design-docs/rewrite-factory-golang.md`, section 4 "Doc links in the PR
body") was written for the proof-ref option, which the human did not pick.

## Findings

### Where it lives

Install and launch today

- `stow/factory/.local/bin/factory`: a two-line bash launcher,
  `exec bun "$HOME/.local/share/factory/src/cli.ts" "$@"`. On this host
  `~/.local/bin/factory` and `~/.local/share/factory` are stow symlinks into
  the main checkout's package folder (`ls -la`). [high]
- The running TS factory, which drives this job, runs the main checkout's
  code, not the worktree's (`run/tech-discoverer-*.sh` pipes through
  `…/bun …/nixos/stow/factory/.local/share/factory/src/cli.ts tail`). Edits in
  this worktree do not change the job's own machinery. [high]
- `modules/nixos/common.nix:138` and `hosts/macos/default.nix:109` run
  `sh stow.sh stow zsh tmux ghostty pi mise factory` on every system
  activation. [high]
- `stow/zsh/.zshrc:1` puts `~/.local/bin` on PATH, and `:5` runs
  `mise activate`. [high]

CLI, config, state (`src/`, about 4.5k lines of TS, no runtime dependencies)

- `cli.ts` (166 lines): a hand-written argv parser and a command table (usage,
  about, example, positional min/max, allowed flags). `--repo <path>` works on
  every command and refuses a linked worktree. `--` ends options. Valued flags:
  `repo, port, format, base, stack`. Hidden: `tail --format claude|pi` (used
  by run scripts) and `run --here` (the background driver). Errors print as
  `factory: <msg>` in red, `FACTORY_DEBUG=1` adds the stack, and
  `ReportedError` means "already printed, exit 1". [high]
- `config.ts` (72 lines): `config.json` (package defaults) deep-merged with
  the repo's `.factory.json`. Objects merge; arrays and scalars replace.
  Validators are checked against `e2e, user, load, capacity`. Keys: `base`,
  `prTitle`, `setup`, `docs.*` (line 20), `hooks.{prOpened,qaUrl,qaReady}`,
  `roles.<name>.{harness,tier,timeoutMin}`, `defaultHarness`,
  `models.{claude,pi}.<tier>`, `timeoutsMin`, `maxTrips`, `maxDiscoveryLoops`,
  `qaReadyTimeoutMin`, `qaPollSec`, `docsCommitType` (line 31). [high]
- `paths.ts` (63 lines): `findRepo` runs
  `git rev-parse --path-format=absolute --git-dir --git-common-dir`.
  `jobPaths` lays out `.factory/jobs/<id>/` (`job.json`, `activity.log`,
  `logs/`, `done/`, `run/`, `grill/`, `proof/`, `pr.md`, `report.md`,
  `access.md`, `trip-<t>/`, `discovery-review-<n>.md`, `feedback-<k>.md`,
  `decision-<k>.md`), with the worktree at `.factory/<id>`. It has no `docs/`
  entry today. `PACKAGE_DIR` (line 4) is the source folder; `CLI_PATH` is how
  the CLI calls itself again. [high]
- `job.ts` (162 lines): the `Job` v2 record. `saveJob` writes tmp and
  renames. `listJobs` sorts newest first and skips unreadable files.
  `appendActivity` writes `HH:MM:SS <line>`. Slots come from `nextSlot` and
  `heldSlots`. `questionsFile` holds an output path (this job's `job.json`
  points it at the worktree's design doc). [high]
- `machine.ts` (223 lines): a pure state machine with no I/O.
  `route(job, outcome, limits, now)` and `applyCommand(job, command, now)`
  cover approve, feedback, retry, unblock and discard, waiting stages, the
  trip, discovery-loop and ENV caps, and `waitingSince` stamping. [high]
- `driver.ts` (402 lines):
  - `runJob` takes the lock, stops leftover agents, steps until the job
    waits, then notifies.
  - `grillTurn` is the headless grill: a `grill/visit` key, `transcript.md`
    and `question.md`. It runs preflight inline.
  - `step` runs stage → outcome → route → save → activity line → `updatePr`.
    `updatePr` (line 162) re-renders the PR status block with `docLinks`.
  - A per-visit marker file plus mtimes decide whether an output was "written
    this visit".
  - `runAgents` skips reusable outputs, starts all agents before waiting on
    any, retries each failed agent once, and calls `onResult`.
  - `startAgent` names attempts `<role>-<n>` and writes `.system.md`,
    `.task.md` and `.sh`. A heartbeat logs every 30 s with the agent's last
    tool. `finishAgent` polls the done file every 2 s, applies the per-tier
    timeout, and detects a window that died without a done file. [high]
- `stages.ts` (480 lines): one effect per stage. preflight runs the
  access-checker, then commits the requirements doc and opens the draft PR
  (lines 204-216). build runs one builder per task, keeps a `built` resume
  list and pushes after each task (lines 304, 307). review runs the lenses in
  parallel. rebase fetches, rebases, runs the resolver on conflict, and
  pushes with `--force-with-lease` (line 359). qa-wait moves validation files
  aside on an ENV retry. finalize runs `pushProof` (line 428), the summarizer,
  proof coverage, the title template and `ready`. Browser roles get
  `http://localhost:${5100+10*slot+i}` (`localUrl`, line 75). [high]
- `handoff.ts` (304 lines): `outputPath` per kind; the five docs go to
  `<worktree>/<cfg.docs.*>/<id>.md` (lines 50-71). It holds the output checks
  (first line, headings, verdict words, `## Questions`) and the parsers: plan
  tasks, run, lenses and criteria; test-plan validators; the discovery
  verdict; the requirements title, deliverable and access; design questions.
  [high]
- `harness.ts` (125 lines):
  - `resolveHarness` forces browser roles onto claude
    (`role.browser ? 'claude' : …`, line 37) and applies per-role overrides,
    then maps tier to model and timeout.
  - `renderTaskPrompt` (lines 54-72) writes the `Job/Request/Worktree/Job
    folder/Cycle Trip/Base/Docs/Assignment/Output/Inputs/Target` lines. The
    `Docs:` line holds `<cfg.docs.*>/<id>.md`, relative to the worktree.
  - `buildCommand` for claude: `-p "$(cat task)"`,
    `--append-system-prompt-file`, `--model`, `--permission-mode auto`,
    `--add-dir <jobDir>`, `--mcp-config mcp/playwright.json` plus 12
    `mcp__playwright__browser_*` tools for browser roles, allowed and
    disallowed tools, `--output-format stream-json --verbose`.
  - `buildCommand` for pi: `-p --append-system-prompt <file> --model --tools
    <read,grep,find,ls,bash,edit,write subset> --mode json "<task>"`, with no
    browser. [high]
- `roles.ts` (79 lines): parses frontmatter (`name, description, tools,
  browser, tier, include`) and joins the includes (`_common`, `_builder`).
  [high]
- `spawn.ts` (159 lines):
  - The run script does `cd … || echo 97 > done`, then
    `<cmd> 2>&1 | tee -a <log> | <bun> <cli.ts> tail --format <h>`, then
    writes `${PIPESTATUS[0]}` to the done file.
  - `ProcessSpawner` uses `Bun.spawn(…, {detached: true})` plus `unref()`, one
    `<name>.pid` per process in `run/`, and kills with `process.kill(-pid)`.
  - `InlineSpawner` runs the script to completion. Also `waitForFile` and
    `readExitCode`. [high]
- `lock.ts` (51 lines): `driver.lock` created with `wx` (O_EXCL). A dead pid's
  lock is taken over; EPERM counts as alive. [high]
- `git.ts` (226 lines):
  - `Git`: `ensureExcluded` adds `/.factory/` to info/exclude.
    `createWorktree` marks `branch.<b>.factory=true`. `push` (lines 65-68) is
    factory-branches-only, plain or `--force-with-lease`, never
    `--no-verify`. Also `commitPaths`, `head`, `rebase`, `removeWorktree`,
    `deleteBranch` (local and remote), `branchExists` (local `show-ref`, then
    `ls-remote`).
  - `GitHub` over `gh`: `auth status`, `repo view` (defaultBranchRef,
    nameWithOwner), `pr view --json headRefName|body|comments,reviews`,
    `pr list --head`, `pr create --draft --assignee @me --head --base`
    (lines 166-173), `pr edit --body-file|--title`, `pr ready [--undo]`,
    `pr close`, `api repos/{owner}/{repo}/pulls/<n>/comments --paginate`. Bot
    comments are dropped.
  - `GitError` keeps only the first non-empty stderr line (lines 6-12). [high]
- `hooks.ts` (45 lines): runs `bash -c <script>` in the worktree with
  `JOB, PR, BRANCH, SHA` plus the process env. qaReady polls until exit 0 or
  the timeout. A hook failure reports only its first stderr line
  (`stages.ts:123`). [high]
- `prbody.ts` (176 lines): the status block between `<!-- factory:status -->`
  markers (step table, marks, `Docs:` line built in `renderStatus`, lines
  83-105), the decision block, `initialBody` (lines 142-146), `proofCoverage`,
  and `pushProof` (lines 153-176). [high]
- `tail.ts` (222 lines): formats claude `stream-json` and pi `--mode json`
  events (`message_end`, `tool_execution_start/end`, `auto_retry_end`,
  `agent_settled`, per pi 1.5.2 `docs/json.md`). `lastTool` feeds heartbeats.
  Colors follow `NO_COLOR`/`FORCE_COLOR`/TTY. [high]
- `ui.ts` (157 lines): `whatFor`, `nextHint`, `nextLines`, `pipelineLine`,
  `statusTable`, `ago`, `prNumber`, `paint`, shared by CLI, driver and
  dashboard so all three say the same thing. [high]
- `notify.ts` (27 lines): `osascript` on darwin, `notify-send` on linux, then
  a terminal bell. It never throws. [high]
- `ids.ts` (70 lines): `nameBranch` asks the default harness's low-tier model
  (`claude -p … --strict-mcp-config --model haiku`, or `pi -p`) and falls back
  to `feature/<slug>`. Also `caseBranch`, `jobIdFor`, `ticketOf`, and
  `takenIds` (lines 67-69), which unions job folder names with the file names
  in the repo's requirements docs folder. [high]
- `server.ts` (262 lines):
  - Bun.serve on `127.0.0.1` (line 248), with Origin and Host checks against
    DNS rebinding (lines 194-199, 243).
  - `GET /` serves `dashboard.html` with `{{PROJECT}}` filled in.
    `GET /api/jobs` returns jobs plus `hint`, `whatFor`, `steps`, the `STEPS`
    table and limits. `GET /api/jobs/:id` (`jobDetail`, lines 89-110) returns
    docs as `<cfg.docs.*>/<id>.md` with `exists` checked in the worktree,
    trip folders, the last 200 activity lines and log names.
    `GET …/file?path=` (`readJobFile`, lines 115-134) serves the job dir or
    `<worktree>/docs/` only, symlink-safe, 403/404. `GET …/log?name=&lines=`
    returns formatted lines with ANSI stripped.
  - `POST …/{approve,retry,feedback,discard}` needs `X-Factory: 1`. approve
    and retry return 409 when a live driver holds the lock. [high]
- `commands/`:
  - `new`: gh preflight, info/exclude, base from `--base`, `--stack`, config
    or the default branch, branch naming, id claim with `-2…` suffixes
    (`claim`, lines 84-100, passes `cfg.docs.requirements` to `takenIds`),
    worktree, `setup` commands (last 30 output lines on failure), rollback,
    then the first grill turn.
  - `answer`: one grill turn; prints `QUESTION for <id>:`, starts the driver,
    or prints a `!` warning.
  - `status`: the table plus hints, a detail view, `--json`.
  - `logs`: the latest or a role's log, `detectFormat`, the last 200 lines,
    `-f` follows until the done file appears.
  - `approve`, `unblock` (`decision-<k>.md` plus retry), `run` (retries when
    needs-human, `--inline`, background respawn).
  - `feedback`: PR comments since the last feedback file, plus the note, go to
    `feedback-<k>.md`. It kills the driver and agents, turns a done PR back to
    draft, and moves the job to a free slot.
  - `discard`: confirm, `--yes`, or refuse without a TTY. Best-effort
    teardown, then the folder moves to `.factory/archive/<id>-<ms>`.
  - `dashboard`: port 8000 by default; 0 picks a free port. [high]
- `dashboard.html` (1644 lines of vanilla JS and CSS, no build step):
  - Polls `/api/jobs` every 2 s; header counts, a sync dot, a "Notify me"
    button and help.
  - "Needs you" tickets with per-kind actions: grill (discard); review
    (approve, feedback, Open PR, discard); env (retry, approve, Read why,
    discard); escalation (approve, feedback, Read why, Open PR, discard, plus
    the judge's first question); failure (retry, Open logs, discard). The
    inline feedback box sends on ⌘/Ctrl+Enter.
  - The board has one column per step group plus Done; discarded jobs sit
    behind a toggle.
  - The drawer has Timeline, Docs, Trips and Logs tabs. A client-side
    Markdown renderer sanitizes URLs (`safeUrl`, `safeHref`). The log view
    follows the end.
  - Toasts on stage changes; a browser `Notification` when a job starts
    needing you. Keys: `j`/`k`, Enter, `a`, `f`, `?`, Esc.
  - No `answer` or `unblock` action: the page offers exactly approve,
    feedback, retry (`run`) and discard. [high]
- Data files: `config.json` (its `docs` block, lines 5-10, and
  `docsCommitType`, line 25), `mcp/playwright.json`
  (`npx -y @playwright/mcp@0.0.86 --isolated --headless`), `roles/*.md` (27
  files with `_common.md` and `_builder.md`), `README.md`, `package.json`,
  `bun.lock`, `tsconfig.json`, `.gitignore` (`node_modules/`). [high]
- Tests:
  - `src/__tests__/e2e.test.ts` (401 lines): real git, real roles, inline fake
    agents. `gh` is answered in process (lines 58-72). `claude`, `pi` and `gh`
    stubs that exit 99 sit first on PATH. Hooks log to a file.
  - `machine.test.ts` (453 lines, about 45 cases with `test.each`) and
    `spawn.test.ts` (2 tests with real processes).
  - `helpers.ts`: `FakeExec` and `tempRepo` (a repo with a bare origin).
  - `fixtures/fake-agent.ts` (181 lines) is driven by a scenario of verdicts
    per visit. Builders commit, validators write `proof/ac<k>-…`, the grill
    asks once and then writes the doc, `sleepMs` exercises the heartbeat.
  - `fixtures/seed-demo.ts` (510 lines) and `fixtures/serve-demo.ts` (57)
    back the demo dashboard.
  - `bun test` on the extract gave 98 pass, 0 fail, 3 files (last run). [high]
- Other files that name the factory (in the reference):
  - `stow/claude/.claude/skills/factory/SKILL.md:12` and
    `stow/pi/.pi/agent/skills/factory/SKILL.md:12`: "if `factory` is not found
    … run `./stow.sh stow factory`".
  - `AGENTS.md` lines 17, 35, 56, 70, 72-76 (Bun, `bun test`, the demo
    commands, `127.0.0.1`).
  - `README.md` lines 23, 51, 53.
  - Package `README.md:48` (the `docs` config key), `:50` (per-role
    `harness`), `:109` (browser roles run on claude).
  - `roles/_common.md:18`: Docs are "relative to the worktree".
  - `roles/requirements.md:117` names `factory discard <job>`. [high]

Job docs and the PR body today (everything requirement 9 changes)

- Where docs are written: `handoff.ts:55,63-71`
  (`<worktree>/<cfg.docs.*>/<id>.md`); the grill and every doc role write
  there. [high]
- Where they are committed and pushed: `stages.ts` `docRel` (line 73),
  `commitDoc` (lines 100-104, commit message `${docsCommitType}: <doc> for
  <id>`, then a push), `writeDoc` (lines 107-112, used by tech discovery,
  design, spec and test plan), preflight's `commitDoc(c, 'requirements')`
  (line 215), and the planner's `alsoCommit` of requirements and design
  (line 267). [high]
- Preflight order: access check → `commitDoc('requirements')` → `ensurePr`
  (`stages.ts:204-216`). `ensurePr` (lines 169-185) finds or creates the
  draft PR right after that first commit and push. The requirements commit is
  what puts the branch ahead of its base when the PR opens. [high]
- The `Docs:` line: `docLinks` (`stages.ts:472-480`) builds
  `https://github.com/<nwo>/blob/<branch>/<docRel>` for each doc that exists;
  `renderStatus` (`prbody.ts:96,104`) prints them as Markdown links;
  `updatePr` (`driver.ts:162`) re-renders on every step. `initialBody`
  (`prbody.ts:145`) says "Docs and commits land here as they are written".
  `nameWithOwner` is still needed elsewhere: `proofSection` (`stages.ts:408-
  442`) links proof files. [high]
- The proof ref already carries only proof files: `pushProof` adds only
  `--work-tree=<proofDir>`, runs `commit-tree`, and
  `git push --force origin <sha>:refs/heads/factory-proof/<id>` from the main
  checkout without `--no-verify` (`prbody.ts:153-176`). It runs only in
  finalize (`stages.ts:428`). [high]
- Readers of doc paths: `harness.ts:56-66` (the task's `Docs:` line);
  `server.ts:89-134` (dashboard Docs tab and the `<worktree>/docs` file
  root); `ids.ts:67-69` plus `new.ts:40,84-85` (`takenIds` scans the repo's
  requirements folder); `fake-agent.ts:87-90` (reads the spec from
  `join(worktree, spec)`); `e2e.test.ts:196-212` (asserts the five
  `docs/<dir>/<id>.md` files on origin and the five `docs: … for <id>`
  commits); `roles/_common.md:18`; package `README.md:48`. [high]
- Agents' access to the job folder: claude gets it through `--add-dir
  <jobDir>` (`harness.ts:107`). pi gets no directory flag; the design draft
  says pi does not restrict paths. [high for claude, medium for pi: not run]
- This job is the live example: PR #4 is public (`gh repo view`: `PUBLIC`),
  lists three `docs/*/rewrite-factory-golang.md` files, and its `Docs:` line
  links to them on the branch (`gh pr view 4`). [high]

Toolchain on this host

- `go1.27.4 darwin/arm64`, golangci-lint 2.15.0 (built with go1.27.2) and
  lefthook 2.2.3 all come from mise global
  (`~/.config/mise/config.toml`, a link into a different repo,
  `marco-souza/dotfiles`: `go = "latest"`, `lefthook = "latest"`). `mise
  latest` gives go 1.27.4, golangci-lint 2.15.0, lefthook 2.2.4. [high]
- mise registry: `golangci-lint` → `aqua:golangci/golangci-lint`, `lefthook`
  → `aqua:evilmartians/lefthook`. Tailwind is not in the registry by name, but
  `github:tailwindlabs/tailwindcss` resolves (latest 4.3.5). [high]
- `gofumpt`, `goimports`, `gopls` and `tailwindcss` are not on PATH. `node`
  and `npx` are (mise shims). [high]
- The repo has no Go file, `go.mod`, `.golangci.yml`, `lefthook.yml`, or root
  `.gitignore` (`git ls-files`). It already has two `mise.toml` files in the
  `mise` stow package: `stow/mise/mise.toml`, linked as `~/mise.toml`, and
  `stow/mise/.config/mise/mise.toml`, linked as `~/.config/mise/mise.toml`
  (`ls -la`). [high]

### Blueprint

`AGENTS.md` has no `## Blueprint` section, and the repo has no Go code. The
closest Go convention is Marco's skill `go-service-setup`
(`stow/claude/.claude/skills/go-service-setup/SKILL.md`): `cmd/<name>/main.go`
plus `internal/<domain>/`, a thin `main` calling `run()` that returns an error
with one `os.Exit`, `signal.NotifyContext`, `http.Server` with
`ReadHeaderTimeout` and graceful `Shutdown`, stdlib first ("no deps unless
forced"), table tests, and a `lefthook.yml` shape (gofmt plus
`golangci-lint run --fix` on staged `*.go`, `go test ./...` on pre-push). It
targets services (slog JSON, env config, Dockerfile), so only part fits a CLI.
[high for the content, medium for the fit]

- CLI: cobra, settled in the requirements. Semantics to keep or decide: `--`
  before free text (both skills always pass it), positionals joined into one
  string, `--repo` on every command, the hidden `tail` and `run --here`.
  Reference `src/cli.ts`. [high]
- Dependency injection: one `Deps` bag (exec, spawner, git, gh, rolesDir,
  `commandFor`, notify, now, sleep, log, heartbeatMs) and one `Cli` (out, err,
  confirm, terminal, deps); tests swap fakes in. Reference `src/deps.ts`,
  `src/commands/shared.ts`. In Go these become interfaces. [high]
- External commands: every git, gh, hook and setup call goes through
  `Exec.run(cmd[], {cwd, env, input}) → {code, stdout, stderr}`. Reference
  `src/exec.ts`. [high]
- Errors: typed errors map to exit codes and HTTP status (`CommandError` 400,
  `LockError` 409, `HttpError` own status, else 500; `ReportedError` already
  printed). Reference `src/server.ts:250-258`, `src/cli.ts:160`. Go: typed
  errors with `errors.As`. [high]
- Persistence: JSON files with tmp+rename. Reference `src/job.ts` `saveJob`.
  [high]
- Concurrency: none to copy. TS relies on one thread (`Promise.allSettled` in
  `driver.ts:286`). Go needs its own pattern: a gap. [high]
- HTTP: `Bun.serve` today; the skill's `net/http` pattern applies. [high]
- UI building blocks: no Go templates, htmx, Tailwind or daisyUI in the repo.
  Asset build and embedding, and Markdown rendering, are gaps. [high]
- Output: human lines with ANSI through `ui.paint`. The skill's `slog` JSON is
  for services and conflicts with that: a gap. [medium]
- Tests: no Go convention. Stdlib `testing` or testify, and how to fake
  `claude`/`pi`/`gh` (helper-process re-exec, fixture binaries built in
  `TestMain`, or an in-process `Exec` fake as today), are gaps. [medium]
- Lint and format config: none. Which linters, and gofmt, gofumpt or
  goimports, is a gap. [high]

### Reuse

- `src/machine.ts` and `machine.test.ts`: the pure state machine; its ~45
  cases can become Go table tests one to one. [high]
- E2e harness design: a real repo with a bare origin (`helpers.ts tempRepo`),
  the scenario-driven fake agent, stubs that exit 99 first on PATH, an
  in-process gh fake that records calls and fails unknown ones, hooks that log
  to a file. This covers requirement 14's "fake claude, pi and gh, real git".
  [high]
- The roles, `_common.md`, `_builder.md` and `mcp/playwright.json` carry over.
  Only the `Docs` wording in `_common.md:18` (and any role text that assumes a
  harness) needs to change. [high]
- `pushProof` already meets most of requirement 9's proof-ref rule: it adds
  only the proof folder and runs only in finalize. Only `--no-verify`
  (requirement 10) is new. [high]
- `go-service-setup` skill: the `http.Server` and shutdown snippet, the
  `lefthook.yml` shape. [high]
- pi built-in MCP (pi 1.5.2): no per-run `--mcp-config`. Servers come from
  `~/.pi/agent/mcp.json`, from `.pi/mcp.json` in a trusted project
  (`--approve` trusts it for one run), or from an extension loaded with
  `-e <file>` that calls `pi.registerMcpServer(name, {command, args,
  exposure})` (pi `docs/extensions.md`, `docs/mcp.md`, `docs/cli.md:121-158`).
  MCP tools default to `codemode` exposure; a `--tools` list hides MCP tools
  unless an entry matches, for example `'mcp__playwright__*'`. [medium: read
  in the docs, not run]
- golangci-lint v2 has built-in formatters (gofmt, gofumpt, goimports, gci,
  golines; `golangci-lint help formatters`): one tool can format and lint.
  [high]
- mise already installs Go and lefthook here. A `mise.toml` with only
  `[tools]` and `[tasks]` ran from an untrusted folder with no trust prompt
  (`mise run hello` in `/tmp`, last run). [high]
- NixOS has `programs.nix-ld.enable = true` (`modules/nixos/common.nix:71`),
  so prebuilt binaries mise downloads should run there. [medium]

### Constraints

- Agents never run `./stow.sh` or `make switch|boot|mac|update|hardware`.
  `mise run install` (writes `~/.local/bin/factory`) and `lefthook install`
  (writes the shared `.git/hooks`) change `$HOME` and the main checkout the
  same way. Source: `AGENTS.md` "Setup", `_common.md` "Never".
- `$HOME` symlinks point at the main checkout; worktree edits are not live
  until merged. Source: `AGENTS.md`.
- Commits: `<type>: <lowercase summary>` with `fea`/`enh`/`fix`. Source:
  `AGENTS.md` "Conventions".
- Factory files hold nothing repo-specific. Source: `AGENTS.md`, package
  `README.md`.
- Flakes only see tracked files; a Nix eval is needed only if a `.nix` file
  changes. Source: `AGENTS.md`.
- Settled in the requirements: Go 1.27, cobra; TS, Bun tests,
  `package.json`, `bun.lock`, `tsconfig.json` and the Bun launcher removed;
  `--harness claude|pi` per job with no per-role override; Playwright for
  browser roles on both harnesses; dashboard on `localhost`, no auth; job docs
  in `.factory/jobs/<id>/docs/`, never committed or pushed (proof ref
  included), listed as plain-text job-folder paths on the PR's `Docs:` line;
  proof push with `--no-verify`; failures show the last lines of output;
  `mise.toml` pins Go, golangci-lint and lefthook; lefthook checks only Go.
  Source: requirements doc.
- Out of scope: `task-pipeline`, chrome-relay, migrating old jobs and
  configs, a Nix package, hooks for non-Go files. Source: requirements doc.
- No direct commits to `main`: other repos still run the TS factory from
  main. Source: requirements "Decisions".

### Weak spots

- Package-dir coupling: roles, `config.json`, `mcp/playwright.json` and
  `dashboard.html` are found through `PACKAGE_DIR = import.meta.dir/..`
  (`paths.ts:4`); run scripts and the driver call the CLI again through
  `process.execPath` plus `CLI_PATH`. A copied Go binary in `~/.local/bin` has
  neither: data must be embedded or read from a known folder. Role edits are
  live today with no build step. [high]
- Docs-in-worktree is wired into about ten places (listed under "Job docs and
  the PR body today"). Requirement 9 removes all of them and makes the config
  keys `docs` and `docsCommitType` meaningless. [high]
- The draft PR depends on the requirements commit (`stages.ts:215` then
  `ensurePr`). Without doc commits the branch has no commit of its own until
  the first builder pushes. See Risk 1. [high]
- `takenIds` also guards against ids whose requirements doc was merged into
  the repo. With docs out of the repo, only job folders and branches
  (`branchExists`, local and remote) remain as guards. Archived folders
  (`.factory/archive/<id>-<ms>`) are not scanned. [high]
- Id/folder overlap: the worktree is `.factory/<id>` next to
  `.factory/jobs` and `.factory/archive`, and `claim` does not reserve
  `jobs` or `archive`. A branch like `feature/jobs` gives id `jobs`, whose
  worktree path is the jobs folder. Latent in the reference. [high: read;
  not run]
- First-line-only failure reasons: `git.ts:8` and `stages.ts:123`, the root
  cause in `feedback.md` (main checkout, untracked). [high]
- One-thread assumptions: `runAgents` runs agents side by side and each
  `onResult` calls `c.update` (`setTrip`), which saves `job.json`; heartbeat
  timers read logs. Safe on JS's one thread; Go goroutines would race.
  `route` and `applyCommand` must never mutate their input
  (`machine.test.ts:225`, `:446`); Go slices and maps in `Job.Trips`,
  `reviews`, `validations` and `decisions` share storage unless copied.
  [high]
- Child reaping: Bun reaps detached children. In Go an un-`Wait`ed child is a
  zombie and `kill(pid, 0)` on it succeeds, so `isAlive` stays true,
  `finishAgent` never sees "window closed", and `spawn.test.ts` "is not alive
  afterwards" fails. [high: Unix semantics]
- Detach: the reference relies on `detached: true` (new session and group) so
  `kill(-pid)` takes the tree. Go needs `SysProcAttr{Setsid: true}`.
  [medium: Node's documented `detached`; Bun's inferred]
- Self-invocation in tests: run scripts pipe through `<cli> tail` and the
  driver respawns `<cli> run <id> --here`. Under `go test`,
  `os.Executable()` is the test binary. [high]
- `fixtures/serve-demo.ts` still implements tmux leftovers (`ensureSession`,
  `killSession`), and `tsconfig.json` `include` does not cover `fixtures/`,
  so the demo code was never type-checked. [high]
- The dashboard is a client-side SPA. Server-rendered htmx fragments can
  replace the board and drawer. They cannot replace the JS for toasts on
  stage changes, browser notifications, keyboard shortcuts, focus kept across
  refreshes, log auto-follow, or ⌘/Ctrl+Enter send; those need a small script
  or htmx events. This is the least one-to-one part of the port. With docs no
  longer on GitHub, the dashboard's Docs tab is the only reader UI for them.
  [medium]
- Stow folds the package: any file at `stow/factory/` root is linked into
  `$HOME` on every activation (`stow -n -v` showed `LINK: go.mod`, `LINK:
  mise.toml`, last run). `~/mise.toml` already belongs to the `mise` package
  (`ls -la ~/mise.toml` → `stow/mise/mise.toml`). [high]
- `go build -o ~/.local/bin/factory` onto a symlink to an existing non-binary
  fails ("already exists and is not an object file"); onto a dangling symlink
  it replaces the link (tested in `/tmp`, last run). [high]

### Validation

- Reference baseline: `bun test` on an extract of `origin/main`'s package:
  98 pass, 0 fail across `e2e.test.ts`, `machine.test.ts`, `spawn.test.ts`.
  The Go tests cover the same cases (requirement 14), with the e2e's doc
  assertions inverted: the five docs exist in `.factory/jobs/<id>/docs/`,
  origin's branch has no `docs/…/<id>.md` and no `docs: … for <id>` commits,
  `factory-proof/<id>` holds only proof files, the proof push carries
  `--no-verify`, and the PR body's `Docs:` line has plain paths, no links.
  [high]
- Go checks, from the module folder: `go build ./...`, `go vet ./...`,
  `golangci-lint fmt --diff` (or `gofmt -l .`), `golangci-lint run ./...`,
  `go test -race ./...` (`-race` for the goroutine weak spot). golangci-lint
  2.15 ran clean on a scratch module with `go 1.27` and `go 1.27.4` (last
  run). [high]
- Hooks without installing them: `lefthook validate`,
  `lefthook run pre-commit --all-files`, `lefthook run pre-push --force`.
  Never `lefthook install` from an agent. [high]
- Install task: run `mise run install` only with a temp destination or
  `HOME`, never the real `~/.local/bin`. [high]
- Demo dashboard: the Go equivalent of `seed-demo` plus `serve-demo` (fake
  deps), opened by browser roles at their `Target`. [high]
- Real run (requirement 17): a scratch repo with a local bare origin, real
  `claude`, and a fake `gh` first on PATH that answers every call in the
  `GitHub` list above and records `pr create`/`pr edit`. The binary is built
  to a temp path. Neither the e2e's in-process gh nor this fake `gh` rejects
  a PR with no commits; see Risk 1. [high]
- `nix eval`/`nix fmt` only if a `.nix` file changes; `bash -n stow.sh` only
  if `stow.sh` changes. Source: `AGENTS.md` "Validation". [high]

## Risks

1. Requirement 9 breaks how the draft PR opens: today preflight commits the
   requirements doc, pushes, then runs `gh pr create --draft --head <branch>
   --base <base>` (`stages.ts:215`, `:169-185`; `git.ts:166-173`). With no doc
   commit, the branch equals its base at preflight. GitHub refuses a PR with
   no commits between head and base ("No commits between …") [medium: known
   GitHub API behaviour, not run here, since it would write to GitHub].
   Neither the e2e gh fake nor requirement 17's fake `gh` reproduces this, so
   it would first show on a real job. `--stack` jobs hit it the same way. The
   design draft moves `ensurePr` to after the first push in build ("Decided
   without asking"); an empty commit is the other way.
2. Stale base, and a merge or rebase that breaks the build-stage push: `HEAD`
   is `f0be919` plus four docs commits, and `origin/feature/rewrite-factory-golang`
   is at `cbf72f3` (`git ls-remote`).
   - Builders who read the worktree's `stow/factory` port the wrong version
     (has `attach`, lacks `answer`, `unblock`, the headless grill).
   - The TS build stage pushes after each task without force
     (`stages.ts:304,307`). A rebase onto `f7fb2cf` rewrites pushed history,
     so the next push is rejected. A merge of `origin/main` keeps it a
     fast-forward and meets requirement 1 (inference from the push code).
   - If the branch is not updated first, the later `rebase` stage hits
     modify/delete conflicts on every TS file `f7fb2cf` changed and the build
     deleted.
3. Agents touching `$HOME` or the shared git dir: `mise run install` into
   `~/.local/bin` either fails (the TS launcher symlink is still there) or,
   if it removes the link, breaks the `factory` other repos still use from
   main. `lefthook install` writes the shared `.git/hooks`, so the TS
   factory's own pushes of this job and every commit in the main checkout
   would run Go lint and tests. Both are deliverables only the human runs.
4. Stow links package-root files into `$HOME`. A `mise.toml`, `go.mod`,
   `.golangci.yml`, `cmd/` or `internal/` at `stow/factory/` root gets linked
   on every activation (`modules/nixos/common.nix:138`,
   `hosts/macos/default.nix:109`). `~/mise.toml` is already owned by the
   `mise` package, so a second package's root `mise.toml` collides with it
   in the same `stow` call [medium: stow's conflict rule, not run]. Keeping
   the module under `.local/share/factory/` or adding
   `stow/factory/.stow-local-ignore` avoids it.
5. lefthook reads `lefthook.yml` from the git toplevel; `LEFTHOOK_CONFIG` is
   not set when git runs hooks. So the config is a new repo-root file scoped
   with `root:` and `glob: "*.go"`. Once installed, pre-push runs the Go tests
   on every push of this repo, factory job branches included (`git.ts:65-68`
   never passes `--no-verify` for branch pushes). A slow or flaky e2e then
   blocks pushes.
6. Plain-text doc paths in a public PR body: the repo is public. Absolute
   job-folder paths (for example
   `/Users/marco/w/marco-souza/nixos/.factory/jobs/<id>/docs/requirements.md`)
   publish the local user name and folder layout in every PR, on every status
   update (`driver.ts:162`). Repo-relative paths
   (`.factory/jobs/<id>/docs/…`) say the same without that. The paths are
   not clickable, and `initialBody`'s "Docs and commits land here" copy
   becomes wrong.
7. pi and Playwright (requirement 6): pi has no per-run MCP flag. Either an
   extension file loaded with `-e` (JS/TS run by pi, which is pi config, not
   factory source) or a `.pi/mcp.json` in the worktree with `--approve`
   (could be committed by a builder's `git add -A` and would shadow a repo's
   own file). Either way `--tools` must name `mcp__playwright__*` or use
   `direct` exposure. Not run. The real run uses claude only, so pi browser
   support is proven only by tests or by hand.
8. Data races and aliasing in the Go driver: parallel agents update
   `job.json`, heartbeats read logs, and `route`/`applyCommand` must copy
   slices and maps. Without a mutex and deep copies, the e2e can pass while
   `-race` fails, or saved state can be lost.
9. Zombies and process groups: Go must `Wait` every spawned child and start
   it with `Setsid`, or `isAlive` lies, timeouts replace "window closed"
   detection, and killing a driver leaves agents running.
10. Multi-line failure reasons (requirement 11): `job.reason` lands in
    one-line places (status table, PR headline `⏸ **Waiting for you:
    <reason>**`, the activity log parsed by the timeline, desktop
    notifications, `factory status`). The last N output lines put there as is
    would break those formats.
11. Dashboard security: local, no auth, but its POSTs approve and discard
    jobs, and discard closes PRs and deletes branches. Today: `X-Factory`
    header plus Origin and Host checks (`server.ts:194-199,243`), file
    endpoint confined to job paths (`server.ts:115-134`). Agent-written
    Markdown in the Docs and Trips tabs is untrusted; a server-side renderer
    must escape raw HTML and unsafe URLs as `safeUrl`/`safeHref` do, or a doc
    becomes a script that can press Discard. htmx requests must still send the
    header, and the Host check must accept `localhost:<port>`. The file
    endpoint's roots shrink to the job folder.
12. New dependencies and build steps: cobra is settled. Markdown (goldmark or
    a port of the 120-line JS renderer), htmx (a vendored file), Tailwind and
    daisyUI are not. Tailwind is not in mise's registry by name;
    `github:tailwindlabs/tailwindcss` resolves to 4.3.5. daisyUI is an npm
    plugin; with the standalone CLI it needs its bundled plugin file [medium:
    daisyUI docs, not run]. Any CSS build must reproduce on all three hosts,
    or the output is committed. `npx` (node) stays needed for
    `@playwright/mcp`.
13. Test-harness pitfalls: the binary path for `tail` and `run --here`, fake
    agents that are no longer Bun scripts (tests must build or re-exec Go
    fakes), injected `now`/`sleep` (the TS fake clock advances on `sleep`),
    real processes in `spawn.test.ts` that need reaping. The e2e uses real
    roles, so role parsing stays covered.
14. Switch-over on each host: after the merge the stow package has no
    `.local/bin/factory`, so `~/.local/bin/factory` dangles until
    `mise run install` runs there. Old v2 jobs and `.factory.json` files
    (mycelium) may break (accepted). Other repos' running TS jobs stop once
    the main checkout drops `src/`: their run scripts call
    `<main>/…/src/cli.ts tail` by absolute path.
15. This PR carries this job's docs: the TS factory running this job commits
    `docs/*/rewrite-factory-golang.md` into this branch (PR #4 already lists
    three; `gh pr view 4`), on a public repo, and re-adds any a builder
    deletes. The PR will show the very docs requirement 9 keeps out of PRs
    unless the human removes them after the job.
16. Real run cost: requirement 17 runs every role with real `claude` (opus
    for high-tier roles, 45-minute tier timeouts). The scratch repo needs a
    local bare `origin`, and `gh` must be faked on PATH: the Go `new` still
    calls `gh auth status` and `git remote get-url origin` (`git.ts`
    preflight).

## Open points

- PR body `Docs:` line form (Risk 6): absolute paths or paths relative to the
  repo root. Requirement 9 says only "job-folder paths". On a public repo the
  absolute form publishes `/Users/marco/…`.
- When the draft PR opens (Risk 1): after the first build push, as the design
  draft picks, or at preflight with an empty commit. Today everything from
  preflight to build runs without needing the PR, but `prOpened` (assigns the
  QA env) then runs later than today.
- File names inside `.factory/jobs/<id>/docs/`: keep the per-kind folders and
  `<id>.md`, or flat `<kind>.md` (the design draft's choice). Nothing reads
  them by name outside the factory, so either works; the dashboard and the
  Docs line must match.
- Already picked by the design draft, with no new evidence against: module
  under `stow/factory/.local/share/factory/` with data embedded; merge
  `origin/main` as task 1; pi Playwright via an embedded `-e` extension with
  `direct` exposure; committed Tailwind CSS build and goldmark; JSON config
  with strict decoding and `job.json` v3 with `harness`; golangci-lint
  `standard` plus gofumpt and goimports; stdlib `testing` with fake binaries
  built in `TestMain`; failure reason as a summary line plus a 20-line tail;
  this job's own docs left in the branch for Marco to remove. The design's
  section 4 "Doc links in the PR body" must switch to the local-only option
  (its own fallback paragraph describes it): `pushProof` keeps only proof
  files, runs only in finalize, adds `--no-verify`.
