# Design: Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

The reference is `origin/main` at `f7fb2cf`. Every "today" and every TS file
reference below comes from that commit. Paths are relative to the Go module
folder `stow/factory/.local/share/factory/` unless they start with `stow/` or
name a repo-root file.

What changed since the last run: the discovery review found three points that
would make the build wrong. Each is fixed here:

- Tests clear git's repo-location variables before they run git, so a
  pre-push hook fired from a worktree can't point them at the real repo
  (section 10 "Tests", Risk 17).
- `.factory.json` is deep-merged over the defaults as raw JSON and then
  strictly decoded, so a partial `models.claude` keeps the other tiers
  (section 7, Data, Risk 16).
- `mise run install` reads its target folder from `FACTORY_BIN_DIR`, so
  validators install into a temp folder and keep the real `HOME` (section 10,
  Risk 3).

The review's notes are folded in too: htmx's indicator styles under the CSP
(section 9), two pi browser checks (section 6), and the folded `~/.local/bin`
symlink and this job's own docs in the switch-over notes (section 11, Risks
14 and 15). There are no questions.

## Approach

This is a port of the reference architecture into idiomatic Go. The
factory's shape stays: the state machine is pure, the driver runs a job as a
background process with file-based state, and agents run as detached run
scripts. Each TS module maps to a Go package. The requirements add these
changes:

- Docs live in the job folder and never leave the machine (req 9).
- The harness is chosen once per job, and browser roles get Playwright on
  both harnesses (req 5, 6).
- Failure reasons keep the last lines of output (req 11).
- The proof ref is pushed with `--no-verify` (req 10).
- The dashboard is server-rendered with Go templates and htmx (req 7, 8).

### 0. Branch first

The first build task runs `git merge origin/main`. It merges and does not
rebase, so the branch contains `f7fb2cf` (req 1). The TS factory that drives
this job pushes after each task without force (`stages.ts` build, `push(c)`).
A rebase would rewrite pushed history, so the next push would be rejected.
The branch only adds `docs/` files on top of `f0be919`, so the merge is
clean. The later `rebase` stage still puts the branch on top of
`origin/main`. Every port works from the merged tree. The `f0be919` tree,
which still has `attach`, is never a source.

### 1. Where the code lives and how the binary finds its data

The module stays where the TS package is: `stow/factory/.local/share/factory/`.
Nothing new goes at the `stow/factory/` root, so stow links no `go.mod` or
`mise.toml` into `$HOME` (Risk 4). Stow still links `~/.local/share/factory`
to this folder. That is harmless: the binary never reads from it.

Everything the binary needs is compiled in with `go:embed`, so a binary copied
to `~/.local/bin` works on its own (weak spot "package-dir coupling"):

- `roles/*.md` keep their path. A root file `assets.go` (`package factory`,
  `//go:embed roles/*.md`) embeds them. The `*.md` glob is needed: a bare
  directory pattern skips `_common.md` and `_builder.md`.
- `internal/dashboard` embeds the dashboard templates and static files.
- `config.Defaults()` replaces `config.json`.
- One Go value, `harness.Playwright`, replaces `mcp/playwright.json` and is
  rendered per harness (section 6).

A role edit needs `mise run install`. That fits the settled flow, where
Marco reruns it after each merge.

Files removed (req 3): `src/` (all tests and fixtures included),
`package.json`, `bun.lock`, `tsconfig.json`, `.gitignore`, `config.json`,
`mcp/`, `dashboard.html`, and `stow/factory/.local/bin/factory`. Removing the
last one empties `stow/factory/.local/bin/`.

### 2. Packages

```
stow/factory/.local/share/factory/
  go.mod  go.sum  mise.toml  .golangci.yml  README.md
  assets.go                   package factory: embeds roles/*.md
  roles/*.md                  unchanged, except _common.md (section 11)
  cmd/factory/main.go         thin: os.Exit(cli.Execute(...))
  internal/
    config/     Config, Defaults, Load(repo), merge                ← config.ts
    job/        Job, Stage, Paths, Load/Save/List, Clone, activity,
                slots, Lock, ids (IDFor, TicketOf, CaseBranch, Slugify, TakenIDs)
                                     ← job.ts paths.ts lock.ts ids.ts (pure parts)
    machine/    Route, Apply, CommandError (pure, no I/O)          ← machine.ts
    handoff/    OutputPath, Check, parsers                         ← handoff.ts
    harness/    Role, LoadRole(fs), Resolve, TaskPrompt, Command, Playwright
                                                    ← harness.ts roles.ts
    proc/       Runner, Result, ExitError, Spawner (Process, Inline), run script,
                WaitForFile, ReadExitCode, Shq, Notify   ← exec.ts spawn.ts shell.ts notify.ts
    git/        Git, GitHub (over proc.Runner)                     ← git.ts
    tail/       stream formatters, LastTool, color                ← tail.ts
    ui/         WhatFor, NextHint, StatusTable, Steps, Paint, Ago, Headline,
                RenderStatus, MergeStatus, MergeDecision, InitialBody
                                                    ← ui.ts, prbody.ts (pure parts)
    driver/     Run, GrillTurn, step, agents, stages, hooks, ensurePR, pushProof
                                     ← driver.ts stages.ts hooks.ts prbody.ts pushProof
    app/        the operations: New, Answer, Status, Approve, Feedback,
                Unblock, Retry, Discard, Logs; Deps and MakeDeps
                                                    ← commands/*.ts (logic), deps.ts
    cli/        cobra commands: parse, call app, print   ← cli.ts, commands/* (printing)
    dashboard/  net/http server, handlers, templates/, static/, web/
                                                    ← server.ts, dashboard.html
    testkit/    ClearGitEnv, TempRepo, BuildBins, Scenario, FakeClock
      fakeagent/  main: scenario-driven fake claude/pi    ← fixtures/fake-agent.ts
      fakegh/     main: recording fake gh                 ← in-process gh in e2e.test.ts
      demo/       main: seed demo jobs, serve the dashboard with fake deps
                                                    ← seed-demo.ts + serve-demo.ts
    e2e/        e2e_test.go                                         ← e2e.test.ts
```

`app` exists so that `cli` and `dashboard` call the same operations. Today
`server.ts` imports `commands/*`. In Go the cobra layer only parses flags and
prints. A package is split only where the job differs. The small TS modules
(`hooks`, `notify`, `ids`, `shell`, `roles`) join the package that uses them.

### 3. Cross-cutting patterns (the blueprint for this module)

`AGENTS.md` has no blueprint, and the repo has no Go code yet. The closest
convention is `stow/claude/.claude/skills/go-service-setup/SKILL.md`, so the
module follows it: stdlib first, `cmd/` plus `internal/`, a thin `main` with
one exit, table tests, and its lefthook shape. The package README records the
patterns below as the module's conventions, so later jobs follow one way.

- **Dependencies**: only `github.com/spf13/cobra` (settled) and
  `github.com/yuin/goldmark` (Markdown, section 9). Tests use only the
  stdlib: `testing` and `reflect.DeepEqual`, no testify.
- **Dependency injection**: `app.Deps` replaces `deps.ts`:
  ```go
  type Deps struct {
      Exec       proc.Runner   // every git, gh, hook, setup and notify call
      Spawner    proc.Spawner
      Git        *git.Git      // built on Exec
      GH         *git.GitHub   // built on Exec
      Roles      fs.FS         // factory.Roles; tests may swap it
      Self       string        // the factory binary: os.Executable() in prod, a built binary in tests
      CommandFor func(role string, f harness.Files) string // test override of the agent command line
      Notify     func(ctx context.Context, title, msg string)
      Now        func() time.Time
      Sleep      func(ctx context.Context, d time.Duration) error
      Log        func(line string)     // goroutine-safe (mutex-guarded writer)
      Heartbeat  time.Duration         // 0: none
  }
  ```
  `app.MakeDeps(repo string, inline bool) (Deps, error)` builds the real set.
- **External commands**: `proc.Runner.Run(ctx, argv, proc.Opts{Dir, Env, Stdin}) (proc.Result, error)`.
  The error means only "could not start". `Result` has `Code`, `Stdout`,
  `Stderr` and `Combined` (both streams in the order written).
  `proc.Check(argv, r) error` turns a non-zero exit into a `*proc.ExitError`.
- **Errors**: typed errors, matched with `errors.As` in one place each:

  | Error | CLI | HTTP |
  | --- | --- | --- |
  | `machine.CommandError` | exit 1 | 400 |
  | `job.LockError` | exit 1 | 409 |
  | `dashboard.httpError{Status}` | n/a | its status |
  | anything else | exit 1 | 500 |

  `cli.ErrReported` means "already printed, exit 1", like `ReportedError`
  today. Errors are wrapped with `%w` and context. `FACTORY_DEBUG` goes away:
  Go errors carry no stack, and the wrapped chain is the context.
- **Failure reasons (req 11, Risk 10)**: `proc.ExitError{Cmd, Code, Tail}`
  keeps the last 20 non-empty lines of `Combined`. `Error()` returns a
  summary line, a blank line, then the tail. The summary line is
  `<cmd> failed (exit N): <last non-empty line>`. One type covers git and gh
  (`GitError` goes away), hooks (`stages.ts` `hook`) and `new`'s setup
  commands (30 lines today, one constant of 20 now). The full text goes into
  `job.Reason`. One-line places use `ui.Headline(reason)`, the first line:
  - the status table and the activity log's transition line
  - the desktop notification
  - the PR headline `⏸ **Waiting for you: …**`
  - the dashboard card

  The full reason shows in:
  - `factory status <id>`
  - the dashboard failure ticket and drawer, in a `<pre>`
  - `driver.log`
  - the PR decision block, fenced

  The summary line names the last output line, which is where the real
  cause is (the case `feedback.md` describes).
- **Persistence**: JSON files written to `<file>.tmp` and renamed, as today,
  with `encoding/json`, `MarshalIndent` and a trailing newline.
- **Concurrency (gap, Risk 8)**: the driver's per-job state is a `run` struct:
  ```go
  type run struct {
      repo  string; paths job.Paths; cfg config.Config; deps app.Deps // read-only
      mu    sync.Mutex
      job   job.Job                       // guarded by mu
  }
  func (r *run) update(fn func(j *job.Job)) error // lock; fn; save; unlock
  func (r *run) snapshot() job.Job                // lock; Clone; unlock
  ```
  - `job.Job.Clone()` deep-copies `Trips` (each record's `Reviews` and
    `Validations` maps and its `Built` slice), `Decisions`, `Running` and
    `Discovery`.
  - `machine.Route` and `machine.Apply` take a `job.Job` by value, start with
    `j := in.Clone()`, and return `j`. They never touch the input's backing
    arrays or maps.
  - `runAgents` starts every agent from the calling goroutine, then waits on
    each in its own goroutine (`sync.WaitGroup.Go`). It collects results by
    index and returns when all are done. Failed waits are joined with
    `errors.Join`, which matches `Promise.allSettled`.
  - `onResult` and heartbeats touch state only through `update` and `Log`.
  - Every test runs with `-race`. `-race` needs cgo, and every host has
    `gcc` (`modules/shared/default.nix:36`; Xcode's on macOS).
- **Processes (Risk 9)**: `proc.ProcessSpawner` starts `bash <script>` with
  `SysProcAttr{Setsid: true}`, so each script gets its own session and
  process group, like `detached: true`. It writes `<name>.pid` and then runs
  `go cmd.Wait()`, which reaps the child as soon as it exits. `IsAlive` reads
  the pid file and calls `syscall.Kill(pid, 0)`; nil or `EPERM` means alive.
  `Kill` is `syscall.Kill(-pid, SIGTERM)`. Files that use these calls carry
  `//go:build unix`. `InlineSpawner` keeps today's contract.
- **Signals**: the driver (`run --here`) and the CLI keep Go's default
  SIGTERM and SIGINT behaviour, so they die at once, like the Bun driver. A
  graceful driver could save its old state after `feedback` saved the new
  cycle (`feedback.ts`: "The driver goes first"). The dead-pid check takes
  over the stale `driver.lock`, as today. Only `dashboard` uses
  `signal.NotifyContext`, for a graceful `http.Server` shutdown.
- **Output**: human lines go to injected `io.Writer`s through `ui.Paint`,
  which honours `NO_COLOR`, `FORCE_COLOR` and TTY detection. There is no
  `slog`: people read the CLI and `driver.log`, and the skill's slog JSON is
  for services.
- **Self-invocation (weak spot)**: run scripts pipe through
  `<Self> tail --format <h>`. The driver respawns with
  `<Self> run <id> --here --repo <repo>`. `Self` comes from `Deps`, so tests
  point it at a binary they built (section 10).
- **Tests that run git (Risk 17)**: every test package whose tests run git
  calls `testkit.ClearGitEnv()` first in its `TestMain`, and
  `testkit.TempRepo` refuses to start while any of those variables is set.
  Details in section 10 "Tests".

### 4. Job flow

`app.New` → `driver.GrillTurn` (the headless grill, with preflight inline) →
`driver.Run`. `Run` takes the lock, stops leftover agents, then steps until
the job waits. Each step runs the stage, routes the outcome, saves, writes
the activity line and runs `updatePR`. Then `Run` notifies.

Visit markers, reusable outputs, attempts named `<role>-<n>`, the heartbeat,
the 2 s done-file poll, tier timeouts and "window closed" detection all port
one to one from `driver.ts`. A cancelled `ctx` aborts a step without routing
or saving.

**Docs stay in the job folder (req 9)**

- `handoff.OutputPath` puts the five docs at `<jobDir>/docs/<kind>.md`:
  `requirements.md`, `tech-discovery.md`, `design.md`, `spec.md` and
  `test-plan.md`. The grill, every doc role and the planner's amendments
  write there.
- Deleted: `commitDoc`, `writeDoc`'s commit and push, the planner's
  `alsoCommit`, `docLinks`, the config keys `docs` and `docsCommitType`. The
  doc stages only spawn the role and check its output.
- The task prompt's `Docs:` line keeps its `kind=path` pairs, with absolute
  paths: `Docs: requirements=<jobDir>/docs/requirements.md, tech-discovery=…`.
  Agents already reach the job folder: claude through `--add-dir <jobDir>`;
  pi's tools take absolute paths with no folder limit (medium confidence, so
  the manual pi check in section 6 reads a doc too).
- No doc is ever in the worktree, so no builder's `git add -A` can commit
  one.
- `job.TakenIDs(repo)` takes the job folder names plus the reserved names
  `jobs` and `archive` (the worktree is `.factory/<id>`, next to those
  folders: weak spot "id/folder overlap"). `claim` still skips any id whose
  branch exists, here or on origin. That still guards against ids whose PR
  was merged, as long as the branch is kept.

**The PR body's `Docs:` line**

- `ui.RenderStatus(job, cfg, docs []string)` takes the repo-relative paths
  of the docs that exist, in doc order. It prints them as code spans, with
  no links:
  ``Docs: `.factory/jobs/<id>/docs/requirements.md` · `.factory/jobs/<id>/docs/design.md` ``
- `updatePR` builds that list from `job.Paths.Doc(kind)`, keeps the files
  that exist, and makes each path relative to the repo
  (`filepath.Rel(repo, p)`, then `filepath.ToSlash`). The escalation block
  already prints repo-relative paths (`driver.ts` `decision`, `relative(c.repo, file)`).
- `ui.InitialBody` reads: "_Work in progress by the factory. Commits land
  here as they are pushed._"

**Opening the draft PR (consequence of req 9, Risk 1)**

- Today `preflight` commits the requirements doc, pushes, then runs
  `ensurePr`. That commit is what puts the branch ahead of its base.
  `gh pr create` refuses a branch with no commits between head and base.
- `preflight` now only runs the access check. For a `report` job nothing
  changes: no branch push and no PR.
- `build` calls `ensurePR` after every push (one per task, plus the final
  one when every task was already built). `ensurePR`:
  1. When `job.PR` is empty and `git rev-list --count origin/<base>..HEAD`
     in the worktree is 0, it returns: there is nothing to open a PR for yet.
  2. Otherwise it finds or creates the draft PR as today. Then it runs
     `prOpened` (its marker makes a retry run it again until it passes) and
     `qaUrl`.
- When every task is done and `job.PR` is still empty, `build` fails with
  `build made no commits ahead of <base>: nothing to open a PR for`. Before,
  such a job went on and failed later in finalize ("no pull request to
  finalize").
- A failed `prOpened` fails `build` after the task was recorded as built. A
  retry skips the built tasks, pushes, and calls `ensurePR` again, which runs
  the hook again.
- Nothing before build reads the PR. Grill and design questions go through
  `factory answer`, `feedback` reads PR comments only when `job.PR` is set
  (as today), `updatePR` skips a job without a PR (as today), and `discard`
  already tolerates a missing remote branch (`git.ts` `deleteBranch`).
  `prOpened` still runs long before `qa-wait`. Before build, the job shows
  only in the CLI and the dashboard.

**The proof ref (req 9, 10)**

`driver.pushProof` keeps today's recipe and timing: it runs only in
`finalize`, adds only `--work-tree=<proofDir>` to a temp index, runs
`write-tree` and `commit-tree`, then
`git push --no-verify --force origin <sha>:refs/heads/factory-proof/<id>`
from the main checkout. `--no-verify` is the one change. `proofSection`
still links proof files, so `GitHub.NameWithOwner` stays.

**Harness per job (req 5)**

- `factory new --harness claude|pi` sets `job.Harness`. With no flag,
  `cfg.DefaultHarness` (`claude`) applies. The value is validated before
  anything is created.
- `harness.Resolve(role, job.Harness, cfg)` takes the harness only from the
  job. `role.Browser` no longer forces claude, and `roles.<name>.harness` is
  gone.
- Tier still maps to `cfg.Models[harness][tier]`. The timeout is
  `roles.<name>.timeoutMin`, else `timeoutsMin[tier]`.
- Branch naming (`app.nameBranch`) and the grill use the job's harness.

### 5. CLI (cobra)

`cli.Execute(ctx, args, stdout, stderr) int` builds the root command with:

- `SilenceUsage` and `SilenceErrors`.
- A persistent `--repo` flag, which refuses a linked worktree, as today.
- One file per command.

Positionals before and after `--` are joined into one string, as today; both
skills always pass `--`. `main.go` is
`os.Exit(cli.Execute(context.Background(), os.Args[1:], os.Stdout, os.Stderr))`.
Errors print `factory: <msg>` in red on stderr. Lines starting with `!` stay
warnings. Cobra's default `completion` command stays, since cobra gives it
for free. No other command is added.

### 6. Browser roles on both harnesses (req 6, Risk 7)

One Go value is the source of truth:

```go
var Playwright = MCPServer{Name: "playwright", Command: "npx",
    Args: []string{"-y", "@playwright/mcp@0.0.86", "--isolated", "--headless"}}
var PlaywrightTools = []string{"mcp__playwright__browser_navigate", … the 12 names of today}
```

At spawn time `harness.Command` writes the file it needs into the job's
`run/` folder (`0o600`), outside the worktree:

- **claude**: `run/playwright.mcp.json` (`{"mcpServers":{"playwright":{…}}}`),
  passed with `--mcp-config <file>`. Allowed and disallowed tools stay as
  today.
- **pi**: `run/playwright.pi.js`, a short pi extension
  (`export default function (pi) { pi.registerMcpServer("playwright", {command, args, exposure: "direct"}) }`),
  passed with `-e <file>`. The 12 tool names are added to `--tools`.
  `direct` exposure declares them to the model, and naming `mcp__…` entries
  in `--tools` keeps them (pi 1.5.2 `docs/cli.md` "MCP tools", `docs/mcp.md`
  "Control tool exposure"). pi loads plain JS extensions
  (`docs/extensions.md:131`), so no `.ts` file comes back into the package.
  The file is generated data, not source.

The worktree is never touched: no `.pi/mcp.json` and no `--approve`. A unit
test asserts both command lines. The real run is claude only, so the test
plan adds a manual pi check: a browser role on `--harness pi` drives a page,
and a doc role reads a doc from the job folder. Before that check:

- Warm the npx cache with `npx -y @playwright/mcp@0.0.86 --help`. pi waits
  only 10 s for `direct` servers before the first prompt (`docs/mcp.md:100`),
  and a cold `npx -y` download can take longer.
- Confirm `~/.pi/agent/mcp.json` has no `playwright` server. One there would
  override the registered one (`docs/mcp.md:264`). There is no such file
  today.

The package README states both under browser roles.

### 7. Config and state

- **`.factory.json`** stays JSON. `config.Load(repo)` ports `loadConfig`'s
  merge rule and adds strict decoding, in this order:
  1. `json.Marshal(config.Defaults())`, then `json.Unmarshal` into a
     `map[string]any`.
  2. Read `.factory.json` when it exists, into `any`. A value that is not
     an object fails with `<file>: expected a JSON object`, as today.
  3. `merge(defaults, repo)`, ported from `config.ts` `merge`: when both
     sides are objects it recurses key by key. Otherwise the repo value
     replaces the default, so arrays, scalars and `null` replace.
  4. `json.Marshal` the merged map, then decode it with
     `json.Decoder.DisallowUnknownFields` into a zero `Config`. Unknown keys
     fail here, with the file path in front.
  5. Validate `validators`, `defaultHarness` and the tiers, as today.

  Decoding the repo file straight into a defaults-filled struct is not
  enough: `encoding/json` replaces a map element instead of merging into
  it, so `"models": {"claude": {"low": "x"}}` would drop the default
  `medium` and `high` models (discovery review, finding 2). Merging the raw
  objects first keeps every nested default.
  - Removed keys: `docs`, `docsCommitType` and `roles.*.harness`.
  - This is plain validation, not migration: an old file with `docs` fails
    with `unknown field "docs"`, which Out of scope accepts.
- **`job.json` v3**: v2's fields plus `harness`, with `version: 3`.
  Nullable strings become empty strings (`omitempty`). `ready` stays
  tri-state (`*bool`) and `waitingSince` becomes `*time.Time`. `job.Load`
  rejects any version but 3, and `List` skips such files, as it skips v1
  today.
- **Job folder**: today's layout plus `docs/`, `run/playwright.mcp.json`
  and `run/playwright.pi.js`.

### 8. Repo hooks, notifications, ids

Ported as they are. Hooks run `bash -c <script>` in the worktree with
`JOB, PR, BRANCH, SHA` plus the process env; failures become `ExitError`s.
`qaReady` polls until exit 0 or the timeout. `proc.Notify` calls `osascript`
on darwin and `notify-send` on linux, then rings the terminal bell, and never
errors. `job.IDFor`, `CaseBranch`, `TicketOf` and `Slugify` keep their
regexes.

### 9. Dashboard (req 7, 8, 16, Risk 11)

It is server-rendered with `html/template`, htmx 2, and Tailwind 4 with
daisyUI 5. A small `app.js` (about 150 lines) does what htmx can't:

- toasts on stage changes
- browser notifications
- keyboard shortcuts
- keeping the selection across refreshes
- log auto-follow
- ⌘/Ctrl+Enter to send

The bar is feature parity with `dashboard.html`: nothing added, nothing
dropped.

- **Server**: `dashboard.Serve(ctx, repo, port, deps)` listens on
  `localhost:<port>` (default 8000; 0 picks a free port) and prints
  `http://localhost:<port>`. It runs an `http.Server` with
  `ReadHeaderTimeout` and a graceful `Shutdown` (the skill's pattern).
  `http.ServeMux` uses method and path patterns. The mux is built in its own
  function, for tests.
- **Guards**, kept from `server.ts:194-199,243` and adapted:
  - `Host` must be `localhost:<port>` or `127.0.0.1:<port>`.
  - On POST, `Origin`, when present, must be one of those.
  - POSTs need `X-Factory: 1`, which htmx sends through `hx-headers` on
    `<body>`.
  - Every response carries
    `Content-Security-Policy: default-src 'self'; img-src 'self' data:` and
    `Cache-Control: no-store`. With no inline script allowed, rendered
    Markdown can't run code.
  - The `htmx-config` meta tag sets `allowEval: false` and
    `includeIndicatorStyles: false`. htmx otherwise injects an inline
    `<style>` for `.htmx-indicator`, which the CSP blocks, so the loading
    indicator would never show. `web/app.css` styles `.htmx-indicator`
    (hidden) and `.htmx-request .htmx-indicator`,
    `.htmx-request.htmx-indicator` (shown) instead. This follows htmx's
    config docs; the builder confirms it in the demo (a slow tab shows the
    indicator, and the console shows no CSP error).
- **Markdown**: goldmark with the GFM extension. It drops raw HTML and
  dangerous URLs by default; `html.WithUnsafe` is never set. An AST
  transformer points relative links and images at the job's file endpoint,
  as `fileUrl` does today.
- **Files**: `/jobs/{id}/file` and `/jobs/{id}/doc` open paths through
  `os.OpenRoot(jobDir)`, which refuses `..` and symlinks that leave the
  folder: 403 outside, 404 when missing. Docs now live in the job folder,
  so the second root (`<worktree>/docs`) goes away.
- **Assets**:
  - `htmx.min.js` (2.x) and daisyUI's standalone `daisyui.mjs` are vendored
    in `internal/dashboard/web/` at pinned versions.
  - Tailwind's standalone CLI is pinned in `mise.toml`.
  - `mise run css` builds `static/app.css` from `web/app.css`
    (`@import "tailwindcss"; @plugin "./daisyui.mjs";`). The output is
    committed, so `go build` and `mise run install` need no Tailwind and
    work offline on all three hosts.
  - The JSON API `/api/*` goes away: only `dashboard.html` used it, and
    neither skill calls it.

### 10. Toolchain and tests

- **`mise.toml`** (module folder):
  ```toml
  [tools]
  go = "1.27.4"
  golangci-lint = "2.15.0"
  lefthook = "2.2.4"
  "github:tailwindlabs/tailwindcss" = "4.3.5"

  [tasks.install]
  description = "Build factory into $FACTORY_BIN_DIR (default ~/.local/bin)"
  env = { CGO_ENABLED = "0" }
  run = 'dir="${FACTORY_BIN_DIR:-$HOME/.local/bin}" && mkdir -p "$dir" && go build -trimpath -o "$dir/.factory.new" ./cmd/factory && mv -f "$dir/.factory.new" "$dir/factory"'

  [tasks.css]
  run = "tailwindcss -i internal/dashboard/web/app.css -o internal/dashboard/static/app.css --minify"

  [tasks.check]
  run = ["golangci-lint fmt --diff", "go vet ./...", "golangci-lint run ./...", "go test -race ./..."]

  [tasks.demo]
  run = "go run ./internal/testkit/demo"
  ```
  - `FACTORY_BIN_DIR` is the one knob of the install task. Unset, it is
    `$HOME/.local/bin` (req 12). Validators and builders set it to a temp
    folder and keep the real `HOME`:
    `d=$(mktemp -d) && FACTORY_BIN_DIR="$d" mise run install && "$d/factory" --help`.
    mise then finds its installed tools, and Go its module and build
    caches. A fresh `HOME` would not work: mise can't see its tools there
    (`HOME=$(mktemp -d) mise which go` fails) and would download them again
    (discovery review, finding 3).
  - Building to a temp name and then `mv -f` replaces the old stow symlink,
    whether it dangles or still points at the TS launcher. It also avoids
    Linux "text file busy" while a driver runs the old binary.
  - `CGO_ENABLED=0` gives a static binary, which runs on NixOS without the
    loader. `go test -race` in `check` still uses cgo, which is fine there.
  - Tasks run from the config root, the module folder.
- **`go.mod`**: `module github.com/marco-souza/nixos/stow/factory`,
  `go 1.27.4`. Path elements can't start with `.`, so the path can't mirror
  `.local/share`. Nobody fetches it.
- **`.golangci.yml`** (v2):
  - `linters.default: standard`, plus `bodyclose`, `errorlint`, `gocritic`,
    `gosec`, `misspell`, `noctx`, `nolintlint`, `revive`, `unconvert` and
    `usestdlibvars`.
  - gosec `G204` (subprocess with variable args) and `G304` (file path from
    a variable) are excluded, with a comment: running commands and reading
    job files by path is what the program does. The one place where
    confinement matters (the file endpoint) is tested directly.
  - `formatters.enable: [gofumpt, goimports]`, with
    `goimports.local-prefixes` set to the module path. "The formatter"
    (req 15) is `golangci-lint fmt --diff`.
- **`lefthook.yml`** at the repo root, because lefthook reads it only from
  the git toplevel (Risk 5):
  ```yaml
  pre-commit:
    jobs:
      - name: factory fmt
        root: stow/factory/.local/share/factory/
        glob: "*.go"
        run: golangci-lint fmt {staged_files}
        stage_fixed: true
      - name: factory lint
        root: stow/factory/.local/share/factory/
        glob: "*.go"
        run: golangci-lint run ./...
  pre-push:
    jobs:
      - name: factory test
        root: stow/factory/.local/share/factory/
        glob: "*.go"
        run: go test -race ./...
  ```
  - `root` and `glob` keep every other file out (req 13). A commit or push
    with no Go file under the module skips all three jobs.
  - fmt fixes only the staged files and re-stages them. lint covers the
    module, because golangci-lint type-checks whole packages; it runs only
    when a Go file is staged, and it never fixes, so no unstaged file
    changes behind the user's back.
  - A push from a linked worktree runs the hook with `GIT_DIR` set to that
    worktree's git folder. Every factory job pushes from its worktree. The
    tests clear that variable themselves (see "Tests" below), so the hook
    needs no `env -u` of its own.
  - The builder checks it with `lefthook validate`,
    `lefthook run pre-commit --all-files` and `lefthook run pre-push`.
    Nobody but Marco runs `lefthook install`.
- **Tests (req 14)**: stdlib `testing`, table tests, all with `-race`.
  - **Git's environment (Risk 17)**. Git exports `GIT_DIR` to hooks when
    the push comes from a linked worktree. With it set, a test's
    `git init` in a temp folder reinitializes the real repo, and its commits
    land on the job's branch (discovery review, finding 1). So:
    - `testkit.ClearGitEnv()` unsets every variable that points git at a
      repository: the list `git rev-parse --local-env-vars` prints, which is
      the list git itself clears when it enters a submodule.
      `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`,
      `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_OBJECT_DIRECTORY`,
      `GIT_DIR`, `GIT_WORK_TREE`, `GIT_IMPLICIT_WORK_TREE`,
      `GIT_GRAFT_FILE`, `GIT_INDEX_FILE`, `GIT_NO_REPLACE_OBJECTS`,
      `GIT_REPLACE_REF_BASE`, `GIT_PREFIX`, `GIT_SHALLOW_FILE` and
      `GIT_COMMON_DIR`. The list is a constant in `testkit`; it covers the
      seven the review names.
    - Every test package whose tests run git (`internal/e2e` and
      `internal/testkit`) has a `TestMain` that calls `ClearGitEnv()` before
      `m.Run()`. It runs before any test, so it can use `os.Unsetenv`
      (`testing` has `Setenv` but no `Unsetenv`, and `Setenv` panics in
      parallel tests). Every child the tests start (`factory`,
      `fake-agent`, `fakegh`, `git`) inherits the cleared environment.
    - `testkit.TempRepo(t)` fails the test at once when any of those
      variables is still set: "GIT_DIR is set: call testkit.ClearGitEnv in
      TestMain". A future package that forgets the `TestMain` then fails
      loudly instead of writing to the real repo.
    - `internal/testkit/testkit_test.go` proves it.
      `TestTempRepo` makes a `TempRepo`, commits and pushes to its bare
      origin. `TestGitEnvCleared` makes a sentinel repo with one commit and
      records its `HEAD`, `git for-each-ref` output and `.git/config`. Then
      it reruns the test binary (`os.Args[0] -test.run '^TestTempRepo$'`)
      with `GIT_DIR=<sentinel>/.git`, `GIT_WORK_TREE=<sentinel>` and
      `GIT_INDEX_FILE=<sentinel>/.git/index` added to its environment. It
      asserts the child passes and the sentinel's `HEAD`, refs and config
      are unchanged. That is the hook's situation, which a hand-run
      `lefthook run pre-push` never sets up.
  - `internal/machine/machine_test.go`: every case of `machine.test.ts`
    (about 45, many as tables), one to one, including both "never mutates
    its input" cases. Those compare against a `Clone()` taken before the
    call.
  - `internal/proc/spawn_test.go`: the two `spawn.test.ts` cases with real
    processes. A background agent is alive, and `Kill` takes its whole tree.
    A quick agent leaves its exit code, and `IsAlive` is false afterwards,
    which proves reaping. Plus `ExitError` keeping the last 20 lines.
  - `internal/config/config_test.go` (table): no file gives `Defaults()`; a
    partial `models.claude` (`{"low": "x"}`) keeps `medium` and `high`; a
    `models.pi` entry keeps every `models.claude` tier; a partial
    `timeoutsMin` and a single `hooks` key keep the rest; `validators`
    replaces the array; `"base": null` gives `""`; `docs`, `docsCommitType`
    and `roles.<name>.harness` fail as unknown fields; an unknown validator,
    a bad `defaultHarness` and a non-object file fail with today's messages.
  - `internal/e2e/e2e_test.go`: every case of `e2e.test.ts` (12 tests), with
    real git (`testkit.TempRepo`: a repo plus a bare `origin`) and the real
    embedded roles.
    - `TestMain` calls `testkit.ClearGitEnv()`, then runs `go build` once
      into a temp `bin/` for three binaries: `factory` (`Deps.Self`, for
      `tail`), `fake-agent` and `gh` (fakegh). `gh` goes first on `PATH`,
      next to `claude` and `pi` stubs that exit 99.
    - Agents run through `CommandFor` → `fake-agent`, with the scenario of
      verdicts per role and visit in a JSON file. Builders commit,
      validators write `proof/ac<k>-…`, the grill asks once and then writes
      the doc, `sleepMs` drives the heartbeat, and the output is claude
      `stream-json` lines.
    - `Now` and `Sleep` are a fake clock that advances on `Sleep`.
    - The temp repo gets a `pre-push` hook that rejects any push to
      `refs/heads/factory-proof/*`. A proof push without `--no-verify`
      would then fail the happy path (req 10).
    - Assertions that change:
      - the five docs exist in `<jobDir>/docs/`
      - origin's branch has no `docs/` file and no `docs: … for <id>`
        commit
      - `pr create` is recorded after the first builder's push, not in
        preflight
      - `factory-proof/<id>` on origin holds only proof files
      - the PR body's `Docs:` line holds repo-relative paths and no link
      - recorded gh calls come from `fakegh`'s log
  - `internal/dashboard/server_test.go` (httptest):
    - the Host, Origin and X-Factory guards
    - file and doc endpoint confinement, a symlink escape included
    - a doc with `<script>` and a `javascript:` link renders inert
    - approve and retry give 409 while a live driver holds the lock
    - the page's `htmx-config` meta carries `includeIndicatorStyles: false`
  - `internal/harness/command_test.go`: the claude and pi command lines,
    with and without browser.
  - `internal/ui`: `RenderStatus`'s `Docs:` line, and `Headline` on a
    multi-line reason.
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

  Any other call exits 1 and names the call. The e2e and the real run
  (req 17) both use this one fake.
- **Demo (req 16)**: `mise run demo`
  (`go run ./internal/testkit/demo [-dir <d>] [-port 8000]`) seeds a temp
  repo with jobs in every state, ported from `seed-demo.ts`, docs in their
  job folders included. It serves the dashboard with fake deps: actions
  apply `machine.Apply` and save, and nothing is spawned. The tmux leftovers
  in `serve-demo.ts` are not ported.

### 11. Docs and skills (req 18)

- `roles/_common.md:18`: "`Docs`: the job's documents, in the job folder:
  requirements, …" in place of "relative to the worktree". No other role
  changes.
- `stow/claude/.claude/skills/factory/SKILL.md` and
  `stow/pi/.pi/agent/skills/factory/SKILL.md`:
  - "If `factory` is not found" says to run `mise run install` in
    `stow/factory/.local/share/factory`.
  - The `/factory <feature>` row adds: `--harness pi` when the user asks
    for pi.
- `AGENTS.md`:
  - The layout row for `stow/factory/` reads "(Go)".
  - Setup: `stow/factory` uses mise's Go and is installed with
    `mise run install`. `mise run install` without `FACTORY_BIN_DIR` (it
    writes the real `~/.local/bin`) and `lefthook install` join `./stow.sh`
    in the list agents never run. To check the install, agents run it with
    `FACTORY_BIN_DIR` set to a temp folder.
  - The validation row for `stow/factory/` is `mise run check` in the
    module folder. Its known-failures line stays "none".
  - The demo commands become `mise run demo`, and the dashboard is on
    `localhost`.
  - `lefthook.yml` is named in the layout table.
- `README.md` lines 23, 51 and 53: Go instead of Bun, installed with
  `mise run install`.
- The package `README.md` is rewritten:
  - the commands, with `--harness`
  - the config keys, without `docs`, `docsCommitType` or `roles.*.harness`,
    and the merge rule: objects merge at every depth, arrays and scalars
    replace, unknown keys fail
  - the state: docs in `.factory/jobs/<id>/docs/`, never committed or
    pushed; the proof ref carries only proof files; the PR opens at the
    first build push
  - browser roles on both harnesses, with the two pi notes from section 6
  - roles are embedded, so an edit needs `mise run install`
  - install (`FACTORY_BIN_DIR`), checks, tests (`ClearGitEnv` in
    `TestMain` for any package whose tests run git) and the demo
  - the conventions in section 3
  - the switch-over, after merging, on each host:
    1. If `~/.local/bin` is a symlink into the stow package (stow folded
       it when factory was the first package with `.local/bin`), it
       dangles once the launcher is gone, and `mkdir -p` in the install
       task fails. Replace it with a real folder:
       `rm ~/.local/bin && mkdir ~/.local/bin`. On the Mac it is already a
       real folder.
    2. Run `mise run install` in the module folder.
    3. v2 jobs and old `.factory.json` files are not read.
- The PR body carries a "Before merging" note, which the spec and the
  summarizer take from here:
  - delete this job's own `docs/*/rewrite-factory-golang.md` files from the
    branch (Risk 15);
  - the switch-over steps above.

### 12. Build order (for the planner)

1. Merge `origin/main` (section 0).
2. Module skeleton and toolchain: `go.mod`, `mise.toml`, `.golangci.yml`,
   repo-root `lefthook.yml`, `cmd/factory`, `assets.go`.
3. Pure packages with their tests: `config`, `job`, `machine`, `handoff`,
   `harness`, `ui`, `tail`.
4. `proc` and `git`, with the spawn tests.
5. `driver`, `app`, `cli`.
6. `testkit` (`ClearGitEnv`, `TempRepo` and their test, fakeagent, fakegh)
   and the e2e. `ClearGitEnv` lands before the first test that runs git.
7. `dashboard`, the CSS build, and `demo`.
8. Remove the TS package and the launcher; update roles, skills,
   `AGENTS.md` and the READMEs.

### How each risk from the tech discovery is handled

1. **Draft PR without a doc commit.** The PR opens at the first build push
   that puts the branch ahead of its base; a build with no commit fails with
   a clear reason (section 4).
2. **Stale base and push rejection.** Task 1 merges `origin/main`, no
   rebase (section 0).
3. **Agents touching `$HOME` or `.git/hooks`.** The install task writes to
   `$FACTORY_BIN_DIR`, default `~/.local/bin`. Validators and builders run
   it with `FACTORY_BIN_DIR` set to a temp folder and the real `HOME`, so
   mise finds its tools and Go its caches, and the real `~/.local/bin` is
   untouched (section 10). Hooks are checked with `lefthook validate` and
   `lefthook run …`, never `lefthook install`. `AGENTS.md` forbids both
   commands against the real system (section 11).
4. **Stow links root files.** The module stays under `.local/share/factory/`
   (section 1).
5. **lefthook location and slow pushes.** Repo-root config scoped with
   `root` and `glob` (section 10). Pushes without Go changes skip the
   tests.
6. **Doc paths in a public PR body.** Repo-relative paths, so no home folder
   or user name is published (section 4).
7. **pi and Playwright.** A generated JS extension loaded with `-e`,
   `direct` exposure, the tools named in `--tools`; the command line is
   unit-tested, plus a manual pi check with a warm npx cache and no
   `playwright` entry in `~/.pi/agent/mcp.json` (section 6).
8. **Races and aliasing.** The `run.mu` mutex, `Clone()`, by-value machine
   functions, `-race` everywhere (section 3).
9. **Zombies and process groups.** `Setsid` plus a `Wait` goroutine, proven
   by the spawn tests (section 3).
10. **Multi-line reasons.** Summary line plus tail, with `ui.Headline` in
    one-line places (section 3).
11. **Dashboard security.** Host, Origin and X-Factory guards, CSP, goldmark
    safe by default, `os.OpenRoot` on the job folder; all tested. htmx's
    inline indicator style is turned off and moved to `app.css`, so the CSP
    stays strict (section 9).
12. **New dependencies and build steps.** Only cobra and goldmark as Go
    deps. htmx and daisyUI vendored, Tailwind pinned in mise, the CSS
    committed. `npx` stays a runtime need for Playwright, as today.
13. **Test-harness pitfalls.** `TestMain` clears git's environment and
    builds the binaries; `Deps.Self`, the fake clock and real reaping
    (section 10).
14. **Switch-over.** The package README and the PR body list the steps for
    each host after merging: replace a folded `~/.local/bin` symlink with a
    real folder, then `mise run install` (section 11). Until then
    `~/.local/bin/factory` dangles. TS jobs still running elsewhere break,
    which the Decisions accept.
15. **This PR carries this job's docs.** The TS factory driving this job
    commits `docs/*/rewrite-factory-golang.md` into the branch and reads them
    from the worktree until finalize. No task touches them. The PR body's
    "Before merging" note says to delete them, so they aren't merged by
    accident (section 11).
16. **Real run cost.** Guidance for the test plan: a tiny request, a scratch
    `.factory.json` with `validators: ["e2e"]`, `maxTrips: 1` and cheaper
    `models.claude` tiers, a local bare `origin`, and `fakegh` first on
    `PATH`, so `new`'s preflight (`gh auth status`,
    `git remote get-url origin`) passes. The binary comes from
    `FACTORY_BIN_DIR=<temp> mise run install`. A partial `models.claude`
    keeps the tiers it doesn't name, because the config is deep-merged
    (section 7).
17. **Hooks export `GIT_DIR` to the tests.** A push from a linked worktree
    runs the pre-push hook with `GIT_DIR` set, and the tests' git commands
    would then act on the real repo. `testkit.ClearGitEnv()` in each git
    test package's `TestMain` unsets git's repo-location variables,
    `TempRepo` refuses to run while any is set, and `TestGitEnvCleared`
    reruns a git test with `GIT_DIR` on a sentinel repo and asserts the
    sentinel is unchanged (section 10 "Tests").

### Data

`job.json` v3 (`internal/job/job.go`):

```go
type Job struct {
    Version     int          `json:"version"`               // 3
    ID          string       `json:"id"`
    Feature     string       `json:"feature"`
    Branch      string       `json:"branch"`
    Base        string       `json:"base"`
    Harness     Harness      `json:"harness"`               // NEW: "claude" | "pi", fixed at `new`
    Deliverable Deliverable  `json:"deliverable,omitempty"` // "", "pr", "report"
    Decisions   []string     `json:"decisions"`
    Worktree    string       `json:"worktree"`
    Slot        int          `json:"slot"`
    Stage       Stage        `json:"stage"`
    Cycle       int          `json:"cycle"`
    Trip        int          `json:"trip"`
    Planned     bool         `json:"planned"`
    DiscoveryLoops, ExtraDiscoveryLoops, ExtraTrips, EnvRetries int
    WaitingFor    WaitingFor `json:"waitingFor,omitempty"`
    WaitingSince  *time.Time `json:"waitingSince,omitempty"`
    Reason        string     `json:"reason,omitempty"`      // may be multi-line: summary + tail
    StoppedReason string     `json:"stoppedReason,omitempty"`
    ResumeStage   Stage      `json:"resumeStage,omitempty"`
    CapHit        CapHit     `json:"capHit,omitempty"`
    ReasonFile, QuestionsFile string                        // questionsFile may point at <jobDir>/docs/design.md
    FeedbackCount int
    Ready         *bool      `json:"ready"`
    PR, QAURL     string                                    // PR stays "" until the first build push
    Running       []string
    Trips         []TripRecord      // {Cycle, Trip, Reviews map, BuildJudge, Validations map, ValidationJudge, Built []string}
    Discovery     []DiscoveryRecord // {N, Verdict}
    CreatedAt, UpdatedAt time.Time
}
```

Stages, waiting kinds and cap kinds are string types with consts, with the
values of the TS unions.

`job.Paths` is today's `JobPaths` plus `DocsDir` (`<jobDir>/docs`) and
`Doc(kind) string` (`<jobDir>/docs/<kind>.md`).

`.factory.json` (`internal/config`):

```go
type Config struct {
    Base              string                      `json:"base"`
    PRTitle           string                      `json:"prTitle"`
    Setup             []string                    `json:"setup"`
    Hooks             Hooks                       `json:"hooks"`          // prOpened, qaUrl, qaReady
    Validators        []string                    `json:"validators"`     // e2e, user, load, capacity
    Roles             map[string]RoleOverride     `json:"roles"`          // {tier, timeoutMin}; no harness
    DefaultHarness    Harness                     `json:"defaultHarness"` // "claude"
    Models            map[Harness]map[Tier]string `json:"models"`         // claude: high opus, medium sonnet, low haiku; pi: none
    TimeoutsMin       map[Tier]int                `json:"timeoutsMin"`
    MaxTrips, MaxDiscoveryLoops, QAReadyTimeoutMin, QAPollSec int
}

func Defaults() Config
func Load(repo string) (Config, error) // defaults → map, deep-merge .factory.json, strict decode, validate
func merge(base, over any) any          // objects recurse; anything else from over replaces
```

The defaults are today's `config.json` minus `docs` and `docsCommitType`.
No migration and no detection: unknown keys in the merged document fail
decoding.

The proof ref tree is the proof files at the root, as today, and nothing
else.

### API

CLI (cobra). `--repo <path>` works on every command.

| Command | Change from the reference |
| --- | --- |
| `factory new [--base <b> \| --stack <PR#>] [--harness claude\|pi] [--] <feature>…` | `--harness` is new. Prints the first grill question |
| `factory answer <id> [--] [<text>…]` | none |
| `factory status [<id>] [--json]` | `--json` prints v3 jobs plus `hint` and `whatFor`. The detail view shows the full multi-line reason |
| `factory logs <id> [<role>] [-f]` | none |
| `factory approve <id>` | none |
| `factory feedback <id> [--] [<note>…]` | none |
| `factory unblock <id> [--] <decision>…` | none |
| `factory run <id> [--inline]` | the hidden `--here` stays |
| `factory discard <id> [--yes]` | none |
| `factory dashboard [--port <n>]` | serves on `localhost`, default 8000, 0 picks a free port |
| `factory tail --format claude\|pi` (hidden) | none |

Exit codes: 0 for OK, 1 for any error. Errors print as `factory: <msg>`.

`mise run install` reads `FACTORY_BIN_DIR` (default `$HOME/.local/bin`) and
writes `factory` there.

Dashboard HTTP: every response is HTML or a static file. POSTs need
`X-Factory: 1`.

| Route | Returns | Errors |
| --- | --- | --- |
| `GET /` | the full page: layout, board fragment, empty drawer, help dialog | — |
| `GET /board` | fragment: header counts, Needs you, columns, Done, discarded behind the toggle. Polled every 2 s | 500 → the sync dot goes offline |
| `GET /jobs/{id}?tab=timeline\|docs\|trips\|logs` | the drawer fragment | 404 job not found |
| `GET /jobs/{id}/doc?path=<rel>` | rendered Markdown of a file in the job folder | 403 outside the job folder, 404 missing |
| `GET /jobs/{id}/log?name=<role-n>&lines=<n>` | formatted log lines, ANSI stripped, at most 2000 | 404 |
| `GET /jobs/{id}/file?path=<rel>` | the raw file (proof images) | 403, 404 |
| `POST /jobs/{id}/approve\|retry\|feedback\|discard` | the refreshed board fragment (`HX-Retarget: #board`) | 400 `CommandError`, 409 driver running, 500; the body is the message, shown as a toast |
| `GET /static/{file}` | embedded `app.css`, `htmx.min.js`, `app.js` | 404 |

`feedback` takes the form field `note`. The handlers call `app.Approve`,
`app.Retry`, `app.Feedback` and `app.Discard`, the same functions the CLI
calls.

Internal API changes:

- `driver.ensurePR(ctx, r *run) error`: a no-op while the branch has no
  commit ahead of `origin/<base>`; otherwise find or create the draft PR,
  `prOpened`, `qaUrl`.
- `git.Git.Ahead(worktree, base string) (int, error)`:
  `git rev-list --count origin/<base>..HEAD`.
- `driver.pushProof(ctx, exec, repo, proofDir, id, indexFile) (sha string, err error)`:
  as today, with `--no-verify`.
- `ui.RenderStatus(job, cfg, docs []string) string`: `docs` are
  repo-relative paths, printed as code spans.
- `config.Load(repo string) (Config, error)`: deep merge, then strict
  decode (section 7).
- `testkit.ClearGitEnv()`: unsets git's repo-location variables; call it in
  `TestMain`. `testkit.TempRepo(t)` fails while any is set.

### UI

One screen with a new look: daisyUI components on a dark theme. What the
user sees:

- **Header**: the project name and counts of running, needs-you and done
  jobs.
  - A sync dot: green while `/board` polls succeed, red with
    "Reconnecting…" after a failed poll.
  - A "Notify me" button, shown only while the browser permission is
    undecided.
  - A `?` button that opens the shortcuts dialog.
- **Needs you**: one ticket per waiting job, oldest wait first, each with
  the job id, the feature, `whatFor` and the time waited. Actions by kind,
  as today:
  - grill: Discard. The hint says "answer in your chat: `factory answer <id>`".
  - review: Approve, a Feedback box, Open PR, Discard.
  - env: Retry, Approve, Read why (opens the reason file in the drawer),
    Discard.
  - escalation: the judge's first question inline. Approve, Feedback, Read
    why, Open PR, Discard.
  - failure: the headline of the reason, with a "details" toggle that shows
    the tail in a `<pre>`. Retry, Open logs, Discard.

  Open PR shows only when the job has a PR; before the first build push it
  has none. The Feedback box keeps its text across polls (`hx-preserve`)
  and sends on ⌘/Ctrl+Enter. Discard asks first (`hx-confirm`). An empty
  list reads "Nothing needs you".
- **Board**: columns Discovery, Building, Validation and Deploy (from
  `ui.Steps`), then Done. A card shows the id, the feature, the step label
  with its `(k/n)` counter, and the time since the last update. A "Show
  discarded" toggle shows discarded jobs. An empty board reads "No jobs yet.
  Start one with `factory new`."
- **Drawer**: opens on a card click or Enter; Esc closes it. The header
  shows the id, the feature, the stage, the PR link when there is one, and
  the same actions as the job's ticket. Tabs:
  - Timeline: the last 200 activity lines.
  - Docs: the five docs from `<jobDir>/docs/`, each marked present or "not
    yet". A click renders it. This is now the only place to read them
    outside the file system.
  - Trips: each trip folder's files. A click renders one.
  - Logs: a log picker, newest first. The view polls every 2 s and follows
    the end unless the user scrolled up.

  A loading tab shows an htmx indicator, styled in `app.css` (section 9).
  A job deleted under an open drawer shows "Job not found".
- **Feedback from actions**:
  - On success, the board refreshes.
  - On failure, a toast shows the server's message, for example "driver
    already running for x (pid 123)…".
  - A stage change seen between polls shows a toast: `<id>: <from> → <to>`.
  - A job that starts needing the user fires a browser `Notification` when
    permission is granted.
- **Keys**: `j`/`k` move the selection across tickets and cards, Enter
  opens the drawer, `a` approves the selected job, `f` focuses its feedback
  box, `?` opens help, Esc closes the drawer or dialog. Keys are ignored
  while typing in a field.
- **No-permission state**: none. The dashboard is local, with no auth.

## Alternatives

1. **Port the reference architecture into idiomatic Go packages (picked).**
   Same pure machine, file state, background driver and run scripts, with
   embedded data and a server-rendered htmx dashboard. Low risk: every
   behaviour has a TS reference and a test to port. The cost is the
   Go-specific weak spots (races, reaping, self-invocation, test isolation
   from git's environment), each handled in sections 3 and 10. Marco drives
   jobs as before, apart from `--harness`, the doc location and the later
   PR.
2. **One long-running factory daemon.** One process owns every job's driver
   goroutine and the dashboard; the CLI talks to it over a unix socket. It
   removes pid files, self-invocation and the lock. But it adds a service
   to install and supervise on three hosts (launchd and systemd), puts every
   job behind one process (a crash stops all of them), and changes the
   workflow, which the request didn't ask for. Not picked.
3. **In-process agents without run scripts.** The driver starts agents with
   `exec.Cmd` and formats their output in process. That removes the bash
   scripts and `factory tail`. But agents would no longer outlive the
   driver: a crash takes its agents with it, "a failed window stays open for
   inspection" and `stopLeftovers` change, and the `.sh` file Marco reruns
   by hand to debug an agent is gone. Not picked.

Sub-choices inside the picked approach:

- **When the draft PR opens**: at the first build push that puts the branch
  ahead of its base (picked), or at preflight after an empty commit. An
  empty commit sits in every PR's history and survives `git rebase` (a
  commit that starts empty is kept). The cost of the picked option is that
  the PR, and `prOpened`, come later; nothing before build needs either.
- **`Docs:` line paths**: repo-relative (picked) or absolute. Absolute paths
  publish `/Users/<name>/…` in every PR of a public repo, on every status
  update. Repo-relative paths say the same to Marco, and match how the
  escalation block already names files.
- **Data**: embedded (picked) or read at runtime from
  `~/.local/share/factory`. Runtime reads keep role edits live but tie the
  binary to stow and the main checkout again. The settled install flow
  already rebuilds after each merge.
- **CSS**: a committed Tailwind build (picked) or the Tailwind and daisyUI
  CDN. The CDN needs the network on every page load and is not meant for
  production use. The build adds one pinned tool and a `mise run css` step.
- **Markdown**: goldmark (picked) or a port of the 120-line JS renderer.
  goldmark is safe by default and runs on the server; a hand-written
  sanitiser is what Risk 11 warns about.
- **Test fakes**: binaries built in `TestMain` (picked) or re-exec of the
  test binary. Built binaries test the real `factory tail`, and they keep
  test hooks out of production code beyond `Deps.Self` and
  `Deps.CommandFor`. The one re-exec is `TestGitEnvCleared`, because what
  it tests is `TestMain` itself.
- **Config merge**: deep-merge raw JSON, then strict decode (picked); a
  hand-written per-field merge of `Models`; or decoding straight into the
  defaults-filled struct. Straight decoding drops nested map defaults. A
  per-field merge must be kept in step with every new nested map. The raw
  merge is a port of `config.ts` `merge`, works for any depth and keeps
  unknown-key rejection.
- **Git env isolation**: cleared in the tests' `TestMain` (picked), or
  `env -u GIT_DIR …` in the lefthook job. The hook fix covers only that one
  entry point; `go test` run from any other git hook, or by an agent whose
  shell inherited `GIT_DIR`, would still hit the real repo. Tests that make
  their own repos must not depend on how they were started.
- **Install target**: `FACTORY_BIN_DIR` (picked), a task argument through
  mise's `usage` spec, or a fresh `HOME`. A fresh `HOME` hides mise's tools
  and Go's caches. A `usage` argument works but adds a spec for one value;
  an environment variable is one line of shell.

## Decided without asking

- **Docs as repo-relative paths on the PR's `Docs:` line.** Req 9 says
  "job-folder paths" without picking a form. The repo is public, and
  absolute paths would publish the user name and folder layout (Risk 6).
  The escalation block already prints repo-relative paths
  (`driver.ts` `decision`).
- **Absolute doc paths in the task prompt.** Agents run in the worktree
  (`.factory/<id>`); a path relative to it would be `../jobs/<id>/…`.
  `_common.md` already says "use the paths exactly as given".
- **Flat doc names `<jobDir>/docs/<kind>.md`.** Only the factory reads them
  by name (tech discovery, open points), and the folder already scopes them
  to the job, so the per-kind folders and `<id>.md` add nothing.
- **The draft PR opens in build, and a build with no commit fails.**
  `gh pr create` needs a commit ahead of the base, and req 9 removes the
  requirements commit (`stages.ts` preflight, `ensurePr`). Nothing before
  build reads the PR. The discovery review confirms this is forced by req 9
  and within "breaking changes are fine".
- **`jobs` and `archive` are reserved ids.** The worktree path
  `.factory/<id>` would otherwise land on the jobs or archive folder (weak
  spot "id/folder overlap"). It is a one-line fix in `TakenIDs`, and the
  module touches that code anyway.
- **Module location `stow/factory/.local/share/factory/`.** Req 2 names
  `stow/factory`. Root files would be stowed into `$HOME` (`stow -n -v`
  shows `LINK: go.mod`, Risk 4). This folder needs no `.stow-local-ignore`
  and no `.nix` change.
- **Everything embedded.** `PACKAGE_DIR`/`CLI_PATH` coupling breaks for a
  copied binary (`paths.ts:4`). The settled flow ("Marco reruns
  `mise run install` after merging") already rebuilds on each change.
- **Merge `origin/main` as task 1.** Req 1 asks only that the branch contain
  `f7fb2cf`, and the TS build push is not forced.
- **This job's own `docs/*/rewrite-factory-golang.md` stay in the branch
  until Marco merges.** The TS factory driving this job reads them from the
  worktree until finalize and commits them again, so a task can't remove
  them. The PR body's "Before merging" note tells Marco to delete them.
- **Default signal handling in the driver.** It dies at once, as Bun does.
  A graceful driver could overwrite `feedback`'s new cycle.
- **Config stays JSON `.factory.json`, deep-merged, then strictly decoded.**
  It is the existing format and today's merge rule (`config.ts:41-44`).
  Strict decoding makes unknown keys errors: typo safety, not compatibility
  work.
- **`defaultHarness` keeps its name.** It is still exactly the default for
  new jobs (req 5).
- **Nullable fields become empty strings, except `ready` (`*bool`) and
  `waitingSince` (`*time.Time`).** Idiomatic Go; v3 needs no v2 reader.
- **The failure tail is the last 20 non-empty lines, in one constant.** It
  meets req 11 and replaces the two first-line spots (`git.ts:8`,
  `stages.ts` `hook`) and `new`'s 30-line setup tail.
- **`/api/*` JSON is dropped.** Only `dashboard.html` used it (the
  discovery review's grep agrees).
- **CSP, goldmark's safe defaults and `os.OpenRoot`.** Agent-written
  Markdown is untrusted (Risk 11). These replace `safeUrl`/`safeHref` and
  the hand-written symlink check.
- **htmx's indicator styles come from `app.css`.**
  `includeIndicatorStyles: false` keeps the CSP free of
  `'unsafe-inline'`, which would weaken it for every page.
- **pi gets Playwright through a generated `-e` JS extension with `direct`
  exposure.** It leaves the worktree alone. A `.pi/mcp.json` with
  `--approve` could be committed by a builder and would shadow a repo's own
  file.
- **Linters and formatter.** golangci-lint v2 `standard` plus a short list,
  and gofumpt with goimports through `golangci-lint fmt`. Nothing exists in
  the repo yet; gofumpt is a strict superset of the skill's gofmt.
- **Pre-commit lints the whole module, without `--fix`.** golangci-lint
  type-checks packages, so single files can't be linted alone. The job runs
  only when a Go file is staged, and not fixing keeps unstaged files
  untouched.
- **`-race` in tests and the pre-push hook.** Every host has `gcc`
  (`modules/shared/default.nix:36`), and races are the main Go-specific
  risk.
- **Tests clear git's repo-location variables in `TestMain`.** Git exports
  `GIT_DIR` to hooks pushed from a worktree, and every factory job pushes
  from one (discovery review, finding 1). The list is git's own
  `--local-env-vars`, so nothing git uses to find a repo is left.
- **Stdlib-only tests, two Go deps.** The `go-service-setup` skill says "no
  deps unless forced".
- **`lefthook.yml` at the repo root, scoped by `root` and `glob`.** lefthook
  reads only the git toplevel, and req 13 limits hooks to the factory's Go
  files.
- **Static binary (`CGO_ENABLED=0`), installed by build-then-`mv`.** Runs on
  NixOS without the loader, replaces the old stow symlink, and avoids "text
  file busy".
- **The install target is `FACTORY_BIN_DIR`, default `~/.local/bin`.** Req
  12 fixes the default. The variable lets checks run the real task without
  touching the real folder or `HOME`.
- **A folded `~/.local/bin` is fixed by hand, as a README step.** It is a
  one-time state from stow on hosts where factory created that folder. The
  install task doesn't detect it; `mkdir -p` fails on it, and the
  switch-over note says what to do.
- **Tailwind's CLI in `mise.toml` next to the three pinned tools.** Only
  `mise run css` uses it; the committed CSS means install never needs it.
- **Cobra's default `completion` command stays.** It costs no code.

## Questions for the human
None
