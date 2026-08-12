laptop:
	sudo cp hosts/laptop/configuration.nix /etc/nixos/configuration.nix
	sudo nixos-rebuild switch

homelab:
	sudo cp hosts/homelab/configuration.nix /etc/nixos/configuration.nix
	sudo nixos-rebuild switch

# macOS (nix-darwin). Requires nix + nix-darwin + Homebrew installed.
# See: https://github.com/LnL7/nix-darwin
macos:
	mkdir -p ~/.config/nix-darwin
	cp hosts/macos/configuration.nix ~/.config/nix-darwin/configuration.nix
	darwin-rebuild switch -I darwin-config=$$HOME/.config/nix-darwin/configuration.nix
