apply:
	sudo cp hosts/laptop/configuration.nix /etc/nixos/configuration.nix && sudo nixos-rebuild switch
	sudo cp hosts/laptop/hardware-configuration.nix /etc/nixos/hardware-configuration.nix && sudo nixos-rebuild switch
