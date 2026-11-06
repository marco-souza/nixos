# Base for every NixOS machine (laptop, homelab, ...).
# Host-specific bits live in hosts/<name>/default.nix.
{ config, pkgs, username, ... }:

{
  imports = [ ./desktop.nix ];

  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.systemd-boot.configurationLimit = 5;
  boot.loader.efi.canTouchEfiVariables = true;

  networking.networkmanager.enable = true;

  # Locale / keyboard
  console.useXkbConfig = true; # TTY follows each host's xkb layout
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

  services.openssh.enable = true;
  services.tailscale.enable = true;

  virtualisation.docker.enable = true;

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users.${username} = {
    shell = pkgs.zsh;
    useDefaultShell = true;
    isNormalUser = true;
    description = username;
    extraGroups = [ "networkmanager" "wheel" "docker" ];
    packages = with pkgs; [
      lsof
      openssl
      python3
    ];
  };

  programs.htop.enable = true;

  # zsh + oh-my-zsh
  programs.zsh = {
    enableCompletion = true;
    syntaxHighlighting.enable = true;
    autosuggestions.enable = true;
    ohMyZsh = {
      enable = true;
      theme = "ys";
      plugins = [ "git" "tmux" "docker" ];
    };
  };

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

  # 1password
  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    polkitPolicyOwners = [ username ];
  };

  # Start 1password minimized to tray on login. Declared here instead of the
  # app's own "start at login" toggle, which symlinks a store path that GC deletes.
  environment.systemPackages = [
    (pkgs.makeAutostartItem {
      name = "1password";
      package = config.programs._1password-gui.package;
      appendExtraArgs = [ "--silent" ];
    })
  ];

  # Some programs need SUID wrappers, can be configured further or are
  # started in user sessions.
  programs.mtr.enable = true;
  programs.gnupg.agent = {
    enable = true;
    enableSSHSupport = true;
  };

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
