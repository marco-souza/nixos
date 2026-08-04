# NixOS Configuration

Personal NixOS setup with declarative system configuration and GNU Stow-managed dotfiles.

## Structure

```bash
nixos/
├── hosts/
│   └── laptop/
│       ├── configuration.nix        # System packages, services, and user config
│       └── hardware-configuration.nix
├── stow/                            # Dotfiles managed by GNU Stow
│   ├── ghostty/.config/ghostty/     # Terminal emulator config
│   ├── mise/mise.toml               # Tool version manager
│   ├── pi/.pi/                      # Pi coding agent config + skills
│   ├── tmux/.tmux.conf              # Terminal multiplexer
│   └── zsh/                         # Shell config, aliases, utilities
├── Makefile                         # Apply NixOS configuration
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

### Apply NixOS Configuration

```bash
make apply
```

This copies `configuration.nix` and `hardware-configuration.nix` to `/etc/nixos/` and rebuilds.

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
