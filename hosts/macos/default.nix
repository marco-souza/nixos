# macOS (nix-darwin). Shared CLI tooling comes from modules/shared.
# GUI apps come from Homebrew casks.
{ pkgs, username, ... }:

{
  networking.hostName = "macos";

  # Primary user (required by newer nix-darwin for user-scoped options).
  system.primaryUser = username;

  users.users.${username} = {
    name = username;
    home = "/Users/${username}";
    shell = pkgs.zsh;
  };

  # oh-my-zsh is configured via the user's .zshrc (managed by stow).
  environment.variables.EDITOR = "nvim";

  environment.systemPackages = with pkgs; [
    neovim
  ];

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
      "1password-cli"
    ];

    casks = [
      "brave-browser"
      "ghostty"
      "1password"
      "localsend"
      "jetbrains-toolbox"
      "android-studio"
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

    # Keyboard input sources: English (U.S.) and English (U.S. International – PC).
    # No first-class nix-darwin option, so set via CustomUserPreferences.
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

  nix.gc = {
    automatic = true;
    interval = { Weekday = 0; Hour = 3; Minute = 0; };
    options = "--delete-older-than 7d";
  };

  # Used for backwards compatibility. See `darwin-rebuild changelog`.
  system.stateVersion = 5;

  ### Activation: workspace + dotfiles setup.
  system.activationScripts.postActivation.text = ''
    sudo -u ${username} bash <<'USERSETUP'
    mkdir -p ~/w/marco-souza/

    if [ -d ~/.config/nvim/ ]; then
      cd ~/.config/nvim && git pull
    else
      git clone \
        --config core.sshCommand="ssh -o StrictHostKeyChecking=accept-new" \
        git@github.com:marco-souza/nvim.git ~/.config/nvim
    fi

    if [ -d ~/w/marco-souza/nixos/ ]; then
      cd ~/w/marco-souza/nixos/ && sh stow.sh stow zsh tmux ghostty pi mise
    fi
    USERSETUP
  '';
}
