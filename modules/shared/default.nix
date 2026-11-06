# Settings shared by every machine (NixOS and nix-darwin).
# Only use options that exist on both platforms here.
{ pkgs, ... }:

{
  time.timeZone = "America/Sao_Paulo";

  nixpkgs.config.allowUnfree = true;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  programs.zsh.enable = true;

  environment.variables.BROWSER = "brave";

  environment.systemPackages = with pkgs; [
    # cli tools
    vim
    mise
    stow
    wget
    curl
    ripgrep
    tmux
    lazygit
    zenity # GTK dialogs (e.g. Brave's profile-in-use prompt)

    # LazyVim dependencies
    fd # Faster find
    fzf # Fuzzy finder
    bat # Better cat
    eza # Better ls
    tree # Directory tree
    jq # JSON processor
    gnumake # Make utility
    gcc # C compiler (needed for some plugins)
    go # Go language (needed for some plugins)
    nodejs # JavaScript runtime
    bun # Better-JavaScript runtime
    deno # Best-JavaScript runtime

    # Fonts (recommended for status line icons)
    nerd-fonts.jetbrains-mono
    nerd-fonts.fira-code
  ];
}
