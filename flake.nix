{
  description = "Marco's NixOS / nix-darwin machines";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nix-darwin, ... }@inputs:
    let
      username = "marco";
      specialArgs = { inherit inputs username; };

      # Build a NixOS host from hosts/<name> + the shared modules.
      # The hostname equals the attribute name, so on each machine a plain
      # `sudo nixos-rebuild switch --flake .` picks the right config.
      mkNixos = name: nixpkgs.lib.nixosSystem {
        inherit specialArgs;
        modules = [
          ./modules/shared
          ./modules/nixos/common.nix
          ./hosts/${name}
          { networking.hostName = name; }
        ];
      };
    in
    {
      # sudo nixos-rebuild switch --flake .
      nixosConfigurations = {
        laptop = mkNixos "laptop";
        homelab = mkNixos "homelab";
      };

      # darwin-rebuild switch --flake .#macos
      darwinConfigurations.macos = nix-darwin.lib.darwinSystem {
        inherit specialArgs;
        modules = [
          ./modules/shared
          ./hosts/macos
          { nixpkgs.hostPlatform = "aarch64-darwin"; } # Apple Silicon
        ];
      };

      formatter.x86_64-linux = nixpkgs.legacyPackages.x86_64-linux.nixpkgs-fmt;
    };
}
