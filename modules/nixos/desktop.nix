# Graphical desktop: COSMIC, audio, bluetooth and GUI apps.
{ pkgs, ... }:

{
  services.desktopManager.cosmic.enable = true;
  services.displayManager.cosmic-greeter.enable = true;

  # Sound with pipewire.
  services.pulseaudio.enable = false;
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    # The laptop only sends bluetooth audio. With the A2DP sink role on,
    # speakers that are also an audio source (JBL PartyBox) fail to connect.
    wireplumber.extraConfig."51-bluez-roles"."monitor.bluez.properties"."bluez5.roles" = [
      "a2dp_source"
      "hfp_ag"
      "hsp_ag"
    ];
  };

  # Touchpad support (enabled by default in most desktopManagers).
  services.libinput.enable = true;

  # Bluetooth with experimental BlueZ features: needed for Google Nest speakers
  # and stable A2DP/HFP on JBL headsets.
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
    settings.General.Experimental = true;
    settings.General.FastConnectable = true;
    settings.Policy.AutoEnable = true;
  };

  programs.firefox.enable = true;

  programs.localsend = {
    enable = true;
    openFirewall = true;
  };

  environment.systemPackages = with pkgs; [
    brave
    ghostty
    (callPackage ../../pkgs/orca-ide.nix { })
  ];
}
