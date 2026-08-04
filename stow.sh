#!/bin/bash
# stow.sh — Manage dotfiles with GNU Stow
#
# Usage:
#   ./stow.sh                        # List available packages
#   ./stow.sh stow [packages...]     # Stow packages (default: all)
#   ./stow.sh restow [packages...]   # Restow packages (default: all)
#   ./stow.sh delete [packages...]   # Un-stow packages (default: all)
#   ./stow.sh adopt [packages...]    # Adopt existing configs into stow
#
# Examples:
#   ./stow.sh stow zsh tmux          # Stow only zsh and tmux
#   ./stow.sh restow                 # Restow all packages
#   ./stow.sh delete ghostty         # Remove ghostty symlinks
#   ./stow.sh adopt                  # Pull current home configs into stow

set -euo pipefail

# --- Config ----------------------------------------------------------------

STOW_DIR="$(cd "$(dirname "$0")" && pwd)/stow"
TARGET="$HOME"

# --- Helpers ---------------------------------------------------------------

usage() {
  sed -n '2,13p' "$0"
  echo ""
  echo "Available packages:"
  for pkg in "$STOW_DIR"/*/; do
    pkg_name="$(basename "$pkg")"
    echo "  - $pkg_name"
  done
  exit 0
}

die() {
  echo "[stow] Error: $*" >&2
  exit 1
}

# Ensure GNU Stow is installed
ensure_stow() {
  if ! command -v stow &>/dev/null; then
    echo "[stow] GNU Stow is not installed. Install it first:"
    echo "  macOS: brew install stow"
    echo "  Linux: sudo pacman -S stow   (or apt install stow)"
    exit 1
  fi
}

# Get list of all available packages (directories in stow/)
all_packages() {
  local pkgs=()
  for pkg in "$STOW_DIR"/*/; do
    [ -d "$pkg" ] && pkgs+=("$(basename "$pkg")")
  done
  echo "${pkgs[@]}"
}

# Resolve package list: if arguments given use them, otherwise use all
resolve_packages() {
  if [ $# -gt 0 ]; then
    echo "$@"
  else
    all_packages
  fi
}

# --- Actions ---------------------------------------------------------------

action_stow() {
  local pkgs
  pkgs="$(resolve_packages "$@")"
  for pkg in $pkgs; do
    echo "  * stowing $pkg"
    stow --target "$TARGET" --dir "$STOW_DIR" "$pkg" 2>/dev/null &&
      echo "    ✓ $pkg stowed" ||
      echo "    ! $pkg already stowed or has conflicts (try: restow)"
  done
}

action_restow() {
  local pkgs
  pkgs="$(resolve_packages "$@")"
  for pkg in $pkgs; do
    echo "  * restowing $pkg"
    stow --target "$TARGET" --dir "$STOW_DIR" --restow "$pkg"
    echo "    ✓ $pkg restowed"
  done
}

action_delete() {
  local pkgs
  pkgs="$(resolve_packages "$@")"
  for pkg in $pkgs; do
    echo "  * unstowing $pkg"
    stow --target "$TARGET" --dir "$STOW_DIR" --delete "$pkg"
    echo "    ✓ $pkg unstowed"
  done
}

action_adopt() {
  local pkgs
  pkgs="$(resolve_packages "$@")"
  for pkg in $pkgs; do
    echo "  * adopting $pkg (overwriting stow files with current \$HOME config)"
    stow --target "$TARGET" --dir "$STOW_DIR" --adopt "$pkg"
    echo "    ✓ $pkg adopted"
  done
}

# --- Main ------------------------------------------------------------------

main() {
  ensure_stow

  # Change to repo root so relative paths inside stow packages resolve
  cd "$(dirname "$0")"

  local cmd="${1:-help}"
  shift 2>/dev/null || true

  case "$cmd" in
  stow) action_stow "$@" ;;
  restow) action_restow "$@" ;;
  delete) action_delete "$@" ;;
  adopt) action_adopt "$@" ;;
  help | --help | -h) usage ;;
  *)
    if [ -d "$STOW_DIR/$cmd" ]; then
      # Bare package name given -> stow just that one
      action_stow "$cmd" "$@"
    else
      echo "[stow] Unknown command: $cmd"
      echo ""
      usage
    fi
    ;;
  esac
}

main "$@"
