# Laptop — hostname "laptop" is set in flake.nix from the attribute name.
{ config, pkgs, ... }:

{
  imports = [ ./hardware-configuration.nix ];

  services.xserver.xkb = {
    layout = "br";
    variant = "";
    options = "";
  };

  # WARN: fprintd (not working)
  # services.fprintd = {
  #   enable = true;
  #   tod.enable = true;
  #   tod.driver = pkgs.libfprint-2-tod1-goodix;
  # };
  # security.pam.services.login.fprintAuth = true;
  # security.pam.services.sudo.fprintAuth = true;

  # Android Studio
  nixpkgs.config.android_sdk.accept_license = true;

  # DisplayLink
  services.xserver.videoDrivers = [ "displaylink" "modesetting" ];
  boot = {
    extraModulePackages = [ config.boot.kernelPackages.evdi ];
    initrd.kernelModules = [ "evdi" ];
    # Reduce Wi-Fi/BT coexistence conflicts on Intel AX210 (audio dropouts).
    extraModprobeConfig = ''
      options iwlwifi bt_coex_active=0
      options iwlwifi swcrypto=1
      options iwlwifi power_save=0
      options iwlwifi uapsd_disable=1
      options iwlwifi d0i3_disable=1
      options iwlmvm power_scheme=1
    '';
  };

  # Gaming
  programs.steam = {
    enable = true;
    gamescopeSession.enable = true;
  };

  environment.systemPackages = with pkgs; [
    lutris
    jetbrains-toolbox
  ];

  # Do not change after install. See `man configuration.nix`.
  system.stateVersion = "26.05";
}
