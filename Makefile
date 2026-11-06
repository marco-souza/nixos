# Thin wrapper around nixos-rebuild / darwin-rebuild.
# Each machine's hostname equals its flake attribute, so `--flake .`
# picks the right config automatically.

NIX := nix --extra-experimental-features 'nix-command flakes'

.PHONY: switch boot build diff mac update check hardware

switch: ## Apply this machine's config now
	sudo nixos-rebuild switch --flake .

boot: ## Apply on next boot
	sudo nixos-rebuild boot --flake .

build: ## Build without applying (result -> ./result)
	nixos-rebuild build --flake .

diff: build ## Show what would change vs the running system
	$(NIX) store diff-closures /run/current-system ./result

mac: ## macOS (nix-darwin)
	sudo darwin-rebuild switch --flake .

update: ## Bump all flake inputs (commit flake.lock afterwards)
	$(NIX) flake update

check: ## Evaluate all configurations
	$(NIX) flake check --no-build

hardware: ## Copy this machine's generated hardware config into hosts/<hostname>
	cp /etc/nixos/hardware-configuration.nix hosts/$$(hostname)/
	git add hosts/$$(hostname)/hardware-configuration.nix
