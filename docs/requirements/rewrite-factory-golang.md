# Rewrite the factory CLI in Go

> Request: rebuild the factory cli into golang, with best practices and using the latest go version (already installed)
>
> Install lefthook, formating and linting tools, use mise to manage dependencies

Deliverable: pr

## Intent

The factory CLI in `stow/factory` is Bun + TypeScript today. Marco wants it in
Go, using Go 1.27 (installed: `go version` shows `go1.27.4`), so it is "easier
to maintain and extend: stronger types, standard tooling, better structure".
It is a full replacement, and the CLI, config and state format may break
"if those changes will improve the project workflow and design".

Only Marco uses it, on his three hosts: `macos`, `laptop` and `homelab`.

He judges it works when the Go tests cover what today's e2e, state machine and
spawn tests cover (fake agents, real git), `go vet`, the formatter and
golangci-lint are clean, the demo dashboard works, and one real job run of the
Go binary in a scratch repo works end to end with real `claude` agents and a
fake `gh`, writing nothing to GitHub.

The reference behaviour is `main` at `f7fb2cf` ("enh: update factory"), which
is also `origin/main`. It has the `answer` and `unblock` commands, the headless
grill, and no `attach` and no tmux. This job's branch starts at `f0be919`, so it
must be rebased onto `f7fb2cf` before the build.

## Requirements

1. The PR's branch contains `main` at `f7fb2cf`, and its behaviour is ported
   from the factory at that commit, not from `f0be919`.
2. `stow/factory` holds a Go 1.27 module whose CLI is built with cobra.
3. The TypeScript sources, the Bun tests, `package.json`, `bun.lock` and
   `tsconfig.json` are removed from `stow/factory`, and no Bun launcher is
   left in `stow/factory/.local/bin/`.
4. Every capability of the reference stays: the commands `new`, `status`,
   `logs`, `approve`, `feedback`, `answer`, `unblock`, `run`, `discard` and
   `dashboard`; the headless grill; both harnesses (`claude` and `pi`); every
   role in `roles/`; `pr` and `report` deliverables; the repo hooks
   (`prOpened`, `qaUrl`, `qaReady`); desktop notifications on macOS and
   Linux; and the dashboard. Names, flags, the config format and the state
   format may change where that improves the workflow or design.
5. The harness is chosen once per job (for example `--harness claude|pi` when
   the job is created). Every role in that job runs on that harness, browser
   roles included. Per-role harness overrides no longer exist. With no harness
   given, the config default (`claude`) applies.
6. Browser roles get the isolated, headless Playwright MCP server on both
   harnesses (today `mcp/playwright.json`, `--isolated --headless`, claude
   only). A browser role run on `pi` can drive a browser.
7. The dashboard is rebuilt with Go templates, htmx, Tailwind and daisyUI. It
   has the same features as today's `dashboard.html` and nothing more or
   less: the board by step, the "Needs you" list, the job drawer with
   Timeline, Docs, Trips and Logs tabs, the job actions (approve, feedback,
   run, discard, and the others the reference offers), browser notifications,
   keyboard shortcuts and live refresh. The look is new.
8. The dashboard is served on `localhost`, with no auth.
9. A job's docs (requirements, tech discovery, design, spec, test plan) stay
   in `.factory/jobs/<id>/docs/` and never leave the machine. They are never
   committed to the job's branch and never pushed to the remote, the
   `factory-proof/<id>` ref included; that ref carries only proof files. The
   PR body's `Docs:` line lists the job-folder paths of the docs as plain
   text, not links.
10. The proof ref is pushed with `--no-verify`, so the repo's pre-push hook
    does not run on it.
11. When a command the factory runs fails, the reason shown includes the last
    lines of its output, not only the first stderr line.
12. A `mise.toml` in the factory package pins Go, golangci-lint and lefthook.
    `mise run install` builds `factory` into `~/.local/bin/factory`, on macOS
    and on NixOS.
13. lefthook pre-commit formats and lints the staged Go files in the factory
    package, and pre-push runs the Go tests. No other files are checked by
    the hooks.
14. Go tests cover what today's `e2e.test.ts`, `machine.test.ts` and
    `spawn.test.ts` cover, with fake `claude`, `pi` and `gh` and real git. All
    pass.
15. `go vet`, the formatter and golangci-lint report nothing on the Go code.
16. A demo dashboard (seeded demo jobs, fake dependencies, like today's
    `seed-demo.ts` and `serve-demo.ts`) starts and works in a browser.
17. One real run works end to end: a tiny request through the Go binary in a
    scratch local git repo with a local bare remote, real `claude` agents, and
    a fake `gh` that records the PR instead of opening it. Nothing is written
    to GitHub.
18. The roles, the Claude and pi `factory` skills, the repo's `AGENTS.md` and
    `README.md` change only where the new CLI, config, state or toolchain
    needs it (for example, `AGENTS.md` no longer says to run `bun test` for
    `stow/factory`).

## Out of scope

- chrome-relay for browser roles. It is a later PR.
- Removing `task-pipeline` and the pi skills and workflows built on it. It is
  a later PR. This PR does not touch it.
- Any compatibility work: old jobs (`job.json` version 2) and existing
  `.factory.json` files are not migrated, detected or given a helpful error.
  They may break; Marco fixes them by hand, mycelium included.
- Deleting the untracked `feedback.md` in the main checkout. Marco does it
  after the merge.
- New dashboard features, and dashboard auth.
- A Nix package for the factory; it is installed with mise.
- Hooks for non-Go files (`nix fmt`, `zsh -n`, markdown).
- Support for anyone but Marco.

## Decisions

- Main reason for Go: easier to maintain and extend: stronger types, standard
  tooling, better structure (grill)
- Replace or add next to TS: full replacement, and also change the CLI, config
  or state format where a cleaner design calls for it; breaking changes are
  fine "if those change will improve the project workflow and desgin" (grill)
- Old jobs: first answered "migrate on first read", then replaced by: "Cut
  the scope - do not migrate out jobs and factories, just add the changes you
  need and accept that they might broke - not a problem for now" (grill)
- Old `.factory.json` files and their hooks: first answered "breaking change
  with a clear error per key", then replaced by the same "no migration, may
  break" answer; no detection or error is required (grill)
- What else is covered: the Go CLI, driver and dashboard server, and the
  dashboard UI is also rebuilt (for example as Go templates); "You can use
  htmx, tailwind and daisy for the UI" (grill)
- Dashboard scope: same features as today, new stack and look; nothing added
  or dropped (grill)
- Dashboard address: `localhost` instead of `127.0.0.1`; local only, no auth
  (grill)
- Build and install: a mise task in the factory package (`mise run install`)
  builds it into `~/.local/bin/factory`; Marco reruns it after merging; Go,
  linters and lefthook are pinned in that package's `mise.toml` (grill)
- lefthook: Go only; pre-commit formats and lints the staged Go files in the
  factory package; pre-push runs the Go tests; other files are not checked
  (grill)
- CLI library: "use cobra for the CLI dev ex" (grill)
- Capabilities: nothing is dropped as "unused"; "Do not Drop pi!" (grill)
- Harness: chosen per job, `--harness <claude|pi>`; "All the upcoming calls
  will use the selected harness"; every role, browser roles included, runs on
  it; per-role overrides go; no flag means the config default (claude)
  (grill)
- Browser for pi: "pi gets a browser". Both harnesses get the isolated,
  headless Playwright MCP server. chrome-relay was first chosen (chrome-relay
  first, Playwright as fallback), then: "Chrome relay it's a follow up PR, out
  of the rewrite scope for now - let's simplify" (grill)
- `feedback.md` problems: "Fix them, but delete the feedback.md file once
  they are fixed". Job docs stay in the job folder and are linked from the PR
  body; the proof ref is pushed with `--no-verify`; a failure shows the last
  lines of output. The file is untracked in the main checkout, so Marco
  deletes it after merge. How the PR body refers to the docs was later
  settled by the design question below (grill)
- Reference code: "main" means the local main checkout as it runs today,
  commit `f7fb2cf` (answer, unblock, headless grill, no attach); main was
  pushed, so `origin/main` is `f7fb2cf` too and PR #3 is merged. Ignore the
  `enh/factory-headless-grill` branch (grill)
- No direct commits to `main`: "Create a PR, do not commit directly to main -
  there are other processes using main implementation (TS)" (grill)
- task-pipeline: outdated; its removal with the related skills and workflows
  is a follow-up PR (grill)
- Audience and hosts: only Marco, on `macos`, `laptop` and `homelab` (grill)
- Success: Go tests cover what today's e2e and state machine tests cover (fake
  agents, real git), `go vet`, the formatter and linter pass clean, and a demo
  dashboard plus one real job run with the Go binary work end to end (grill)
- Real run: in a scratch local git repo with a local bare remote, real
  `claude` agents, a fake `gh` that records the PR; nothing written to GitHub
  (grill)
- Access: local only; `claude` signed in, `git`, mise with Go 1.27,
  golangci-lint and lefthook; the real run uses the claude harness only; no
  `gh`, `pi` or MCP connectors; no tmux, since the reference dropped it
  (grill)
- Playback: confirmed (grill)
- Where the PR body's links to the job docs point, now that the docs stay in
  `.factory/jobs/<id>/docs/`: "Local only: the docs never leave your
  machine. The PR's `Docs:` line lists the job-folder paths as plain text.
  Reviewers can't open them, and you read them in the dashboard." The docs
  are not committed to the branch and not pushed to `factory-proof/<id>`,
  which keeps carrying only proof files (design questions)
- Playback of that change: confirmed (design questions)

## Access

- `claude` CLI signed in as Marco: `claude auth status` shows
  `"loggedIn": true`.
- `git`: `git --version` succeeds, and `git log -1 origin/main` shows
  `f7fb2cf`.
- mise: `mise --version` succeeds.
- Go 1.27: `go version` shows `go1.27` (today `go1.27.4 darwin/arm64`).
- golangci-lint: `golangci-lint --version` succeeds.
- lefthook: `lefthook version` succeeds.

## Open assumptions

None.
