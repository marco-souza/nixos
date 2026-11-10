# Laptop — hostname "laptop" is set in flake.nix from the attribute name.
{ config, pkgs, ... }:

{
  imports = [ ./hardware-configuration.nix ];

  # Default layouts (COSMIC keeps its own per-user copy once changed in Settings).
  services.xserver.xkb.layout = "br,us";

  # Fingerprint: Goodix 27c6:63bc (XPS 9320) is supported natively by
  # upstream libfprint (goodixmoc driver) — do NOT enable the TOD Goodix
  # driver, it targets older sensors (27c6:5xxx) and breaks this one.
  services.fprintd.enable = true;
  security.pam.services.login.fprintAuth = true;
  security.pam.services.sudo.fprintAuth = true;

  # Android Studio
  nixpkgs.config.android_sdk.accept_license = true;

  # DisplayLink
  services.xserver.videoDrivers = [ "displaylink" "modesetting" ];
  boot = {
    extraModulePackages = [ config.boot.kernelPackages.evdi ];
    initrd.kernelModules = [ "evdi" ];
    # Intel AX211 (CNVi): Wi-Fi and BT share the antenna, so keep BT coexistence
    # ON (bt_coex_active=0 starves BT under Wi-Fi load: mouse/speaker drops).
    extraModprobeConfig = ''
      options iwlwifi swcrypto=1
      options iwlwifi power_save=0
      options iwlwifi uapsd_disable=1
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
