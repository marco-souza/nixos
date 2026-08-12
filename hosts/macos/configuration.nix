# macOS system configuration using nix-darwin.
# Inspired by hosts/laptop/configuration.nix, adapted from NixOS to nix-darwin.
#
# NixOS-only concepts (bootloader, systemd services, pipewire, cosmic DE,
# displaylink, steam, docker virtualisation, tailscale) do not apply on macOS
# and are either dropped or replaced with their darwin/Homebrew equivalents.

{ config, pkgs, ... }:

let
  username = "marco";
in

{
  imports = [ ];

  # Set your time zone.
  time.timeZone = "America/Sao_Paulo";

  networking.hostName = "m3o-mac";

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # Primary user (required by newer nix-darwin for user-scoped options).
  system.primaryUser = username;

  users.users."${username}" = {
    name = username;
    home = "/Users/${username}";
    shell = pkgs.zsh;
  };

  # Enable zsh at the system level. oh-my-zsh itself is configured via the
  # user's .zshrc (managed by stow), like on the laptop host.
  programs.zsh.enable = true;

  # Environment Variables
  environment.variables = {
    EDITOR = "nvim";
    BROWSER = "brave";
  };

  # List packages installed in system profile.
  # CLI tooling matches the laptop config; GUI apps live under homebrew.casks.
  environment.systemPackages = with pkgs; [
    # cli tools
    vim
    neovim
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

    # cli user pages
    tmux
    lazygit
  ];

  # git configured system-wide (mirrors the laptop config).
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

  # Homebrew for GUI apps and things not (well) packaged for nix on darwin.
  # Requires Homebrew to be installed first: https://brew.sh
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
      upgrade = true;
    };

    brews = [
      # 1password CLI (the NixOS programs._1password equivalent)
      "1password-cli"
    ];

    casks = [
      # equivalents of the laptop's GUI packages
      "brave-browser"      # brave
      "ghostty"            # ghostty terminal
      "1password"          # 1password GUI
      "localsend"          # localsend
      "jetbrains-toolbox"  # jetbrains-toolbox
      "android-studio"     # android-studio
      # steam / lutris are gaming-focused; steam has a cask if wanted:
      # "steam"
    ];

    taps = [ ];
  };

  # macOS system defaults (quality-of-life tweaks).
  system.defaults = {
    dock = {
      autohide = true;
      mru-spaces = false;
    };
    finder = {
      AppleShowAllExtensions = true;
      FXPreferredViewStyle = "Nlsv"; # list view
    };
    NSGlobalDomain = {
      InitialKeyRepeat = 15;
      KeyRepeat = 2;
    };

    # Keyboard input sources (layouts): English (U.S.) and English (U.S.
    # International – PC). macOS stores these under com.apple.HIToolbox, which
    # has no first-class nix-darwin option, so we set it via CustomUserPreferences.
    CustomUserPreferences = {
      "com.apple.HIToolbox" = {
        AppleEnabledInputSources = [
          {
            InputSourceKind = "Keyboard Layout";
            "KeyboardLayout ID" = 0;
            "KeyboardLayout Name" = "U.S.";
          }
          {
            InputSourceKind = "Keyboard Layout";
            "KeyboardLayout ID" = 15000;
            "KeyboardLayout Name" = "USInternational-PC";
          }
        ];
      };
    };
  };

  # Flakes-friendly settings.
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # Garbage collection (mirrors the laptop config).
  nix.gc = {
    automatic = true;
    interval = { Weekday = 0; Hour = 3; Minute = 0; };
    options = "--delete-older-than 7d";
  };

  # Used for backwards compatibility. See `darwin-rebuild changelog`.
  system.stateVersion = 5;

  ### User activation: workspace + dotfiles setup (mirrors laptop config).
  system.activationScripts.postActivation.text = ''
    sudo -u ${username} bash <<'USERSETUP'
    # ensure workspace exists
    mkdir -p ~/w/marco-souza/

    # clone neovim config
    if [ -d ~/.config/nvim/ ]; then
      cd ~/.config/nvim && git pull
    else
      git clone \
        --config core.sshCommand="ssh -o StrictHostKeyChecking=accept-new" \
        git@github.com:marco-souza/nvim.git ~/.config/nvim
    fi

    # Stow dotfiles
    if [ -d ~/w/marco-souza/nixos/ ]; then
      cd ~/w/marco-souza/nixos/ && sh stow.sh stow zsh tmux ghostty pi mise
    fi
    USERSETUP
  '';
}
