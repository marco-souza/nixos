# Design: Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

The reference is `origin/main` at `f7fb2cf`. All "today" and file references
below are from that commit. Paths are relative to the Go module folder
`stow/factory/.local/share/factory/` unless they start with `stow/` or name a
repo-root file. `docs/…` paths in this doc are job-folder paths.

## Approach

This is a port of the reference architecture into idiomatic Go. Nothing
about the factory's shape changes: the state machine stays pure, the driver
still runs a job as a background process with file-based state, and agents
still run as detached run scripts. Each TS module maps to one Go package, and
three changes come from the requirements:

- Docs live in the job folder (req 9).
- The harness is chosen per job (req 5, req 6).
- Failure reasons keep the tail of the output (req 11).

The dashboard is rebuilt as server-rendered htmx (req 7).

### 0. Branch first

The first build task runs `git merge origin/main`. It merges, not rebases,
so the job branch contains `f7fb2cf` (req 1). The TS factory driving this job
pushes after each task without force (`stages.ts` `push(c)`). A rebase would
rewrite pushed history and get the next push rejected. The later `rebase`
stage still linearises the branch onto `origin/main`. Every port works from
the merged tree. The `f0be919` tree, which still has `attach`, is never a
source.

### 1. Where the code lives and how the binary finds its data

The module stays where the TS package is today:
`stow/factory/.local/share/factory/`. Nothing new goes at `stow/factory/`
root, so stow links no `go.mod` or `mise.toml` into `$HOME` (Risk 3). Stow
still folds `~/.local/share/factory` onto this folder, which is harmless: the
binary never reads from it.

Every piece of data the binary needs is compiled in with `go:embed`, so a
binary copied to `~/.local/bin` is self-contained (weak spot "package-dir
coupling"):

- `roles/*.md` keep their path. They are embedded by a root package
  `assets.go` (`package factory`, `//go:embed roles/*.md`). The explicit
  `*.md` glob is needed: a bare directory pattern would skip `_common.md` and
  `_builder.md`.
- Dashboard templates and static files are embedded by `internal/dashboard`.
- `config.json` is replaced by `config.Defaults()` in Go.
- `mcp/playwright.json` is replaced by one Go value, `harness.Playwright`,
  rendered per harness (section 6).

A role edit needs `mise run install`. That matches the settled install flow,
where Marco reruns it after merging.

Files removed (req 3): `src/` (with all tests and fixtures), `package.json`,
`bun.lock`, `tsconfig.json`, `.gitignore`, `config.json`, `mcp/`,
`dashboard.html` and `stow/factory/.local/bin/factory`.

### 2. Packages

```
stow/factory/.local/share/factory/
  go.mod  go.sum  mise.toml  .golangci.yml  README.md
  assets.go                   package factory: embeds roles/*.md
  roles/*.md                  unchanged files (one line edited, section 11)
  cmd/factory/main.go         thin: cli.Execute(), one os.Exit
  internal/
    config/     Config, Defaults, Load(repo)                     ← config.ts
    job/        Job, Stage, Paths, Load/Save/List, Clone, activity,
                slots, Lock, ids (IDFor, TicketOf, CaseBranch, Slugify)
                                                ← job.ts paths.ts lock.ts ids.ts (pure parts)
    machine/    Route, Apply, CommandError (pure, no I/O)        ← machine.ts
    handoff/    OutputPath, Check, parsers                       ← handoff.ts
    harness/    Role, LoadRole(fs), Resolve, TaskPrompt, Command, Playwright
                                                ← harness.ts roles.ts
    proc/       Runner/Exec, ExitError, Spawner (Process, Inline), run script,
                WaitForFile, ReadExitCode, Shq, Notify       ← exec.ts spawn.ts shell.ts notify.ts
    git/        Git, GitHub (over proc.Runner)                   ← git.ts
    tail/       stream formatters, LastTool, color              ← tail.ts
    ui/         WhatFor, NextHint, StatusTable, Steps, Paint, Ago, Headline
                                                ← ui.ts, prbody.ts STEPS
    driver/     Run, GrillTurn, step, agents, stages, prbody, hooks, proof
                                                ← driver.ts stages.ts prbody.ts hooks.ts
    app/        the operations: New, Answer, Status, Approve, Feedback,
                Unblock, Retry, Discard, Logs; Deps and MakeDeps
                                                ← commands/*.ts (logic), deps.ts
    cli/        cobra commands: parse, call app, print   ← cli.ts, commands/* (printing)
    dashboard/  net/http server, handlers, templates/, static/   ← server.ts, dashboard.html
    testkit/    TempRepo, BuildBins, scenario types
      fakeagent/  main: scenario-driven fake claude/pi agent  ← fixtures/fake-agent.ts
      fakegh/     main: recording fake gh                      ← in-process gh fake in e2e.test.ts
      demo/       main: seed demo jobs and serve the dashboard with fake deps
                                                ← seed-demo.ts + serve-demo.ts
    e2e/        e2e_test.go                                     ← e2e.test.ts
```

`app` exists so that `cli` and `dashboard` call the same operations. Today
`server.ts` imports `commands/*`. In Go, the cobra layer only parses and
prints. A package is split only where the responsibility differs. The small
TS modules (`hooks`, `notify`, `ids`, `shell`, `roles`) join the package that
uses them.

### 3. Cross-cutting patterns (the blueprint for this module)

`AGENTS.md` has no blueprint, and there is no Go code yet. The closest
convention in the repo is
`stow/claude/.claude/skills/go-service-setup/SKILL.md`, so it is followed:
stdlib first, `cmd/` plus `internal/`, a thin `main` with one exit, table
tests, and its lefthook shape. The package README records the patterns below
as the module's conventions.

- **Dependencies**: only `github.com/spf13/cobra` (settled) and
  `github.com/yuin/goldmark` (Markdown, section 9). Tests use the stdlib
  only: `testing` and `reflect.DeepEqual`, with no testify.
- **Deps injection**: `app.Deps` replaces `deps.ts`:
  ```go
  type Deps struct {
      Exec      proc.Runner   // every git, gh, hook, setup, notify call
      Spawner   proc.Spawner
      Git       *git.Git      // built on Exec
      GH        *git.GitHub   // built on Exec
      Roles     fs.FS         // factory.Roles; tests may swap it
      Self      string        // path of the factory binary: os.Executable() in prod, built binary in tests
      CommandFor func(role string, f harness.Files) string // test override of the agent command line
      Notify    func(ctx context.Context, title, msg string)
      Now       func() time.Time
      Sleep     func(ctx context.Context, d time.Duration) error
      Log       func(line string)      // goroutine-safe (mutex-guarded writer)
      Heartbeat time.Duration          // 0: none
  }
  ```
  `app.MakeDeps(repo, inline bool)` builds the real set.
- **External commands**: `proc.Runner.Run(ctx, argv, proc.Opts{Dir, Env, Stdin}) (proc.Result, error)`.
  The returned error means only "could not start". `Result` has `Code`,
  `Stdout`, `Stderr`, and `Combined` (both streams, in the order written).
  `proc.Check(argv, r) error` turns a non-zero exit into a `*proc.ExitError`.
- **Errors**: these typed errors are matched with `errors.As` in one place
  each:

  | Error | CLI | HTTP |
  | --- | --- | --- |
  | `machine.CommandError` | exit 1 | 400 |
  | `job.LockError` | exit 1 | 409 |
  | `dashboard.httpError{Status}` | n/a | its status |
  | anything else | exit 1 | 500 |

  `cli.ErrReported` means "already printed, exit 1", like `ReportedError`
  today. Errors are wrapped with `%w` and context. `FACTORY_DEBUG` goes away
  because Go errors carry no stack. The wrapped chain is the context.
- **Failure reasons (req 11, Risk 9)**: `proc.ExitError{Cmd, Code, Tail}`
  keeps the last 20 non-empty lines of `Combined`. `Error()` gives a summary
  line, then the tail:
  `<cmd> failed (exit N): <last non-empty line>`, then a blank line, then the
  tail. The same type covers git and gh (`GitError` goes away), hooks
  (`stages.ts:123`) and `new`'s setup commands (today the last 30 lines; now
  one constant, 20). The full text goes into `job.Reason`. One-line places use
  `ui.Headline(reason)`, the first line:
  - the status table and the activity log transition line
  - the desktop notification
  - the PR headline `⏸ **Waiting for you: …**`
  - the dashboard card

  The full reason is shown in:
  - `factory status <id>`
  - the dashboard failure ticket and drawer, in a `<pre>`
  - `driver.log`
  - the PR decision block, fenced

  The summary line names the last output line, which is where the real cause
  is (the `feedback.md` case).
- **Persistence**: JSON files written to `<file>.tmp` and renamed, as today.
  `encoding/json` with `MarshalIndent` and a trailing newline.
- **Concurrency (gap, Risk 7)**: the driver's per-job state is a `run` struct:
  ```go
  type run struct {
      repo  string; paths job.Paths; cfg config.Config; deps app.Deps // read-only
      mu    sync.Mutex
      job   job.Job                     // guarded by mu
  }
  func (r *run) update(fn func(j *job.Job)) error // lock; fn; save; unlock
  func (r *run) snapshot() job.Job                // lock; Clone; unlock
  ```
  - `job.Job.Clone()` deep-copies `Trips` (each record's `Reviews` and
    `Validations` maps and its `Built` slice), `Decisions`, `Running` and
    `Discovery`.
  - `machine.Route` and `machine.Apply` take a `job.Job` by value, start with
    `j := in.Clone()`, and return `j`. They never touch the input's backing
    arrays.
  - `runAgents` starts every agent from the calling goroutine, then waits on
    each in its own goroutine (`sync.WaitGroup.Go`). It collects results by
    index and returns after all are done. Failed waits are combined with
    `errors.Join`, which matches `Promise.allSettled`.
  - `onResult` and heartbeats go only through `update` and `Log`.
  - Every test runs with `-race`.
- **Processes (Risk 8)**: `proc.ProcessSpawner` starts `bash <script>` with
  `SysProcAttr{Setsid: true}`, so each process gets its own session and
  process group, like `detached: true`. It writes `<name>.pid` and then runs
  `go cmd.Wait()`, which reaps the child the moment it exits. `IsAlive` is
  pid file plus `syscall.Kill(pid, 0)`, where nil or `EPERM` means alive.
  `Kill` is `syscall.Kill(-pid, SIGTERM)`. Files that use these calls carry
  `//go:build unix`. `InlineSpawner` keeps today's contract.
- **Signals**: the driver (`run --here`) and the CLI keep Go's default
  SIGTERM and SIGINT behaviour, so they die at once, as the Bun driver does.
  A graceful driver could save its old state after `feedback` saved the new
  cycle (`feedback.ts` comment: "The driver goes first…"). The stale
  `driver.lock` is taken over by the dead-pid check, as today. Only
  `dashboard` uses `signal.NotifyContext` for a graceful `http.Server`
  shutdown.
- **Output**: human lines go to injected `io.Writer`s through `ui.Paint`,
  which honours `NO_COLOR`, `FORCE_COLOR` and TTY detection. There is no
  `slog`: the CLI and `driver.log` are read by humans, and the skill's slog
  JSON is meant for services.
- **Self-invocation (weak spot)**: run scripts pipe through
  `<Self> tail --format <h>`. The driver respawn runs
  `<Self> run <id> --here --repo <repo>`. `Self` comes from `Deps`, so tests
  point it at a binary they built (section 10).

### 4. Job flow (unchanged except where noted)

`app.New` → `driver.GrillTurn` (headless grill, preflight inline) →
`driver.Run`. `Run` takes the lock, stops leftovers, then steps until the job
waits. Each step runs the stage, routes the outcome, saves, writes the
activity line and runs `updatePr`. Then `Run` notifies.

Visit markers, reusable outputs, attempts named `<role>-<n>`, the heartbeat,
the 2 s done-file poll, tier timeouts and "window closed" detection all port
one to one from `driver.ts`. A cancelled `ctx` aborts a step without routing
or saving.

**Docs out of the repo (req 9)**:

- `handoff.OutputPath` puts the five docs at `<jobDir>/docs/<kind>.md`:
  `requirements.md`, `tech-discovery.md`, `design.md`, `spec.md` and
  `test-plan.md`.
- `commitDoc`, `writeDoc`'s commit and push, `docsCommitType`, and the config
  key `docs` are deleted. Doc-writing stages only spawn and check.
- The Docs line of the task prompt lists absolute paths. Agents already have
  the job folder: claude through `--add-dir <jobDir>`, and pi has no such
  restriction.
- `job.TakenIDs` scans only the job folders, since there is no requirements
  folder in the repo anymore.

**Opening the PR (consequence of req 9)**:

- Today the requirements commit is what lets `preflight` open a draft PR, and
  `gh pr create` refuses a branch with no commits.
- `preflight` now only runs the access check.
- `ensurePr` (find or create the draft PR, `prOpened`, `qaUrl`) runs in
  `build`, right after the first successful push, and again after any later
  push while `job.PR` is empty.
- Nothing before build needs the PR: grill and design questions go through
  `factory answer`, and escalations come after build. `prOpened` still runs
  long before `qa-wait`.
- `initialBody` reads: "_Work in progress by the factory. Its docs are linked
  above._"

**Doc links in the PR body (Question 1, recommended option)**:

- The proof ref `factory-proof/<id>` (an orphan commit, already used for
  proof) also carries the docs. `driver.pushProof` builds one temp-index tree
  from two adds:
  - `git --work-tree=<proofDir> add -A .`: proof files at the tree root, as
    today.
  - `git --work-tree=<jobDir> add docs`: docs under `docs/`.
- It then runs `write-tree`. It returns early when the tree hash equals the
  last pushed one, stored in `run/proof.tree`. Otherwise it runs
  `commit-tree`, then
  `git push --no-verify --force origin <sha>:refs/heads/factory-proof/<id>`
  (req 10). The cwd is still the main checkout, but the hook no longer runs.
- `updatePr` calls it before it renders the status block, so `Docs:` links
  point to `https://github.com/<nwo>/blob/<sha>/docs/<kind>.md` and are
  always current.
- A failed push is noted and is not fatal there, like any PR status failure.
  In `finalize` it is fatal, as today.
- `discard` already deletes the proof branch.
- If Question 1 gets answer B, `pushProof` drops the docs add, runs only in
  `finalize`, and the `Docs:` line lists the job-folder paths as plain text.

**Harness per job (req 5)**:

- `factory new --harness claude|pi` sets `job.Harness`. With no flag,
  `cfg.DefaultHarness` applies. The value is validated.
- `harness.Resolve(role, job.Harness, cfg)` takes the harness only from the
  job. `role.browser` no longer forces claude, and `roles.<name>.harness` is
  gone.
- Tier still maps to `cfg.Models[harness][tier]`, and timeout to
  `roles.<name>.timeoutMin` or `timeoutsMin[tier]`.
- Branch naming (`app.nameBranch`) and the grill use the job's harness.

### 5. CLI (cobra)

`cli.Execute(ctx, args, stdout, stderr) int` builds the root command with:

- `SilenceUsage` and `SilenceErrors`.
- A persistent `--repo` flag. `--repo` refuses a linked worktree, as today.
- One file per command.

Positionals after `--` (and before it) are joined into one string, as today.
Both skills always pass `--`. `main.go` is
`os.Exit(cli.Execute(context.Background(), os.Args[1:], os.Stdout, os.Stderr))`.
Errors print `factory: <msg>` in red on stderr. Lines starting `!` stay
warnings. Cobra's default `completion` command is kept, because cobra gives it
for free. No other new commands are added.

### 6. Browser roles on both harnesses (req 6, Risk 6)

One Go value is the source of truth:

```go
var Playwright = MCPServer{Name: "playwright", Command: "npx",
    Args: []string{"-y", "@playwright/mcp@0.0.86", "--isolated", "--headless"}}
var PlaywrightTools = []string{"mcp__playwright__browser_navigate", … 12 names, as today}
```

At spawn time, `harness.Command` writes the needed file into the job's `run/`
folder (`0o600`), outside the worktree:

- **claude**: writes `run/playwright.mcp.json` (`{"mcpServers":{"playwright":{…}}}`)
  and passes `--mcp-config <file>`. Allowed and disallowed tools stay as
  today.
- **pi**: writes `run/playwright.pi.js`, a 6-line pi extension
  (`export default function (pi) { pi.registerMcpServer("playwright", {command, args, exposure: "direct"}) }`),
  and passes `-e <file>`. The 12 tool names are appended to `--tools`.
  `direct` exposure declares them to the model. Naming `mcp__…` entries in
  `--tools` keeps them, per pi 1.5.2 `docs/cli.md` "MCP tools" and `docs/mcp.md`
  "Control tool exposure". The extension is plain JS, which pi loads
  (`docs/extensions.md:131`), so no `.ts` file comes back into the package.
  It is generated data, not a source file.

The worktree is never touched, so there is no `.pi/mcp.json` and no
`--approve`. A unit test asserts both command lines. The pi browser path is
not exercised by the real run, which is claude only, so the test plan adds a
manual pi smoke check.

### 7. Config and state

- **`.factory.json`** stays JSON, merged over `config.Defaults()`. It is
  decoded with `json.Decoder` and `DisallowUnknownFields` into the
  defaults-filled struct. That gives today's merge rule (objects merge, arrays
  and scalars replace) and also errors on unknown keys.
  - Removed keys: `docs`, `docsCommitType` and `roles.*.harness`.
  - `validators`, `defaultHarness` and tiers are validated as today.
  - This is plain validation, not migration work: an old file with `docs` now
    fails with `unknown field "docs"`, which Out of scope accepts.
- **`job.json` v3**: v2's fields plus `harness`, with `version: 3`. Nullable
  strings become empty strings (`omitempty`). `ready` stays tri-state
  (`*bool`), and `waitingSince` becomes `*time.Time`. `job.Load` rejects any
  version other than 3, and `List` skips such files, as today with v1.
- Job folder layout: today's, plus `docs/`, `run/proof.tree`,
  `run/playwright.mcp.json` and `run/playwright.pi.js`.

### 8. Repo hooks, notifications, ids

These are ported as they are. Hooks run `bash -c <script>` with
`JOB, PR, BRANCH, SHA`, and their failures become `ExitError`s. `proc.Notify`
calls `osascript` on darwin and `notify-send` on linux, then rings the
terminal bell, and never errors. `job.IDFor`, `CaseBranch`, `TicketOf` and
`Slugify` keep their regexes.

### 9. Dashboard (req 7, 8, 16, Risk 10)

It is server-rendered with `html/template`, htmx 2 and Tailwind 4 plus
daisyUI 5. A small `app.js` covers what htmx can't, about 150 lines:

- toasts on stage changes
- browser notifications
- keyboard shortcuts
- keeping the selection across refreshes
- log auto-follow
- ⌘/Ctrl+Enter to send

Feature parity with `dashboard.html` is the bar: nothing is added and nothing
is dropped.

- **Server**: `dashboard.Serve(ctx, repo, port, deps)` listens on
  `localhost:<port>` (default 8000, where 0 picks a free port) and prints
  `http://localhost:<port>`. It runs an `http.Server` with
  `ReadHeaderTimeout` and graceful `Shutdown` (skill pattern). `http.ServeMux`
  uses Go 1.22+ method and path patterns, and the mux sits in its own
  function for tests.
- **Guards**, kept and adapted from `server.ts:194-199,243`:
  - The `Host` header must be `localhost:<port>` or `127.0.0.1:<port>`.
  - On POST, `Origin`, when present, must match one of those.
  - POSTs need `X-Factory: 1`, which htmx sends through `hx-headers` on
    `<body>`.
  - Every response carries
    `Content-Security-Policy: default-src 'self'; img-src 'self' data:`
    and `Cache-Control: no-store`. htmx eval is turned off with the
    `htmx-config` meta tag `allowEval:false`. With no inline script allowed,
    rendered Markdown cannot run code.
- **Markdown**: goldmark with the GFM extension. It omits raw HTML and drops
  dangerous URLs by default; `html.WithUnsafe` is never set. An AST
  transformer rewrites relative links and images to the job's file endpoint,
  as `fileUrl` does today.
- **Files**: `/jobs/{id}/file` serves only paths inside the job folder, after
  `filepath.EvalSymlinks`, with 403 outside and 404 when missing. Docs now
  live in the job folder, so the second root `<worktree>/docs` is gone.
- **Assets**:
  - `htmx.min.js` (2.x) and daisyUI's standalone `daisyui.mjs` are vendored
    at pinned versions.
  - Tailwind's standalone CLI is pinned in `mise.toml`.
  - `mise run css` builds `static/app.css` from `web/app.css`, which uses
    `@import "tailwindcss"` and `@plugin "./daisyui.mjs"`. The output is
    committed, so `go build` and `mise run install` need no Tailwind and work
    offline on all three hosts.
  - The JSON API `/api/*` goes away: only `dashboard.html` used it (grep of
    both skills: no hits).

### 10. Toolchain and tests

- **`mise.toml`** (module folder):
  ```toml
  [tools]
  go = "1.27.4"
  golangci-lint = "2.15.0"
  lefthook = "2.2.4"
  "aqua:tailwindlabs/tailwindcss" = "4.3.5"

  [tasks.install]
  description = "Build factory into ~/.local/bin/factory"
  env = { CGO_ENABLED = "0" }
  run = 'go build -trimpath -o "$HOME/.local/bin/.factory.new" ./cmd/factory && mv -f "$HOME/.local/bin/.factory.new" "$HOME/.local/bin/factory"'

  [tasks.css]
  run = "tailwindcss -i internal/dashboard/web/app.css -o internal/dashboard/static/app.css --minify"

  [tasks.check]
  run = ["golangci-lint fmt --diff", "go vet ./...", "golangci-lint run", "go test -race ./..."]

  [tasks.demo]
  run = "go run ./internal/testkit/demo"
  ```
  - Build then `mv -f` replaces the old stow symlink itself, whether it
    dangles or still points at the TS launcher. It also avoids Linux "text
    file busy" while a driver runs the old binary.
  - `CGO_ENABLED=0` gives a static binary, which needs no NixOS loader.
  - Tasks run from the config root, the module folder.
- **`go.mod`**: `module github.com/marco-souza/nixos/stow/factory` and
  `go 1.27.4`. Path elements can't start with `.`, so the path can't mirror
  `.local/share`. It is never fetched.
- **`.golangci.yml`** (v2):
  - `linters.default: standard`, plus `bodyclose`, `errorlint`, `gocritic`,
    `gosec`, `misspell`, `noctx`, `nolintlint`, `revive`, `unconvert` and
    `usestdlibvars`.
  - gosec `G204` (subprocess with variable args) and `G304` (file path from a
    variable) are excluded with a comment. Running commands and reading job
    files by path is the program's job, and the one place where confinement
    matters (the file endpoint) is tested directly.
  - `formatters.enable: [gofumpt, goimports]`, with `goimports.local-prefixes`
    set to the module path. "The formatter" (req 15) is
    `golangci-lint fmt --diff`.
- **`lefthook.yml`** at the repo root, because lefthook reads it from the git
  toplevel (Risk 4):
  ```yaml
  pre-commit:
    jobs:
      - name: factory fmt+lint
        root: stow/factory/.local/share/factory/
        glob: "*.go"
        run: golangci-lint fmt {staged_files} && golangci-lint run --fix ./...
        stage_fixed: true
  pre-push:
    jobs:
      - name: factory test
        root: stow/factory/.local/share/factory/
        glob: "*.go"
        run: go test -race ./...
  ```
  `root` and `glob` keep every other file out (req 13). The builder checks
  with `lefthook run pre-push` that a push with no Go file skips the tests. If
  lefthook doesn't skip it, the tests still pass, just slower. Nobody runs
  `lefthook install` but Marco.
- **Tests (req 14)**: stdlib `testing`, table tests, all with `-race`.
  - `internal/machine/machine_test.go`: every case of `machine.test.ts`, about
    45, ported one to one, including both "never mutates its input" cases.
    Those compare against a `Clone()` taken before the call.
  - `internal/proc/spawn_test.go`: the two `spawn.test.ts` cases, with real
    processes. A background agent is alive and `Kill` takes its whole tree.
    A quick agent leaves its exit code and `IsAlive` is false afterwards,
    which proves reaping.
  - `internal/e2e/e2e_test.go`: the 14 `e2e.test.ts` cases, with real git
    (`testkit.TempRepo`: a repo plus a bare `origin`) and the real embedded
    roles.
    - `TestMain` runs `go build` once into a temp `bin/` for three binaries:
      `factory` (`Deps.Self`, for `tail`), `fake-agent`, and `gh` (fakegh).
      The `gh` binary goes first on `PATH`, next to `claude` and `pi` stubs
      that exit 99.
    - Agents run through `CommandFor` → `fake-agent`, with the scenario of
      verdicts per role and visit in a JSON file. Builders commit,
      validators write `proof/ac<k>-…`, the grill asks once then writes the
      doc, `sleepMs` drives the heartbeat, and output is claude `stream-json`
      lines.
    - `Now` and `Sleep` are a fake clock that advances on `Sleep`.
    - Assertions that change:
      - no `docs: … for <id>` commits
      - docs exist in `<jobDir>/docs/`
      - the draft PR opens in build
      - `factory-proof/<id>` in the bare origin holds `docs/`
      - recorded gh calls come from `fakegh`'s log
  - `internal/dashboard/server_test.go` (httptest):
    - the Host, Origin and X-Factory guards
    - file endpoint confinement, symlink escape included
    - a doc with `<script>` and a `javascript:` link renders inert
    - approve and retry give 409 while a live driver holds the lock
  - `internal/harness/command_test.go`: the claude and pi command lines,
    browser and non-browser.
- **fakegh**: state lives in `$FAKE_GH_DIR`, and every call is appended to
  `calls.jsonl`. It answers:
  - `auth status`
  - `repo view --json defaultBranchRef,nameWithOwner`
  - `pr list --head`
  - `pr create --draft …` (prints `https://github.com/acme/repo/pull/<n>`)
  - `pr view --json body|headRefName|comments,reviews`
  - `pr edit --body-file|--title`
  - `pr ready [--undo]`
  - `pr close`
  - `api repos/{owner}/{repo}/pulls/<n>/comments --paginate`

  Any other call exits 1 naming the call. The e2e and the real run (req 17)
  both use this one fake.
- **Demo (req 16)**: `mise run demo`
  (`go run ./internal/testkit/demo [-dir <d>] [-port 8000]`) seeds a temp
  repo with jobs in every state, ported from `seed-demo.ts`. It serves the
  dashboard with fake deps: actions apply `machine.Apply` and save, and
  nothing is spawned. The tmux leftovers in `serve-demo.ts` are not ported.

### 11. Docs and skills (req 18)

- `roles/_common.md:18`: the `Docs` line holds "absolute paths in the job
  folder", not "relative to the worktree". No other role changes. Builders
  never commit docs, because docs are no longer in the worktree.
- `stow/claude/.claude/skills/factory/SKILL.md` and
  `stow/pi/.pi/agent/skills/factory/SKILL.md`:
  - "if `factory` is not found" now says to run `mise run install` in
    `stow/factory/.local/share/factory`.
  - The `new` usage line gains `[--harness claude|pi]`.
- `AGENTS.md`:
  - The layout row reads "(Go)".
  - Setup: `stow/factory` needs mise's Go and is built with
    `mise run install`, which only Marco runs. Agents never run
    `mise run install` against the real `$HOME` or `lefthook install`.
    Both are added next to `./stow.sh` in the "never" list.
  - The validation row for `stow/factory/` is `mise run check` in the module
    folder.
  - The demo commands become `mise run demo`.
  - `lefthook.yml` is mentioned.
- `README.md` lines 23, 51 and 53: Go instead of Bun, and install with
  `mise run install`.
- The package `README.md` is rewritten:
  - the commands, with `--harness`
  - the config keys, without `docs`, `docsCommitType` or `roles.*.harness`
  - the state, with `docs/` in the job folder and the proof ref carrying the
    docs
  - roles, which are embedded, so an edit needs `mise run install`
  - install, tests and the demo
  - the switch-over note: after merging, run `mise run install` on each host;
    v2 jobs and old `.factory.json` files are not read

### Risks from the tech discovery, and how each is handled

1. **Stale base and push rejection.** Task 1 merges `origin/main`, with no
   rebase (section 0).
2. **Agents touching `$HOME` or `.git/hooks`.**
   - Validators check install with `HOME=$(mktemp -d) mise run install`.
   - Hooks are checked with `lefthook validate` and `lefthook run …`.
   - `AGENTS.md` forbids both commands.
3. **Stow links root files.** The module stays under `.local/share/factory/`
   (section 1).
4. **lefthook location and slow pushes.** The config is at the repo root,
   scoped with `root` and `glob` (section 10).
5. **Doc link target.** Question 1. The design uses the proof ref (section 4).
6. **pi and Playwright.** An embedded JS extension loaded with `-e`, `direct`
   exposure, and tools named in `--tools`. The command line is unit-tested,
   with a manual smoke check (section 6).
7. **Races and aliasing.** The `run.mu` mutex, `Clone()`, by-value machine
   functions and `-race` (section 3).
8. **Zombies and process groups.** `Setsid` and a `Wait` goroutine, proven by
   the spawn tests (section 3).
9. **Multi-line reasons.** A summary line plus a tail, with `ui.Headline` in
   one-line places (section 3).
10. **Dashboard security.** Host, Origin and X-Factory guards, CSP, goldmark
    safe by default, and the file endpoint confined to the job folder, all
    tested (section 9).
11. **New dependencies and build steps.**
    - Only cobra and goldmark come in as Go deps.
    - htmx and daisyUI are vendored, and Tailwind is pinned in mise.
    - The CSS is committed.
    - `npx` stays a runtime need for Playwright, as today (README).
12. **Test-harness pitfalls.** `TestMain` builds the binaries, plus
    `Deps.Self`, the fake clock, and real reaping (section 10).
13. **Switch-over.** README and the PR body say to run `mise run install` on
    each host after merging. Until then `~/.local/bin/factory` dangles.
    Running TS jobs elsewhere break, which the Decisions accept.
14. **This PR carries this job's docs.** The TS factory driving this job
    commits `docs/*/rewrite-factory-golang.md` into the branch and reads them
    from the worktree until finalize. A builder who deletes them breaks the
    job, and later doc commits add them back. No task touches them. Marco
    removes them after the job if he wants (section "Decided").
15. **Real run cost.** This is guidance for the test plan: a tiny request,
    and a scratch `.factory.json` with `validators: ["e2e"]`, `maxTrips: 1`
    and cheaper `models.claude` tiers. The scratch repo needs a local bare
    `origin` and `fakegh` first on `PATH`. `new`'s preflight (`gh auth status`,
    `git remote get-url origin`) then passes.

### Data

`job.json` v3 (`internal/job/job.go`):

```go
type Job struct {
    Version     int          `json:"version"`         // 3
    ID          string       `json:"id"`
    Feature     string       `json:"feature"`
    Branch      string       `json:"branch"`
    Base        string       `json:"base"`
    Harness     Harness      `json:"harness"`         // NEW: "claude" | "pi", fixed at `new`
    Deliverable Deliverable  `json:"deliverable,omitempty"` // "", "pr", "report"
    Decisions   []string     `json:"decisions"`
    Worktree    string       `json:"worktree"`
    Slot        int          `json:"slot"`
    Stage       Stage        `json:"stage"`
    Cycle, Trip int          `json:"cycle"`, `json:"trip"`
    Planned     bool         `json:"planned"`
    DiscoveryLoops, ExtraDiscoveryLoops, ExtraTrips, EnvRetries int
    WaitingFor   WaitingFor  `json:"waitingFor,omitempty"`
    WaitingSince *time.Time  `json:"waitingSince,omitempty"`
    Reason        string     `json:"reason,omitempty"`        // may be multi-line: summary + tail
    StoppedReason string     `json:"stoppedReason,omitempty"`
    ResumeStage  Stage       `json:"resumeStage,omitempty"`
    CapHit       CapHit      `json:"capHit,omitempty"`
    ReasonFile, QuestionsFile string
    FeedbackCount int
    Ready        *bool       `json:"ready"`
    PR, QAURL    string
    Running      []string
    Trips        []TripRecord // {Cycle, Trip, Reviews map, BuildJudge, Validations map, ValidationJudge, Built []string}
    Discovery    []DiscoveryRecord // {N, Verdict}
    CreatedAt, UpdatedAt time.Time
}
```

Stages, waiting kinds and cap kinds are string types with consts, with the
same values as the TS unions.

`job.Paths` is today's `JobPaths`, plus:

- `DocsDir` (`<jobDir>/docs`)
- `Doc(kind)` → `<jobDir>/docs/<kind>.md`
- `ProofTree` (`run/proof.tree`)

`.factory.json` (`internal/config`):

```go
type Config struct {
    Base              string            `json:"base"`
    PRTitle           string            `json:"prTitle"`
    Setup             []string          `json:"setup"`
    Hooks             Hooks             `json:"hooks"`        // prOpened, qaUrl, qaReady
    Validators        []string          `json:"validators"`   // e2e, user, load, capacity
    Roles             map[string]RoleOverride `json:"roles"`  // {tier, timeoutMin}; no harness
    DefaultHarness    Harness           `json:"defaultHarness"` // "claude"
    Models            map[Harness]map[Tier]string `json:"models"`
    TimeoutsMin       map[Tier]int      `json:"timeoutsMin"`
    MaxTrips, MaxDiscoveryLoops, QAReadyTimeoutMin, QAPollSec int
}
```

The defaults are today's `config.json` minus `docs` and `docsCommitType`. No
migration and no detection: unknown keys fail decoding.

The proof ref tree is the proof files at the root, as today, plus
`docs/<kind>.md` for the docs that exist.

### API

CLI (cobra). `--repo <path>` works on every command.

| Command | Change from reference |
| --- | --- |
| `factory new [--base <b> \| --stack <PR#>] [--harness claude\|pi] [--] <feature>…` | `--harness` is new. Prints the first grill question |
| `factory answer <id> [--] [<text>…]` | none |
| `factory status [<id>] [--json]` | `--json` prints v3 jobs plus `hint` and `whatFor`. The detail view shows the full multi-line reason |
| `factory logs <id> [<role>] [-f]` | none |
| `factory approve <id>` | none |
| `factory feedback <id> [--] [<note>…]` | none |
| `factory unblock <id> [--] <decision>…` | none |
| `factory run <id> [--inline]` | hidden `--here` stays |
| `factory discard <id> [--yes]` | none |
| `factory dashboard [--port <n>]` | serves on `localhost`, default 8000, where 0 picks a free port |
| `factory tail --format claude\|pi` (hidden) | none |

Exit codes: 0 means OK, 1 means any error. Errors print as `factory: <msg>`.

Dashboard HTTP: every response is HTML or a static file. POST needs
`X-Factory: 1`.

| Route | Returns | Errors |
| --- | --- | --- |
| `GET /` | the full page: layout, board fragment, empty drawer, help dialog | — |
| `GET /board` | fragment: header counts, Needs you, columns, Done, and discarded behind the toggle. Polled every 2 s | 500 → sync dot goes offline |
| `GET /jobs/{id}?tab=timeline\|docs\|trips\|logs` | drawer fragment | 404 job not found |
| `GET /jobs/{id}/doc?path=<rel>` | rendered Markdown of a job-folder file | 403 outside the job dir, 404 missing |
| `GET /jobs/{id}/log?name=<role-n>&lines=<n>` | formatted log lines, ANSI stripped, at most 2000 lines | 404 |
| `GET /jobs/{id}/file?path=<rel>` | raw file (proof images) | 403, 404 |
| `POST /jobs/{id}/approve\|retry\|feedback\|discard` | the refreshed board fragment (`HX-Retarget: #board`) | 400 `CommandError`, 409 driver running, 500. The body is the message, shown as a toast |
| `GET /static/{file}` | embedded `app.css`, `htmx.min.js`, `app.js` | 404 |

`feedback` takes form field `note`. The handlers call `app.Approve`,
`app.Retry`, `app.Feedback` and `app.Discard`, the same functions the CLI
calls.

### UI

The page is one screen, and the look is new: daisyUI components on a dark
theme. The parts the user sees:

- **Header**: the project name, and counts for running, needs-you and done
  jobs.
  - A sync dot: green while `/board` polls succeed, red with "Reconnecting…"
    after a failed poll.
  - A "Notify me" button, shown only while browser permission is undecided.
  - A `?` button that opens the shortcuts dialog.
- **Needs you**: one ticket per waiting job, oldest wait first, each with the
  job id, the feature, `whatFor` and the time waited. Actions by kind, the
  same as today:
  - grill: Discard. The hint says "answer in your chat: `factory answer <id>`".
  - review: Approve, a Feedback box, Open PR, Discard.
  - env: Retry, Approve, Read why (opens the reason file in the drawer),
    Discard.
  - escalation: the judge's first question, shown inline. Approve, Feedback,
    Read why, Open PR, Discard.
  - failure: the headline of the reason, with a "details" toggle that shows
    the tail in a `<pre>`. Retry, Open logs, Discard.

  The Feedback box keeps its text across polls (`hx-preserve`) and sends on
  ⌘/Ctrl+Enter. Discard asks first (`hx-confirm`). When the list is empty it
  reads "Nothing needs you".
- **Board**: columns Discovery, Building, Validation and Deploy (from
  `ui.Steps`), then Done. A card shows the id, the feature, the step label
  with its `(k/n)` counter, and the time since update. A "Show discarded"
  toggle reveals discarded jobs. An empty board reads "No jobs yet. Start one
  with `factory new`."
- **Drawer**: it opens on a card click or Enter, and Esc closes it. The
  header shows the id, the feature, the stage, the PR link, and the same
  action buttons as the job's ticket. Tabs:
  - Timeline: the last 200 activity lines.
  - Docs: the five docs, each marked present or not yet. A click renders it.
  - Trips: each trip folder's files. A click renders it.
  - Logs: a log picker, newest first. The view polls every 2 s and follows
    the end unless the user scrolled up.

  While a tab loads, it shows an htmx indicator. A job deleted under an open
  drawer shows "Job not found".
- **Feedback from actions**:
  - On success, the board refreshes.
  - On failure, a toast shows the server's message, for example "driver
    already running for x (pid 123)…".
  - A stage change seen between polls shows a toast: `<id>: <from> → <to>`.
  - A job that starts needing the user fires a browser `Notification` when
    permission is granted.
- **Keys**: `j`/`k` move the selection across tickets and cards, Enter opens
  the drawer, `a` approves the selected job, `f` focuses its feedback box,
  `?` opens help, and Esc closes the drawer or dialog. Keys are ignored while
  typing in a field.
- **No-permission state**: none. The dashboard is local with no auth.

## Alternatives

1. **Port the reference architecture into idiomatic Go packages (picked).**
   Same pure machine, file state, background driver and run scripts.
   Embedded data, server-rendered htmx dashboard. The risk is low: every
   behaviour has a TS reference and a test to port, and the 98 reference
   tests map to Go tests. The cost is the Go-specific weak spots (races,
   reaping, self-invocation), each handled in section 3. It changes
   nothing in how Marco drives jobs beyond `--harness` and the doc
   location.
2. **One long-running factory daemon.** One process owns every job's driver
   goroutine and the dashboard, and the CLI talks to it over a unix socket.
   It removes pid files, self-invocation and the lock. But it adds a service
   to install and supervise on three hosts (launchd and systemd), puts every
   job behind one process (a crash stops them all), and changes the
   workflow, which the request didn't ask for. Not picked.
3. **In-process agents without run scripts.** The driver starts agents with
   `exec.Cmd` and pipes their output through `tail` in-process. That removes
   the bash scripts and `factory tail`. But agents would no longer outlive
   the driver. "A failed window stays open for inspection" and
   `stopLeftovers` semantics change, a driver crash takes its agents with it,
   and the `.sh` file Marco can rerun by hand to debug an agent is lost.
   Not picked.

Sub-choices weighed inside the picked approach:

- **Data**: embedded (picked) or read at runtime from `~/.local/share/factory`.
  Runtime reads keep role edits live, but tie the binary to stow and the main
  checkout again. The settled install flow already reruns the build after
  each merge.
- **CSS**: a committed Tailwind build (picked) or the Tailwind and daisyUI
  CDN. The CDN needs the network on every page load and isn't meant for
  production. The build adds one pinned tool and a `mise run css` step.
- **Markdown**: goldmark (picked) or a port of the 120-line JS renderer.
  goldmark is safe by default and server-side, while a hand-written sanitiser
  is what Risk 10 warns about.
- **Test fakes**: binaries built in `TestMain` (picked) or test-binary
  re-exec. Built binaries test the real `factory tail`, and they keep test
  hooks out of production code beyond `Deps.Self` and `Deps.CommandFor`.

## Decided without asking

- **Module location `stow/factory/.local/share/factory/`.** Req 2 names
  `stow/factory`. Root files would be stowed into `$HOME` (`stow -n -v` shows
  `LINK: go.mod`, Risk 3). The current folder needs no `.stow-local-ignore`
  and no `.nix` change.
- **Everything embedded.** `PACKAGE_DIR`/`CLI_PATH` coupling breaks for a
  copied binary (`paths.ts:4`, `spawn.ts:34`). The Decision "Marco reruns
  `mise run install` after merging" already implies a rebuild per change.
- **Draft PR opens at the first push in `build`, not in `preflight`.**
  `gh pr create` needs a commit, and req 9 removes the requirements commit.
  The alternative, an empty commit, would sit in every PR's history: commits
  that start empty survive `git rebase`. Nothing before build reads the PR.
- **Merge `origin/main` as task 1.** Req 1 asks only that the branch contain
  `f7fb2cf`. The TS build push is non-force (`stages.ts:97,303`).
- **This job's own `docs/*/rewrite-factory-golang.md` stay in the branch.**
  The TS factory reads them from the worktree until finalize and re-commits
  them. Removing them is Marco's call after the job.
- **Signal handling.** The driver keeps Go's default SIGTERM behaviour, so it
  dies at once, as Bun does. A graceful driver could overwrite `feedback`'s
  new cycle (`feedback.ts` "The driver goes first").
- **Config stays JSON `.factory.json` with strict decoding.** It is the
  repo's existing format. Typed decoding over defaults reproduces the merge
  rule, and unknown keys become errors: typo safety, not compatibility work.
- **`defaultHarness` keeps its name.** It is still exactly the default for
  new jobs (req 5).
- **Nullable fields become empty strings, except `ready` (`*bool`) and
  `waitingSince` (`*time.Time`).** This is idiomatic Go. v3 needs no reader
  for v2 (Out of scope).
- **Failure tail is the last 20 non-empty lines, in one constant.** This
  meets req 11 and replaces the two first-line spots (`git.ts:8`,
  `stages.ts:123`) and `new`'s 30-line setup tail.
- **`/api/*` JSON is dropped.** Only `dashboard.html` used it. The htmx
  dashboard reads HTML fragments.
- **CSP and goldmark's safe defaults.** Agent-written Markdown is untrusted
  (Risk 10). These replace `safeUrl`/`safeHref`.
- **pi gets Playwright through an embedded `-e` JS extension with `direct`
  exposure.** It doesn't touch the worktree. `.pi/mcp.json` with `--approve`
  could be committed by a builder and would shadow a repo's own file.
- **Linters and formatter.** golangci-lint v2 `standard` plus a short list,
  and gofumpt with goimports through `golangci-lint fmt`. Nothing exists in
  the repo yet. The skill asks for gofmt-level checks, and gofumpt is a
  strict superset.
- **Stdlib-only tests and two Go deps.** This follows the repo's
  `go-service-setup` skill: "No frameworks, no deps unless forced".
- **`lefthook.yml` at the repo root, scoped by `root` and `glob`.** lefthook
  reads only the git toplevel (Risk 4), and req 13 limits hooks to the
  factory's Go files.
- **Static binary (`CGO_ENABLED=0`) installed by build-then-`mv`.** It works
  on NixOS without the loader, replaces the old stow symlink, and avoids
  "text file busy".
- **Cobra's default `completion` command stays.** It costs no code, and the
  user asked for cobra for the developer experience.

## Questions for the human
1. Where should the PR body's links to the job docs point, now that the docs stay in `.factory/jobs/<id>/docs/` and are never committed to the branch?
   - Why: a link has to resolve for whoever reads the PR. Option A publishes
     the docs to GitHub on a side ref. Option B keeps them on your machine
     only. The answer changes `pushProof`: whether it carries `docs/`, and
     whether it runs on every transition or only in `finalize`. It also
     changes the PR body's `Docs:` line and the e2e assertions.
   - A. Proof ref (recommended): the docs ride on the existing orphan
     `factory-proof/<id>` ref, next to the proof files. That ref is never
     merged, is pushed with `--no-verify`, and is deleted on discard. The
     links are GitHub blob links that every PR reader can open. This is what
     `feedback.md` suggests ("in the job folder or on the proof branch").
   - B. Local only: no docs leave your machine. The PR's `Docs:` line lists
     the job-folder paths as plain text, and reviewers can't open them. You
     read them in the dashboard.
