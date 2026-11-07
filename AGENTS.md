# AGENTS.md

Marco's NixOS / nix-darwin machines as one Nix flake, plus dotfiles linked into
`$HOME` with GNU Stow. `README.md` has the overview, the usage notes and how to
add a machine. Read it first.

## Layout

| Path                         | What it is                                                      |
| ---------------------------- | --------------------------------------------------------------- |
| `flake.nix`                  | One output per machine: `laptop`, `homelab` (NixOS), `macos` (nix-darwin) |
| `modules/shared/default.nix` | Settings for every host. Only options that exist on NixOS **and** darwin |
| `modules/nixos/common.nix`   | Base for every NixOS host: user, shell, services                |
| `modules/nixos/desktop.nix`  | COSMIC desktop, audio, bluetooth, GUI apps                      |
| `hosts/<name>/`              | `default.nix` + `hardware-configuration.nix` for each machine   |
| `pkgs/`                      | Local derivations for software that isn't in nixpkgs (e.g. `orca-ide.nix`) |
| `stow/<package>/`            | Dotfiles. Each package mirrors `$HOME` (`stow/zsh/.zshrc` → `~/.zshrc`) |
| `stow.sh`                    | Wrapper around `stow` (`./stow.sh restow zsh`)                  |
| `Makefile`                   | `switch`, `build`, `diff`, `update`, `check`, `mac`, `hardware` |

Agent configs live in stow packages too:

- `stow/claude/.claude/`: Claude Code settings, `agents/`, `skills/`, and the
  `marco-plugins` marketplace.
- `stow/pi/.pi/agent/`: pi agent settings, `agents/`, `skills/`, and
  `scripts/task-pipeline` (a Bun + TypeScript CLI).

The factory skill has two copies that must stay in sync:
`stow/claude/.claude/skills/factory/` + `stow/claude/.claude/agents/factory-*.md`
and `stow/pi/.pi/agent/skills/factory/` + `stow/pi/.pi/agent/agents/factory-*.md`.
The pi copy only differs in how it spawns agents (`subagent` tool, no resume)
and in its skill description. Change one copy, change the other the same way.

## Setup for a fresh checkout or worktree

Nothing to install. Nix fetches everything it needs on evaluation. Only if you
touch `stow/pi/.pi/agent/scripts/task-pipeline/` run `bun install` in that folder.

The symlinks in `$HOME` (`~/.claude/skills/factory`, `~/.claude/agents`,
`~/.pi/agent/...`) point at the **main checkout**, so edits in a worktree aren't
live until they're merged. Never run `./stow.sh`, `make switch`, `make boot`,
`make mac`, `make update` or `make hardware` from an agent: they change the
running system, `$HOME` or `flake.lock`.

## Validation

Flakes only see files git tracks: `git add` new files before evaluating.

Run what applies to the files you changed, from the checkout or worktree root:

| Changed                       | Command                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| any `.nix`                    | `nix eval --raw .#nixosConfigurations.laptop.config.system.build.toplevel.drvPath` |
| `modules/shared`, `hosts/macos` | `nix eval --raw .#darwinConfigurations.macos.system.drvPath`          |
| any `.nix`                    | `nix fmt -- --check <files>` (nixpkgs-fmt; drop `--check` to fix)       |
| `stow.sh`                     | `bash -n stow.sh`                                                        |
| `stow/zsh/*`                  | `zsh -n <file>` (zsh syntax, so `bash -n` fails on it)                  |
| `task-pipeline/`              | `bun test` in that folder                                                |
| skills, agents, markdown      | No tooling. Reread the file and check its links, paths and names         |

Add `--extra-experimental-features 'nix-command flakes'` to `nix` if flakes
aren't enabled. Each eval takes about 30 s.

Known failures on `main`, not caused by your change:

- `make check` (`nix flake check`) fails, because
  `hosts/homelab/hardware-configuration.nix` is a placeholder that throws until
  it is replaced on that machine. Use the per-host evals above.
- `bun test` in `task-pipeline/` has 8 failing tests (119 pass). Don't add to
  that count.

There is no dev server and no web UI. The one HTML page,
`skills/factory/dashboard.html`, is a static file that you open with
`python3 -m http.server` from a repo's `factory/` folder. Only open it in a
browser if your change touches it.

## Conventions

- Commits: `<type>: <lowercase summary>`, with `fea` for features, `enh` for
  improvements and `fix` for fixes. Example: `fea: add pi factory`.
- Nix: two-space indent, nixpkgs-fmt style, short `#` comments that say why an
  option is set.
- Never commit secrets. The stow `.gitignore` files keep out credentials,
  sessions and caches (`.claude/.credentials.json`, `.pi/agent/auth.json`, …).
  Keep it that way for any new package.
- New stow package: add it to the table in `README.md`.
- Skill and agent markdown: plain, direct prose. Don't put anything
  repo-specific in the factory files. It belongs in each repo's `AGENTS.md`.
