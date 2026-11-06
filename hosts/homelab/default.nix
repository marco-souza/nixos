# Homelab — hostname "homelab" is set in flake.nix from the attribute name.
{ ... }:

{
  imports = [ ./hardware-configuration.nix ];

  services.xserver.xkb = {
    layout = "us";
    variant = "";
    options = "";
  };

  # Remote desktop
  services.xserver = {
    enable = true;
    autorun = true;
  };
  services.xrdp = {
    enable = true;
    openFirewall = true;
  };

  # Do not change after install. See `man configuration.nix`.
  system.stateVersion = "26.05";
}
