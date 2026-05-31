#!/usr/bin/env sh
# Rayu-CLI installer (Linux & macOS).
#
# Installs the `rayu` binary to ~/.rayu/bin and adds it to your PATH so you can
# just run `rayu` from anywhere — no manual setup.
#
#   curl -fsSL https://<host>/install.sh | sh        # download a release
#   ./install.sh                                     # install from a local build (dist/bin)
#
# Env overrides:
#   RAYU_INSTALL_DIR        install location (default: $HOME/.rayu/bin)
#   RAYU_RELEASE_BASE_URL   base URL to download binaries from (release assets)
set -eu

INSTALL_DIR="${RAYU_INSTALL_DIR:-$HOME/.rayu/bin}"
RELEASE_BASE="${RAYU_RELEASE_BASE_URL:-https://github.com/rayu-cli/rayu-cli/releases/latest/download}"

# --- detect OS / arch -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "rayu: unsupported OS '$os' (Linux/macOS only; use install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) echo "rayu: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
BIN="rayu-$OS-$ARCH"

# --- locate source: local build, or download -------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo .)"
mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/rayu"

if [ -f "$SCRIPT_DIR/dist/bin/$BIN" ]; then
  echo "rayu: installing from local build ($BIN)…"
  cp "$SCRIPT_DIR/dist/bin/$BIN" "$DEST"
elif [ -f "$SCRIPT_DIR/$BIN" ]; then
  echo "rayu: installing from local file ($BIN)…"
  cp "$SCRIPT_DIR/$BIN" "$DEST"
else
  URL="$RELEASE_BASE/$BIN"
  echo "rayu: downloading $URL …"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$DEST"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$DEST" "$URL"
  else
    echo "rayu: need curl or wget to download" >&2; exit 1
  fi
fi
chmod +x "$DEST"

# --- add INSTALL_DIR to PATH via shell profiles (idempotent) ----------------
PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
added=""
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -e "$rc" ] || { [ "$rc" = "$HOME/.profile" ] && : > "$rc" || continue; }
  if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
    printf '\n# Added by Rayu-CLI installer\n%s\n' "$PATH_LINE" >> "$rc"
    added="$added $rc"
  fi
done
# Fish shell, if present.
if [ -d "$HOME/.config/fish" ]; then
  fish_cfg="$HOME/.config/fish/config.fish"
  if ! grep -qF "$INSTALL_DIR" "$fish_cfg" 2>/dev/null; then
    printf '\n# Added by Rayu-CLI installer\nset -gx PATH %s $PATH\n' "$INSTALL_DIR" >> "$fish_cfg"
    added="$added $fish_cfg"
  fi
fi

echo ""
echo "✓ Rayu-CLI installed to $DEST"
if [ -n "$added" ]; then
  echo "  PATH updated in:$added"
  echo "  Open a new terminal (or run: export PATH=\"$INSTALL_DIR:\$PATH\") then run: rayu"
else
  echo "  $INSTALL_DIR already on PATH. Run: rayu"
fi
