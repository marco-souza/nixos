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
| `stow/factory/`              | The factory CLI (Bun + TypeScript), its roles and dashboard      |
| `stow/<package>/`            | Dotfiles. Each package mirrors `$HOME` (`stow/zsh/.zshrc` → `~/.zshrc`) |
| `stow.sh`                    | Wrapper around `stow` (`./stow.sh restow zsh`)                  |
| `Makefile`                   | `switch`, `build`, `diff`, `update`, `check`, `mac`, `hardware` |

Agent configs live in stow packages too:

- `stow/claude/.claude/`: Claude Code settings, `agents/`, `skills/`, and the
  `marco-plugins` marketplace.
- `stow/pi/.pi/agent/`: pi agent settings, `agents/`, `skills/`, and
  `scripts/task-pipeline` (a Bun + TypeScript CLI).

The factory lives in `stow/factory/`; the Claude and pi `factory` skills only wrap its CLI.

## Setup for a fresh checkout or worktree

Nothing to install. Nix fetches everything it needs on evaluation. Only if you
touch `stow/pi/.pi/agent/scripts/task-pipeline/` run `bun install` in that folder.
`stow/factory` needs no install to run tests (`bun install` only for editor types).

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
| `stow/factory/`               | `bun test` in `stow/factory/.local/share/factory`                       |
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
- None for `stow/factory`: all its tests pass.

There is no dev server. The one web UI is the factory dashboard,
`stow/factory/.local/share/factory/dashboard.html`, served on 127.0.0.1 by
`factory dashboard`. For UI checks during development run
`bun src/__tests__/fixtures/seed-demo.ts <dir>` and then
`bun src/__tests__/fixtures/serve-demo.ts` (fake deps) from the package folder.
Only open it in a browser if your change touches it.

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
