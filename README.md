# NixOS Configuration

Personal NixOS / nix-darwin setup, defined as a Nix flake, with GNU Stow-managed dotfiles.

## Structure

```bash
nixos/
├── flake.nix                        # Entry point: one output per machine
├── flake.lock                       # Pinned nixpkgs / nix-darwin revisions
├── modules/
│   ├── shared/default.nix           # Shared by all hosts (CLI tools, fonts, nix settings)
│   └── nixos/
│       ├── common.nix               # Base for every NixOS host (user, shell, services)
│       └── desktop.nix              # COSMIC, audio, bluetooth, GUI apps
├── hosts/
│   ├── laptop/                      # default.nix + hardware-configuration.nix
│   ├── homelab/                     # default.nix + hardware-configuration.nix
│   └── macos/default.nix            # nix-darwin config (macOS)
├── stow/                            # Dotfiles managed by GNU Stow
│   ├── ghostty/.config/ghostty/     # Terminal emulator config
│   ├── mise/mise.toml               # Tool version manager
│   ├── pi/.pi/                      # Pi coding agent config + skills
│   ├── tmux/.tmux.conf              # Terminal multiplexer
│   └── zsh/                         # Shell config, aliases, utilities
├── Makefile                         # Shortcuts for rebuild / update / check
└── stow.sh                          # Dotfile management script
```

## Host Configuration (Laptop)

- **Desktop**: COSMIC (Wayland)
- **Shell**: Zsh + Oh My Zsh (theme: `ys`, plugins: `git`, `tmux`, `docker`)
- **Editor**: Neovim (LazyVim + custom config)
- **Terminal**: Ghostty (Rose Pine theme, 70% opacity)
- **Browser**: Brave
- **Containerization**: Docker
- **Networking**: NetworkManager + Tailscale
- **Security**: 1Password, GnuPG
- **Audio**: PipeWire

## Stow Packages

| Package  | Description                           |
| -------- | ------------------------------------- |
| `ghostty` | Ghostty terminal config (theme, opacity) |
| `mise`    | Tool versions: pi, opencode, bun, deno, odin |
| `pi`      | Pi coding agent + skills + task pipeline |
| `tmux`    | Tmux config (vi mode, auto-rename, extended keys) |
| `zsh`     | Shell rc, aliases (git, docker, mise, tmux), utilities |

## Usage

Each NixOS machine's hostname equals its flake attribute (`laptop`, `homelab`),
so `nixos-rebuild` picks the right config automatically.

```bash
make switch          # sudo nixos-rebuild switch --flake .
make diff            # build and show what would change vs the running system
make update          # bump flake.lock (commit it afterwards)
make check           # evaluate every configuration
make mac             # macOS: darwin-rebuild switch --flake .
```

Flakes only see files tracked by git — `git add` new files before building.

### Adding a new machine

1. Install NixOS with hostname `<name>`, clone this repo to `~/w/marco-souza/nixos`.
2. Create `hosts/<name>/default.nix` (see `hosts/homelab`) and add
   `<name> = mkNixos "<name>";` to `flake.nix`.
3. `make hardware` to copy the generated `hardware-configuration.nix`.
4. `make switch`.

If the current hostname doesn't match yet, the first switch needs the name once:
`sudo nixos-rebuild switch --flake .#<name>`.

### macOS (nix-darwin)

Prerequisites: [Nix](https://nixos.org/download), [nix-darwin](https://github.com/nix-darwin/nix-darwin),
and [Homebrew](https://brew.sh). Assumes Apple Silicon (`aarch64-darwin`, set in `flake.nix`).
GUI apps are Homebrew casks; CLI tooling and Nerd Fonts come from nixpkgs.

### Manage Dotfiles with Stow

```bash
# List available packages
./stow.sh

# Stow all packages
./stow.sh stow

# Stow specific packages
./stow.sh stow zsh tmux ghostty

# Restow (update symlinks)
./stow.sh restow

# Remove symlinks
./stow.sh delete

# Adopt existing configs into stow
./stow.sh adopt
```

## Aliases

The zsh config provides aliases for common tools:

| Category | Examples                              |
| -------- | ------------------------------------- |
| Git      | `g`, `ga`, `gb`, `gc`, `gd`, `gl`, `gp`, `gst`, `gco` |
| Docker   | `dk`, `dc`, `dm`, `ds`, `dkps`       |
| Tmux     | `t`, `tt`, `ta`, `tl`, `tnw`, `tns`  |
| Mise     | `m`, `mr`, `mi`, `mu`                |
| Bun      | `b`, `bi`, `brun`, `bu`              |

## Utilities

The `.utils.sh` file provides helper functions:

- `mcd dir` — mkdir + cd
- `ak process` — kill a process by name
- `workon dir` — cd to directory, init git if needed, trust mise, open tmux window
- `mug branch` — merge upstream changes
- `rug branch` — rebase upstream changes
