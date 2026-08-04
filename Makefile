laptop:
	sudo cp hosts/laptop/configuration.nix /etc/nixos/configuration.nix
	sudo nixos-rebuild switch

homelab:
	sudo cp hosts/homelab/configuration.nix /etc/nixos/configuration.nix
	sudo nixos-rebuild switch
