# Orca (https://onorca.dev): agent development environment.
# Not in nixpkgs, so wrap the official release AppImage.
# Bump: change `version`, then refresh the hash with
#   nix-prefetch-url --type sha256 <url> | xargs nix hash convert --hash-algo sha256 --to sri
# Based on https://github.com/stablyai/orca/pull/20129
{ lib, appimageTools, fetchurl }:

let
  # The binary/desktop id is `orca-ide` to avoid clashing with the GNOME
  # `orca` screen reader.
  pname = "orca-ide";
  version = "1.4.251";

  src = fetchurl {
    url = "https://github.com/stablyai/orca/releases/download/v${version}/orca-linux.AppImage";
    hash = "sha256-JmH/gvtT/VL4cXEFlR3zt4x68CYicw/FysFT6zgQDjw=";
  };

  appimageContents = appimageTools.extractType2 { inherit pname version src; };
in
appimageTools.wrapType2 {
  inherit pname version src;

  extraInstallCommands = ''
    install -Dm444 ${appimageContents}/${pname}.desktop -t $out/share/applications
    substituteInPlace $out/share/applications/${pname}.desktop \
      --replace-fail 'Exec=AppRun' 'Exec=${pname}'
    for size in 16 24 32 48 64 128 256 512; do
      install -Dm444 \
        "${appimageContents}/usr/share/icons/hicolor/''${size}x''${size}/apps/${pname}.png" \
        "$out/share/icons/hicolor/''${size}x''${size}/apps/${pname}.png"
    done
  '';

  meta = {
    description = "Agent development environment for parallel coding agents";
    homepage = "https://onorca.dev";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = pname;
  };
}
