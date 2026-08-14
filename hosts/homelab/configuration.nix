# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{ config, pkgs, ... }:

let
  username = "marco";
in

{
  imports = [
    # Include the results of the hardware scan.
    ./hardware-configuration.nix
  ];

  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.systemd-boot.configurationLimit = 5;
  boot.loader.efi.canTouchEfiVariables = true;

  networking.hostName = "homelab"; # Define your hostname.
  # networking.wireless.enable = true;  # Enables wireless support via wpa_supplicant.

  # Configure network proxy if necessary
  # networking.proxy.default = "http://user:password@proxy:port/";
  # networking.proxy.noProxy = "127.0.0.1,localhost,internal.domain";

  # Enable networking
  networking.networkmanager.enable = true;

  # Set your time zone.
  time.timeZone = "America/Sao_Paulo";

  # Configure console keymap
  console.keyMap = "br-abnt2";

  # Select internationalisation properties.
  i18n.defaultLocale = "en_US.UTF-8";

  i18n.extraLocaleSettings = {
    LC_ADDRESS = "pt_BR.UTF-8";
    LC_IDENTIFICATION = "pt_BR.UTF-8";
    LC_MEASUREMENT = "pt_BR.UTF-8";
    LC_MONETARY = "pt_BR.UTF-8";
    LC_NAME = "pt_BR.UTF-8";
    LC_NUMERIC = "pt_BR.UTF-8";
    LC_PAPER = "pt_BR.UTF-8";
    LC_TELEPHONE = "pt_BR.UTF-8";
    LC_TIME = "pt_BR.UTF-8";
  };

  # List services that you want to enable:
  services = {
    # Enable the OpenSSH daemon.
    openssh.enable = true;

    # Enable tailscale service.
    tailscale.enable = true;

    # Enable Desktop Environment.
    desktopManager.cosmic.enable = true;

    displayManager.cosmic-greeter.enable = true;
    # Configure keymap in X11
    xserver.xkb = {
      layout = "us";
      variant = "";
      options = "";
    };

    # Configure Remote Desktop
    xserver = {
      enable = true;
      autorun = true;
    };

    xrdp = {
      enable = true;
      openFirewall = true;
    };

    # Enable sound with pipewire.
    pulseaudio.enable = false;
    pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      pulse.enable = true;
    };

    # Enable touchpad support (enabled default in most desktopManager).
    libinput.enable = true;
  };

  # Bluetooth with experimental BlueZ features for stable A2DP/HFP on JBL headsets.
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
    settings.General.Experimental = true;
    settings.General.FastConnectable = true;
    settings.Policy.AutoEnable = true;
  };

  security.rtkit.enable = true;

  # Docker install
  virtualisation.docker.enable = true;

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users."${username}" = {
    shell = pkgs.zsh;
    useDefaultShell = true;

    isNormalUser = true;
    description = username;
    extraGroups = [ "networkmanager" "wheel" "docker" ];


    packages = with pkgs; [
      lsof
      openssl
    ];
  };

  # Install Htop
  programs.htop.enable = true;

  # Install Firefox
  programs.firefox.enable = true;

  # Install zsh + omz
  programs.zsh = {
    enable = true;
    enableCompletion = true;

    syntaxHighlighting.enable = true;
    autosuggestions.enable = true;

    ohMyZsh = {
      enable = true;
      theme = "ys";
      plugins = [
        "git"
        "tmux"
        "docker"
      ];
    };
  };

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = true;
  };

  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      # Add any other libraries your parsers need if the default list fails
      # glibc
    ];
  };

  programs.git = {
    enable = true;
    config = {
      user = {
        name = "Marco Souza";
        email = "ma.souza.junior@gmail.com";
      };
      init.defaultBranch = "main";
    };
  };

  # List packages installed in system profile. To search, run:
  # $ nix search wget
  environment.systemPackages = with pkgs; [
    # adding cli tools:
    mise
    stow
    wget
    curl
    ripgrep

    # LazyVim dependencies
    fd              # Faster find
    fzf             # Fuzzy finder
    bat             # Better cat
    eza             # Better ls
    tree            # Directory tree
    jq              # JSON processor
    gnumake         # Make utility
    gcc             # C compiler (needed for some plugins)
    go              # Go language (needed for some plugins)
    nodejs          # JavaScript runtime
    bun             # Better-JavaScript runtime
    deno            # Best-JavaScript runtime

    # Fonts (recommended for status line icons)
    nerd-fonts.jetbrains-mono
    nerd-fonts.fira-code

    # User pages
    brave
    tmux
    ghostty
    lazygit
  ];

  # Environment Variables
  environment.variables = {
    BROWSER = "brave";
  };

  programs.localsend = {
    enable = true;
    openFirewall = true;
  };

  # Enable 1password
  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ username ];
  };

  # Some programs need SUID wrappers, can be configured further or are
  # started in user sessions.
  programs.mtr.enable = true;
  programs.gnupg.agent = {
    enable = true;
    enableSSHSupport = true;
  };

  # Open ports in the firewall.
  # networking.firewall.allowedTCPPorts = [ ... ];
  # networking.firewall.allowedUDPPorts = [ ... ];
  # Or disable the firewall altogether.
  # networking.firewall.enable = false;

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "26.05"; # Did you read the comment?

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 7d";
  };

  ### User activation scripts
  system.userActivationScripts.workspace-setup.text = ''
    source ${config.system.build.setEnvironment}

    # ensure workspace exists
    mkdir -p ~/w/marco-souza/

    # clone neovim
    if [ -d ~/.config/nvim/ ]; then
      cd ~/.config/nvim && git pull
    else
      git clone \
        --config core.sshCommand="ssh -o StrictHostKeyChecking=accept-new" \
        git@github.com:marco-souza/nvim.git ~/.config/nvim
    fi

    # Stow files
    cd ~/w/marco-souza/nixos/ && sh stow.sh stow zsh tmux ghostty pi mise

    # Wakatime

    if [ ! -f $HOME/.wakatime.cfg ]; then
      echo "set up wakatime"
      wakatime_api_secret=$(op item get "$(op item list | grep wakatime | awk '{ print $1 }')" --fields "label=API Secret" --reveal)

      if [ -z "$wakatime_api_secret" ]; then
        echo "[op]   Wakatime API Secret not found in 1password. Please create an item in 1password with the label 'Wakatime' and a field 'API Secret' containing your Wakatime API key."
        exit 1
      fi

      echo -e "\n[settings]\ndebug = false\napi_key = $wakatime_api_secret\n" >"$HOME/.wakatime.cfg"
    fi
  '';
}
