#!/bin/sh
# Rayu CLI — universal installer for Linux and macOS.
#
#   curl -fsSL https://rayucode.com/install | bash
#
# CANONICAL COPY: rayu-web/public/install.sh — that is the file the website
# serves at /install and /install.sh. rayu/install.sh (this repo) must stay
# byte-identical to it; `bun run check:installer` diffs this file against the
# live URL. Edit one, copy to the other, in the same change.
#
# Why this exists instead of `npm install -g @rayu-dev/rayu-cli`:
# the npm route depends on the user's Node version, npm version, global prefix
# permissions (EACCES / sudo), and on npm building ~80 transitive dependencies
# that the shipped bundle does not even load at runtime. Every one of those is a
# per-machine failure mode. This script removes all of them:
#
#   1. Prefer a standalone native binary (embeds its own runtime) when the
#      GitHub release for this platform exists — zero runtime dependencies.
#   2. Otherwise fetch the published npm tarball directly from the registry and
#      extract the single pre-bundled file (dist/rayu.js). No npm, no
#      dependency resolution, no native compilation, no sudo.
#   3. Run it with the system Node when it is >= 18, otherwise download a
#      private, checksum-verified Node runtime into ~/.rayu/runtime.
#   4. Install to ~/.rayu/bin (never a system directory) and wire that onto
#      PATH for bash / zsh / fish / sh.
#
# Options (flags or environment variables):
#   --version <v> | RAYU_VERSION=<v>      install an exact version
#   --dir <path>  | RAYU_INSTALL_DIR      bin directory (default ~/.rayu/bin)
#                   RAYU_HOME             state directory (default ~/.rayu)
#   --no-modify-path                      do not touch shell profiles
#   --npm-tarball                         skip the native binary, force tarball
#   --uninstall                           remove Rayu installed by this script
#   --quiet | --help
#
# Examples:
#   curl -fsSL https://rayucode.com/install | bash
#   curl -fsSL https://rayucode.com/install | bash -s -- --version 1.6.13
#   curl -fsSL https://rayucode.com/install | bash -s -- --uninstall

set -eu

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NPM_PACKAGE='@rayu-dev/rayu-cli'
NPM_PACKAGE_URLSAFE='@rayu-dev%2frayu-cli'
NPM_REGISTRY="${RAYU_NPM_REGISTRY:-https://registry.npmjs.org}"
GITHUB_REPO="${RAYU_GITHUB_REPO:-Choeng-Rayu/rayu-cli}"
INSTALLER_URL="${RAYU_INSTALLER_URL:-https://rayucode.com/install}"

# Private Node runtime used only when the machine has no usable Node.
NODE_VERSION="${RAYU_NODE_VERSION:-v22.20.0}"
NODE_DIST="${RAYU_NODE_DIST:-https://nodejs.org/dist}"
NODE_DIST_MUSL="${RAYU_NODE_DIST_MUSL:-https://unofficial-builds.nodejs.org/download/release}"
MIN_NODE_MAJOR=18

PROFILE_MARKER_BEGIN='# >>> rayu cli >>>'
PROFILE_MARKER_END='# <<< rayu cli <<<'

RAYU_HOME="${RAYU_HOME:-$HOME/.rayu}"
BIN_DIR="${RAYU_INSTALL_DIR:-$RAYU_HOME/bin}"
LIB_DIR="$RAYU_HOME/lib"
RUNTIME_DIR="$RAYU_HOME/runtime"

WANT_VERSION="${RAYU_VERSION:-}"
MODIFY_PATH=1
FORCE_TARBALL=0
DO_UNINSTALL=0
DO_LOCAL=0
LOCAL_SRC=''
QUIET=0
TMP_DIR=''

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# Colour is opt-out (NO_COLOR) and auto-off when stdout is not a terminal, so
# piping the installer's output into a log file produces clean text.
IS_TTY=0
[ -t 1 ] && IS_TTY=1

if [ "$IS_TTY" -eq 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$(printf '\033[0m'); C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m'); C_GREEN=$(printf '\033[32m')
  C_YELLOW=$(printf '\033[33m'); C_BOLD=$(printf '\033[1m')
  C_CYAN=$(printf '\033[36m'); C_BLUE=$(printf '\033[34m')
  C_CLEAR_LINE=$(printf '\r\033[K')
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''
  C_CYAN=''; C_BLUE=''; C_CLEAR_LINE=''
fi

# Block-drawing characters make a much better progress bar, but only when the
# terminal is actually in a UTF-8 locale — in the C/POSIX locale they render as
# mojibake, which looks broken rather than fancy.
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) BAR_FULL='█'; BAR_EMPTY='░'; MARK_OK='✓'; MARK_STEP='▸' ;;
  *) BAR_FULL='#'; BAR_EMPTY='-'; MARK_OK='+'; MARK_STEP='>' ;;
esac

# Indent the 2nd..nth lines of a multi-line message so wrapped guidance lines up
# under the first one instead of hugging the left margin.
indent_rest() { printf '%s' "$1" | sed '2,$s/^/          /'; }

info() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
step() { [ "$QUIET" -eq 1 ] || printf '  %s%s%s %s\n' "$C_CYAN" "$MARK_STEP" "$C_RESET" "$*"; }
ok() { [ "$QUIET" -eq 1 ] || printf '  %s%s%s %s\n' "$C_GREEN" "$MARK_OK" "$C_RESET" "$*"; }
warn() { printf '\n  %swarning%s %s\n' "$C_YELLOW" "$C_RESET" "$(indent_rest "$*")" >&2; }

# A heading with a rule under it, sized to the terminal (capped, so a very wide
# window does not draw a 300-character line).
title() {
  [ "$QUIET" -eq 1 ] && return 0
  printf '\n  %s%s%s\n' "$C_BOLD" "$1" "$C_RESET"
  _w=$(term_width); [ "$_w" -gt 62 ] && _w=62
  printf '  %s' "$C_DIM"
  awk -v n="$_w" 'BEGIN{ while (n-- > 0) printf "%s", "─" }' 2>/dev/null \
    || printf '%*s' "$_w" '' | tr ' ' '-'
  printf '%s\n' "$C_RESET"
}

# Aligned "label   value" line, for the install summary.
field() {
  [ "$QUIET" -eq 1 ] && return 0
  printf '  %s%-9s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$2"
}

term_width() {
  _cols=''
  if have tput; then _cols=$(tput cols 2>/dev/null || true); fi
  [ -n "$_cols" ] || _cols="${COLUMNS:-80}"
  case "$_cols" in ''|*[!0-9]*) _cols=80 ;; esac
  [ "$_cols" -lt 40 ] && _cols=40
  printf '%s' "$_cols"
}

# 1234567 -> "1.2 MB". awk rather than shell arithmetic because POSIX sh has no
# floating point, and a bar that says "1 MB / 5 MB" for ten seconds is useless.
human_bytes() {
  awk -v b="${1:-0}" 'BEGIN{
    if (b < 0) { printf "?"; exit }
    if (b < 1024) { printf "%d B", b; exit }
    if (b < 1048576) { printf "%.0f KB", b/1024; exit }
    if (b < 1073741824) { printf "%.1f MB", b/1048576; exit }
    printf "%.2f GB", b/1073741824
  }'
}

# Total transfer size for a URL, or 0 when it cannot be determined (in which
# case the bar shows an activity sweep instead of a percentage — never an error).
#
# Two probes, because one is not enough: nodejs.org answers HEAD with a
# Content-Length, but registry.npmjs.org does NOT (it serves tarballs without
# one on HEAD), and a bar with no total for the main download is the case that
# matters most. A 1-byte ranged GET makes the registry disclose the full size in
# Content-Range, at the cost of a single byte.
content_length() {
  _len=$(head_content_length "$1")
  case "$_len" in ''|*[!0-9]*) _len=0 ;; esac
  if [ "$_len" -gt 0 ]; then
    printf '%s' "$_len"
    return 0
  fi
  _len=$(range_total "$1")
  case "$_len" in ''|*[!0-9]*) _len=0 ;; esac
  printf '%s' "$_len"
}

head_content_length() {
  if [ "$DL" = curl ]; then
    curl -fsIL --connect-timeout 20 "$1" 2>/dev/null
  else
    wget -q --spider -S "$1" 2>&1
  fi | tr -d '\r' | tr 'A-Z' 'a-z' \
     | awk -F': *' '/^ *content-length:/ { v = $2 } END { printf "%d", v + 0 }'
}

# Parse `content-range: bytes 0-0/5006808` from a 1-byte ranged GET.
range_total() {
  if [ "$DL" = curl ]; then
    curl -fsSL --connect-timeout 20 -o /dev/null -D - -r 0-0 "$1" 2>/dev/null
  else
    wget -q -S --header='Range: bytes=0-0' -O /dev/null "$1" 2>&1
  fi | tr -d '\r' | tr 'A-Z' 'a-z' \
     | awk '/^ *content-range:/ { n = split($0, p, "/"); if (n > 1) v = p[n] } END { printf "%d", v + 0 }'
}

# Redraw the progress line in place. Never emits a newline: the caller either
# overwrites it on the next tick or clears it when finished.
draw_bar() { # label done total
  _label="$1"; _done="$2"; _btotal="$3"
  _w=$(term_width)
  # label + counters + percentage + rate take ~56 columns; give the rest to the
  # bar, clamped so it stays readable on an 80-column terminal and never wraps
  # (a wrapped bar leaves a trail of dead lines behind it).
  _barw=$((_w - 56))
  [ "$_barw" -lt 10 ] && _barw=10
  [ "$_barw" -gt 34 ] && _barw=34

  # Transfer rate, smoothed over the whole download. `date +%s` only has
  # 1-second resolution, so the first tick shows no rate rather than a wild one.
  _rate=''
  if [ -n "${BAR_START:-}" ]; then
    _now=$(date +%s 2>/dev/null || printf '0')
    _elapsed=$((_now - BAR_START))
    if [ "$_elapsed" -gt 0 ] && [ "$_done" -gt 0 ]; then
      _rate=" · $(human_bytes $((_done / _elapsed)))/s"
    fi
  fi

  if [ "$_btotal" -gt 0 ]; then
    _pct=$(awk -v d="$_done" -v t="$_btotal" 'BEGIN{p=int(d*100/t); if(p>100)p=100; print p}')
    _fill=$(awk -v p="$_pct" -v w="$_barw" 'BEGIN{f=int(p*w/100); if(f>w)f=w; print f}')
  else
    # Unknown size: sweep a short block across the bar so it is visibly alive.
    _pct=-1
    _fill=$(awk -v d="$_done" -v w="$_barw" 'BEGIN{print int(d/262144) % (w+1)}')
  fi

  _bar=$(awk -v f="$_fill" -v w="$_barw" -v a="$BAR_FULL" -v b="$BAR_EMPTY" 'BEGIN{
    for (i = 0; i < f; i++) printf "%s", a
    for (i = f; i < w; i++) printf "%s", b
  }')

  if [ "$_pct" -ge 0 ]; then
    printf '%s    %s%s%s %s%3d%%%s  %s%s / %s%s%s' \
      "$C_CLEAR_LINE" "$C_CYAN" "$_bar" "$C_RESET" \
      "$C_BOLD" "$_pct" "$C_RESET" \
      "$C_DIM" "$(human_bytes "$_done")" "$(human_bytes "$_btotal")" "$_rate" "$C_RESET"
  else
    printf '%s    %s%s%s  %s%s%s%s' \
      "$C_CLEAR_LINE" "$C_CYAN" "$_bar" "$C_RESET" \
      "$C_DIM" "$(human_bytes "$_done")" "$_rate" "$C_RESET"
  fi
}

# Fractional sleep is not in POSIX; probe once so the bar animates smoothly
# where it can and still works on a busybox `sleep` that only takes integers.
POLL_INTERVAL=1
if sleep 0.2 2>/dev/null; then POLL_INTERVAL=0.2; fi

# Download with a live progress bar.
#
# curl's own `--progress-bar` writes to stderr and cannot be styled or labelled,
# and wget has no equivalent at all — so the transfer runs in the background and
# the bar is drawn from the size of the partial file. That also means both
# backends get the identical display.
fetch_file_progress() { # URL DEST LABEL
  _purl="$1"; _pdest="$2"; _plabel="$3"

  # No terminal (CI, piped output), or --quiet: one plain line, no animation.
  if [ "$IS_TTY" -eq 0 ] || [ "$QUIET" -eq 1 ]; then
    step "downloading $_plabel"
    fetch_file "$_purl" "$_pdest"
    return 0
  fi

  _ptotal=$(content_length "$_purl" 2>/dev/null || printf '0')
  case "$_ptotal" in ''|*[!0-9]*) _ptotal=0 ;; esac

  if [ "$_ptotal" -gt 0 ]; then
    step "downloading $_plabel $C_DIM($(human_bytes "$_ptotal"))$C_RESET"
  else
    step "downloading $_plabel"
  fi

  : >"$_pdest"
  BAR_START=$(date +%s 2>/dev/null || printf '')
  fetch_file "$_purl" "$_pdest" &
  _ppid=$!

  while kill -0 "$_ppid" 2>/dev/null; do
    _pdone=$(wc -c <"$_pdest" 2>/dev/null || printf '0')
    case "$_pdone" in ''|*[!0-9]*) _pdone=0 ;; esac
    draw_bar "$_plabel" "$_pdone" "$_ptotal"
    sleep "$POLL_INTERVAL"
  done

  # `wait` reports the transfer's real exit status; a failed download must not
  # be hidden behind a bar that reached 100%.
  _pstatus=0
  wait "$_ppid" || _pstatus=$?

  if [ "$_pstatus" -ne 0 ]; then
    printf '%s' "$C_CLEAR_LINE"
    return "$_pstatus"
  fi

  _pfinal=$(wc -c <"$_pdest" 2>/dev/null || printf '0')
  case "$_pfinal" in ''|*[!0-9]*) _pfinal=0 ;; esac
  draw_bar "$_plabel" "$_pfinal" "${_ptotal:-0}"
  printf '%s' "$C_CLEAR_LINE"
  BAR_START=''
  printf '  %s%s%s %s %s(%s)%s\n' \
    "$C_GREEN" "$MARK_OK" "$C_RESET" "$_plabel" \
    "$C_DIM" "$(human_bytes "$_pfinal")" "$C_RESET"
  return 0
}

die() {
  # Clear any half-drawn progress bar before the error, or the two overlap.
  [ -n "$C_CLEAR_LINE" ] && printf '%s' "$C_CLEAR_LINE" >&2
  printf '\n  %serror%s %s\n' "$C_RED" "$C_RESET" "$(indent_rest "$*")" >&2
  printf '\n  %sNeed help? https://rayucode.com/docs/10-troubleshooting%s\n\n' \
    "$C_DIM" "$C_RESET" >&2
  exit 1
}

cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR" || true; }
trap cleanup EXIT HUP INT TERM

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'USAGE'
Rayu CLI installer (Linux / macOS)

  curl -fsSL https://rayucode.com/install | bash

Options:
  --version <v>      install an exact version instead of the latest
  --dir <path>       bin directory (default: ~/.rayu/bin)
  --no-modify-path   do not touch shell profiles
  --npm-tarball      skip the standalone binary, use the bundled JS build
  --local            install from a local build in this checkout
  --from <path>      install from a specific binary or dist/rayu.js
  --uninstall        remove a Rayu install created by this script
  --quiet, -q        less output
  --help, -h         this message

Environment: RAYU_HOME, RAYU_INSTALL_DIR, RAYU_VERSION, RAYU_NPM_REGISTRY,
             RAYU_NODE_VERSION, HTTPS_PROXY

Pass options through the pipe with -s --, for example:
  curl -fsSL https://rayucode.com/install | bash -s -- --version 1.6.13
USAGE
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; WANT_VERSION="$2"; shift 2 ;;
    --version=*) WANT_VERSION="${1#--version=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; BIN_DIR="$2"; shift 2 ;;
    --dir=*) BIN_DIR="${1#--dir=}"; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --npm-tarball|--no-native) FORCE_TARBALL=1; shift ;;
    --local) DO_LOCAL=1; shift ;;
    --from) [ $# -ge 2 ] || die "--from needs a path"; DO_LOCAL=1; LOCAL_SRC="$2"; shift 2 ;;
    --from=*) DO_LOCAL=1; LOCAL_SRC="${1#--from=}"; shift ;;
    --uninstall|--remove) DO_UNINSTALL=1; shift ;;
    --quiet|-q) QUIET=1; shift ;;
    --help|-h) usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

WANT_VERSION="${WANT_VERSION#v}"

# ---------------------------------------------------------------------------
# Network + checksum primitives
# ---------------------------------------------------------------------------

if have curl; then
  DL=curl
elif have wget; then
  DL=wget
else
  die "need curl or wget. Install one and re-run:
  Debian/Ubuntu: sudo apt-get install -y curl
  Fedora/RHEL:   sudo dnf install -y curl
  Alpine:        sudo apk add curl"
fi

# fetch_stdout URL -> body on stdout, non-zero exit on HTTP error
fetch_stdout() {
  if [ "$DL" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 20 "$1"
  else
    wget -qO- --tries=3 --timeout=20 "$1"
  fi
}

# fetch_file URL DEST
fetch_file() {
  if [ "$DL" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 20 -o "$2" "$1"
  else
    wget -qO "$2" --tries=3 --timeout=20 "$1"
  fi
}

# url_exists URL
url_exists() {
  if [ "$DL" = curl ]; then
    curl -fsIL --connect-timeout 20 -o /dev/null "$1" 2>/dev/null
  else
    wget -q --spider --timeout=20 "$1" 2>/dev/null
  fi
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else printf ''
  fi
}

sha1_of() {
  if have sha1sum; then sha1sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 1 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha1 "$1" | sed 's/.*= *//'
  else printf ''
  fi
}

# verify_checksum FILE EXPECTED ALGO LABEL — a missing hash tool warns, a
# mismatch is fatal (a truncated or tampered download must never be installed).
verify_checksum() {
  _file="$1"; _expected="$2"; _algo="$3"; _label="$4"
  [ -n "$_expected" ] || { warn "no $_algo checksum published for $_label; skipping verification"; return 0; }
  case "$_algo" in
    sha256) _actual=$(sha256_of "$_file") ;;
    sha1) _actual=$(sha1_of "$_file") ;;
    *) return 0 ;;
  esac
  if [ -z "$_actual" ]; then
    warn "no sha256sum/shasum/openssl found; cannot verify $_label"
    return 0
  fi
  if [ "$_actual" != "$_expected" ]; then
    die "checksum mismatch for $_label
  expected $_expected
  actual   $_actual
The download was corrupted or tampered with. Nothing was installed."
  fi
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
  _os=$(uname -s 2>/dev/null || echo unknown)
  _arch=$(uname -m 2>/dev/null || echo unknown)

  case "$_os" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "this installer is for Linux and macOS.
On Windows run this in PowerShell instead:
  irm https://rayucode.com/install.ps1 | iex" ;;
    *) die "unsupported operating system: $_os" ;;
  esac

  case "$_arch" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    armv7l|armv7|armhf) ARCH=armv7l ;;
    *) die "unsupported CPU architecture: $_arch" ;;
  esac

  # musl (Alpine and friends) needs different prebuilt runtimes than glibc.
  LIBC=glibc
  if [ "$OS" = linux ]; then
    if ls /lib/ld-musl-* >/dev/null 2>&1; then
      LIBC=musl
    elif (ldd --version 2>&1 || true) | grep -qi musl; then
      LIBC=musl
    fi
  fi

  # Matches getPlatform() in src/utils/nativeInstaller/installer.ts, which is
  # also what the release workflow names its assets after.
  if [ "$OS" = linux ] && [ "$LIBC" = musl ]; then
    NATIVE_PLATFORM="linux-$ARCH-musl"
  else
    NATIVE_PLATFORM="$OS-$ARCH"
  fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

remove_profile_block() {
  _file="$1"
  [ -f "$_file" ] || return 0
  grep -qF "$PROFILE_MARKER_BEGIN" "$_file" 2>/dev/null || return 0
  _tmp="$_file.rayu.$$"
  awk -v b="$PROFILE_MARKER_BEGIN" -v e="$PROFILE_MARKER_END" '
    index($0, b) { skip = 1; next }
    index($0, e) { skip = 0; next }
    !skip { print }
  ' "$_file" >"$_tmp" && cat "$_tmp" >"$_file" && rm -f "$_tmp"
  step "removed PATH entry from $_file"
}

do_uninstall() {
  title "Uninstalling Rayu CLI"
  for _f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zshenv" \
            "$HOME/.profile" "$HOME/.config/fish/config.fish"; do
    remove_profile_block "$_f"
  done
  for _p in "$BIN_DIR/rayu" "$BIN_DIR/.rayu-installer"; do
    [ -e "$_p" ] && rm -f "$_p" && step "removed $_p"
  done
  rm -rf "$LIB_DIR" "$RUNTIME_DIR" "$RAYU_HOME/install.json"
  step "removed $LIB_DIR, $RUNTIME_DIR"
  ok "Rayu CLI removed."
  info ""
  info "Your settings and credentials in $RAYU_HOME were kept."
  info "Delete them too with:  rm -rf \"$RAYU_HOME\""
  if have npm && npm ls -g --depth=0 "$NPM_PACKAGE" >/dev/null 2>&1; then
    info ""
    warn "a global npm copy is still installed. Remove it with:
  npm uninstall -g $NPM_PACKAGE"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Path 0 — a local build in this checkout (--local / --from), for developers
# ---------------------------------------------------------------------------

# Installs from `dist/bin/rayu-<os>-<arch>*` (a compiled standalone binary) or
# `dist/rayu.js` (the Node bundle), whichever is present — so the same script
# that end users curl also installs what you just built.
try_install_local() {
  _root="${LOCAL_SRC:-}"
  if [ -z "$_root" ]; then
    # Directory of this script when it is a real file, else the cwd.
    if [ -f "$0" ]; then
      _root=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || _root=$PWD
    else
      _root=$PWD
    fi
  fi

  # An explicit --from that points straight at a file.
  if [ -f "$_root" ]; then
    case "$_root" in
      *.js) _local_js="$_root"; _local_bin='' ;;
      *) _local_bin="$_root"; _local_js='' ;;
    esac
  else
    [ -d "$_root" ] || die "--from path not found: $_root"
    _local_bin=$(ls -1t "$_root"/dist/bin/rayu-"$OS"-"$ARCH"* 2>/dev/null | head -n1 || true)
    _local_js=''
    [ -n "$_local_bin" ] || { [ -f "$_root/dist/rayu.js" ] && _local_js="$_root/dist/rayu.js"; }
  fi

  if [ -n "${_local_bin:-}" ] && [ -f "$_local_bin" ]; then
    step "installing the local build $(basename "$_local_bin")"
    mkdir -p "$BIN_DIR"
    cp "$_local_bin" "$BIN_DIR/rayu.new"
    chmod 755 "$BIN_DIR/rayu.new"
    mv -f "$BIN_DIR/rayu.new" "$BIN_DIR/rayu"
    INSTALL_METHOD=local-binary
    INSTALLED_VERSION='local'
    return 0
  fi

  if [ -n "${_local_js:-}" ] && [ -f "$_local_js" ]; then
    step "installing the local bundle $_local_js"
    ensure_node
    _target="$LIB_DIR/rayu-local"
    rm -rf "$_target"
    mkdir -p "$_target"
    write_module_marker "$_target"
    cp "$_local_js" "$_target/rayu.js"
    ln -sfn "$_target" "$LIB_DIR/current"
    write_launcher
    prune_old_versions "$_target"
    INSTALL_METHOD=local-bundle
    INSTALLED_VERSION='local'
    return 0
  fi

  die "no local build found in $_root.
Build one first:
  bun run build            # -> dist/rayu.js
  bun run build:binaries   # -> dist/bin/rayu-$OS-$ARCH-<version>"
}

# ---------------------------------------------------------------------------
# Path 1 — standalone native binary from GitHub Releases (preferred)
# ---------------------------------------------------------------------------

# Native release assets embed their own runtime, so nothing else is needed.
# Returns 1 (and installs nothing) when no matching release asset exists, which
# is the normal case until a `v*` tag has been pushed and the release workflow
# has run.
try_install_native() {
  [ "$FORCE_TARBALL" -eq 0 ] || return 1

  if [ -n "$WANT_VERSION" ]; then
    _base="https://github.com/$GITHUB_REPO/releases/download/v$WANT_VERSION"
  else
    _base="https://github.com/$GITHUB_REPO/releases/latest/download"
  fi

  _asset="rayu-cli-$NATIVE_PLATFORM"
  step "looking for a standalone binary for $NATIVE_PLATFORM"
  url_exists "$_base/$_asset" || return 1

  # manifest.json carries the version and a sha256 per platform.
  _manifest="$TMP_DIR/manifest.json"
  _sum=''
  _mversion=''
  if fetch_file "$_base/manifest.json" "$_manifest" 2>/dev/null; then
    _mversion=$(tr -d ' \n' <"$_manifest" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    _sum=$(tr -d ' \n' <"$_manifest" \
      | sed -n "s/.*\"$NATIVE_PLATFORM\":{\"checksum\":\"\([0-9a-f]*\)\".*/\1/p")
  fi

  step "downloading $_asset"
  fetch_file_progress "$_base/$_asset" "$TMP_DIR/rayu.bin" "$_asset" || return 1
  step "verifying the binary checksum"
  verify_checksum "$TMP_DIR/rayu.bin" "$_sum" sha256 "$_asset"

  mkdir -p "$BIN_DIR"
  chmod 755 "$TMP_DIR/rayu.bin"
  # macOS tags files downloaded by browsers with com.apple.quarantine, which
  # makes Gatekeeper refuse an unsigned binary. curl does not set it, but a
  # proxy or a user's own tooling can — clearing it is a no-op otherwise.
  if [ "$OS" = darwin ] && have xattr; then
    xattr -d com.apple.quarantine "$TMP_DIR/rayu.bin" 2>/dev/null || true
  fi
  # Write via a temp name + mv so an interrupted install never leaves a
  # half-written `rayu` on PATH, and so replacing a running binary works.
  mv -f "$TMP_DIR/rayu.bin" "$BIN_DIR/rayu.new"
  mv -f "$BIN_DIR/rayu.new" "$BIN_DIR/rayu"

  INSTALL_METHOD=native
  INSTALLED_VERSION="${_mversion:-${WANT_VERSION:-unknown}}"
  return 0
}

# ---------------------------------------------------------------------------
# Path 2 — npm tarball + Node runtime
# ---------------------------------------------------------------------------

node_major() {
  # "v22.20.0" -> 22 ; empty when $1 is not a usable node
  _v=$("$1" --version 2>/dev/null || printf '')
  [ -n "$_v" ] || { printf ''; return 0; }
  printf '%s' "${_v#v}" | cut -d. -f1
}

# Portable Node tarball name for this platform, or empty when unavailable.
node_tarball_name() {
  case "$OS-$ARCH-$LIBC" in
    linux-x64-glibc)   printf 'node-%s-linux-x64.tar.gz' "$NODE_VERSION" ;;
    linux-arm64-glibc) printf 'node-%s-linux-arm64.tar.gz' "$NODE_VERSION" ;;
    linux-armv7l-glibc) printf 'node-%s-linux-armv7l.tar.gz' "$NODE_VERSION" ;;
    darwin-x64-*)      printf 'node-%s-darwin-x64.tar.gz' "$NODE_VERSION" ;;
    darwin-arm64-*)    printf 'node-%s-darwin-arm64.tar.gz' "$NODE_VERSION" ;;
    linux-x64-musl)    printf 'node-%s-linux-x64-musl.tar.gz' "$NODE_VERSION" ;;
    linux-arm64-musl)  printf 'node-%s-linux-arm64-musl.tar.gz' "$NODE_VERSION" ;;
    *) printf '' ;;
  esac
}

download_node() {
  _name=$(node_tarball_name)
  [ -n "$_name" ] || die "no prebuilt Node runtime for $OS/$ARCH ($LIBC).
Install Node >= $MIN_NODE_MAJOR yourself, then re-run this installer."

  if [ "$LIBC" = musl ]; then
    _url="$NODE_DIST_MUSL/$NODE_VERSION/$_name"
    _sums="$NODE_DIST_MUSL/$NODE_VERSION/SHASUMS256.txt"
  else
    _url="$NODE_DIST/$NODE_VERSION/$_name"
    _sums="$NODE_DIST/$NODE_VERSION/SHASUMS256.txt"
  fi

  fetch_file_progress "$_url" "$TMP_DIR/$_name" "node $NODE_VERSION ($OS-$ARCH)" \
    || die "could not download the Node runtime from $_url.
Install Node >= $MIN_NODE_MAJOR yourself, then re-run this installer."

  _expected=''
  if fetch_stdout "$_sums" >"$TMP_DIR/SHASUMS256.txt" 2>/dev/null; then
    _expected=$(grep " $_name\$" "$TMP_DIR/SHASUMS256.txt" 2>/dev/null | cut -d' ' -f1 | head -1)
  fi
  step "verifying the runtime checksum"
  verify_checksum "$TMP_DIR/$_name" "$_expected" sha256 "$_name"

  step "unpacking the Node runtime"
  mkdir -p "$RUNTIME_DIR"
  rm -rf "$RUNTIME_DIR/node.tmp"
  mkdir -p "$RUNTIME_DIR/node.tmp"
  tar -xzf "$TMP_DIR/$_name" -C "$RUNTIME_DIR/node.tmp" --strip-components=1 \
    || die "failed to extract the Node runtime (is 'tar' working?)"
  rm -rf "$RUNTIME_DIR/node"
  mv "$RUNTIME_DIR/node.tmp" "$RUNTIME_DIR/node"

  NODE_BIN="$RUNTIME_DIR/node/bin/node"
  [ -x "$NODE_BIN" ] || die "the downloaded Node runtime is not executable at $NODE_BIN"

  # Actually start it. A runtime that unpacks fine but cannot load is the common
  # failure on minimal images: the musl Node builds are dynamically linked
  # against libstdc++/libgcc, which a bare Alpine container does not ship. Left
  # unchecked this used to print "Node  installed privately" with an empty
  # version and fail three steps later with an unrelated "please report this
  # bug" message, hiding a one-command fix.
  # `|| true` rather than `|| _nv=''`: the failure output is exactly what names
  # the missing library, so it must survive a non-zero exit.
  _nv=$("$NODE_BIN" --version 2>&1 || true)
  case "$_nv" in
    v[0-9]*) ok "Node $_nv ready $C_DIM($RUNTIME_DIR/node)$C_RESET" ;;
    *)
      _missing=$(printf '%s\n' "$_nv" \
        | sed -n 's/.*shared library \([^:]*\):.*/\1/p' | sort -u | tr '\n' ' ')
      [ -n "$_missing" ] || _missing='(could not determine)'
      die "the Node runtime downloaded fine but cannot start on this system.
Missing shared libraries: $_missing
Install the C/C++ runtime it needs, then re-run this installer:
  Alpine:        sudo apk add libstdc++ libgcc
  Debian/Ubuntu: sudo apt-get install -y libstdc++6
Or install Node >= $MIN_NODE_MAJOR yourself (the installer will use it):
  Alpine:        sudo apk add nodejs
  Debian/Ubuntu: sudo apt-get install -y nodejs"
      ;;
  esac
}

ensure_node() {
  # A private runtime from an earlier run wins over an old system Node.
  if [ -x "$RUNTIME_DIR/node/bin/node" ] && \
     [ "$(node_major "$RUNTIME_DIR/node/bin/node")" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    NODE_BIN="$RUNTIME_DIR/node/bin/node"
    step "using the private Node runtime ($("$NODE_BIN" --version))"
    return 0
  fi

  if have node; then
    _sys=$(command -v node)
    _maj=$(node_major "$_sys")
    if [ -n "$_maj" ] && [ "$_maj" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
      NODE_BIN="$_sys"
      step "using system Node $("$_sys" --version) ($_sys)"
      return 0
    fi
    step "system Node is too old (need >= $MIN_NODE_MAJOR)"
  fi

  download_node
}

resolve_npm_dist() {
  if [ -n "$WANT_VERSION" ]; then
    _url="$NPM_REGISTRY/$NPM_PACKAGE_URLSAFE/$WANT_VERSION"
  else
    _url="$NPM_REGISTRY/$NPM_PACKAGE_URLSAFE/latest"
  fi
  step "resolving ${WANT_VERSION:-latest} from the npm registry"
  # Keep the transport's own error: "could not reach the registry" is not
  # actionable, whereas curl's message distinguishes DNS failure, a proxy
  # rejection, and the missing-CA-bundle case that every minimal container hits.
  _json=$(fetch_stdout "$_url" 2>"$TMP_DIR/registry.err") || {
    _why=$(head -3 "$TMP_DIR/registry.err" 2>/dev/null | tr '\n' ' ')
    die "could not reach the npm registry at $NPM_REGISTRY.
${_why:+Transport said: $_why}
Common causes:
  - no CA certificates (minimal containers): apk add ca-certificates / apt-get install -y ca-certificates
  - a proxy: export HTTPS_PROXY=http://host:port before running this script
  - an internal mirror: export RAYU_NPM_REGISTRY=https://your-mirror/repository/npm"
  }

  # Newline-per-field so the sed extractions below cannot span JSON keys.
  _flat=$(printf '%s' "$_json" | tr ',{}' '\n\n\n')
  TARBALL_URL=$(printf '%s\n' "$_flat" | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p' | head -1)
  TARBALL_SHA1=$(printf '%s\n' "$_flat" | sed -n 's/.*"shasum":"\([0-9a-f]*\)".*/\1/p' | head -1)
  [ -n "$TARBALL_URL" ] || die "the npm registry returned no tarball for ${WANT_VERSION:-latest}"

  # The tarball filename is the authoritative version (rayu-cli-1.6.13.tgz).
  _file=${TARBALL_URL##*/}
  INSTALLED_VERSION=$(printf '%s' "$_file" | sed -n 's/^rayu-cli-\(.*\)\.tgz$/\1/p')
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION=$(printf '%s\n' "$_flat" \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$INSTALLED_VERSION" ] || INSTALLED_VERSION="${WANT_VERSION:-unknown}"
}

# dist/rayu.js is an ES module. Node decides CommonJS-vs-ESM for a `.js` file
# from the nearest package.json `type`, so the bundle MUST be accompanied by one
# — exactly as the published npm package does it. Without this, Node parses it as
# CommonJS and dies with "Cannot use import statement outside a module" on every
# Node before 22.7, which is when ESM syntax detection became the default. That
# is Node 18 and 20 — i.e. what Debian 12, Ubuntu 22.04/24.04 and Alpine ship.
write_module_marker() {
  printf '{\n  "type": "module",\n  "//": "Required so Node loads rayu.js as an ES module on Node < 22.7."\n}\n' \
    >"$1/package.json"
}

install_from_tarball() {
  resolve_npm_dist
  ensure_node

  fetch_file_progress "$TARBALL_URL" "$TMP_DIR/pkg.tgz" "rayu-cli $INSTALLED_VERSION" \
    || die "failed to download $TARBALL_URL"
  step "verifying the package checksum"
  verify_checksum "$TMP_DIR/pkg.tgz" "$TARBALL_SHA1" sha1 "rayu-cli-$INSTALLED_VERSION.tgz"

  step "unpacking the bundle"
  mkdir -p "$TMP_DIR/pkg"
  tar -xzf "$TMP_DIR/pkg.tgz" -C "$TMP_DIR/pkg" \
    || die "failed to extract the package (is 'tar' working?)"

  _entry="$TMP_DIR/pkg/package/dist/rayu.js"
  [ -f "$_entry" ] || die "the published package is missing dist/rayu.js — please report this at
  https://github.com/$GITHUB_REPO/issues"

  # Stage the whole version directory, then swap it in. `rayu` keeps working
  # (from the previous version) if anything above failed.
  _target="$LIB_DIR/rayu-$INSTALLED_VERSION"
  mkdir -p "$LIB_DIR"
  rm -rf "$_target.tmp" "$_target"
  mkdir -p "$_target.tmp"
  cp "$_entry" "$_target.tmp/rayu.js"
  write_module_marker "$_target.tmp"
  for _extra in README.md; do
    [ -f "$TMP_DIR/pkg/package/$_extra" ] && cp "$TMP_DIR/pkg/package/$_extra" "$_target.tmp/" || true
  done
  mv "$_target.tmp" "$_target"

  # lib/current is the only path the launcher knows, so version switching is a
  # single atomic-enough symlink swap (`ln -sfn` replaces the link itself rather
  # than writing through it, on both GNU coreutils and BSD/macOS).
  ln -sfn "$_target" "$LIB_DIR/current"

  write_launcher
  prune_old_versions "$_target"
  INSTALL_METHOD=tarball
}

# The launcher is a tiny sh script rather than a symlink so that it can pin the
# Node it was installed with, fall back to whatever Node is on PATH if that one
# disappears, and route `rayu update` back through this installer (the built-in
# updater would shell out to `npm install -g`, which would install a *second*
# copy that this launcher does not use).
write_launcher() {
  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/rayu.tmp" <<LAUNCHER
#!/bin/sh
# Rayu CLI launcher — generated by the rayucode.com installer. Do not edit;
# it is rewritten on every install/update.
RAYU_HOME="\${RAYU_HOME:-$RAYU_HOME}"
ENTRY="$LIB_DIR/current/rayu.js"
NODE="$NODE_BIN"

if [ ! -x "\$NODE" ]; then
  NODE="\$(command -v node 2>/dev/null || true)"
fi
if [ -z "\$NODE" ] || [ ! -x "\$NODE" ]; then
  echo "rayu: the Node runtime at $NODE_BIN is gone and no 'node' is on PATH." >&2
  echo "rayu: reinstall with: curl -fsSL $INSTALLER_URL | bash" >&2
  exit 127
fi
if [ ! -f "\$ENTRY" ]; then
  echo "rayu: install is incomplete (\$ENTRY missing)." >&2
  echo "rayu: reinstall with: curl -fsSL $INSTALLER_URL | bash" >&2
  exit 127
fi

# 'rayu update' must go through the installer that owns this install.
if [ "\${1:-}" = "update" ] || [ "\${1:-}" = "upgrade" ]; then
  if [ -x "$BIN_DIR/.rayu-installer" ]; then
    shift
    echo "Updating Rayu CLI with the rayucode.com installer..."
    exec "$BIN_DIR/.rayu-installer" "\$@"
  fi
fi

exec "\$NODE" "\$ENTRY" "\$@"
LAUNCHER
  chmod 755 "$BIN_DIR/rayu.tmp"
  mv -f "$BIN_DIR/rayu.tmp" "$BIN_DIR/rayu"

  # Keep a copy of this installer so `rayu update` works offline of the website
  # and so --uninstall is always available locally.
  if [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "bash" ]; then
    cp "$0" "$BIN_DIR/.rayu-installer" 2>/dev/null && chmod 755 "$BIN_DIR/.rayu-installer" || true
  fi
  if [ ! -x "$BIN_DIR/.rayu-installer" ]; then
    # Piped from curl: $0 is not a readable file, so fetch a copy.
    fetch_file "$INSTALLER_URL" "$BIN_DIR/.rayu-installer" 2>/dev/null \
      && chmod 755 "$BIN_DIR/.rayu-installer" || true
  fi
}

# Keep the current version only; old bundles are ~24 MB each.
prune_old_versions() {
  _keep="$1"
  for _d in "$LIB_DIR"/rayu-*; do
    [ -d "$_d" ] || continue
    [ "$_d" = "$_keep" ] && continue
    rm -rf "$_d"
  done
}

# ---------------------------------------------------------------------------
# PATH wiring
# ---------------------------------------------------------------------------

add_to_profile() {
  _file="$1"; _line="$2"
  [ -f "$_file" ] || return 1
  if grep -qF "$PROFILE_MARKER_BEGIN" "$_file" 2>/dev/null; then
    return 2 # already managed by us
  fi
  printf '\n%s\n%s\n%s\n' "$PROFILE_MARKER_BEGIN" "$_line" "$PROFILE_MARKER_END" >>"$_file"
  return 0
}

setup_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) PATH_ALREADY_ACTIVE=1 ;;
    *) PATH_ALREADY_ACTIVE=0 ;;
  esac

  [ "$MODIFY_PATH" -eq 1 ] || return 0

  _posix_line="export PATH=\"$BIN_DIR:\$PATH\""
  _fish_line="fish_add_path -g \"$BIN_DIR\""
  PROFILES_UPDATED=''
  PROFILES_MANAGED=''

  # ~/.profile is created when absent so a login shell always finds Rayu.
  [ -f "$HOME/.profile" ] || [ -f "$HOME/.bash_profile" ] || : >"$HOME/.profile"

  for _f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.profile"; do
    _rc=0
    add_to_profile "$_f" "$_posix_line" || _rc=$?
    if [ "$_rc" -eq 0 ]; then
      PROFILES_UPDATED="$PROFILES_UPDATED $_f"
    elif [ "$_rc" -eq 2 ]; then
      PROFILES_MANAGED="$PROFILES_MANAGED $_f"
    fi
  done

  if [ -d "$HOME/.config/fish" ]; then
    _fc="$HOME/.config/fish/config.fish"
    [ -f "$_fc" ] || : >"$_fc"
    _rc=0
    add_to_profile "$_fc" "$_fish_line" || _rc=$?
    [ "$_rc" -eq 0 ] && PROFILES_UPDATED="$PROFILES_UPDATED $_fc"
  fi
}

# ---------------------------------------------------------------------------
# Post-install verification
# ---------------------------------------------------------------------------

write_metadata() {
  mkdir -p "$RAYU_HOME"
  cat >"$RAYU_HOME/install.json" <<META
{
  "installer": "rayucode.com/install",
  "method": "$INSTALL_METHOD",
  "version": "$INSTALLED_VERSION",
  "platform": "$NATIVE_PLATFORM",
  "binDir": "$BIN_DIR",
  "node": "${NODE_BIN:-embedded}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
}
META

  # Same marker the npm postinstall writes, so the CLI does not replay its
  # "installed successfully" banner on the first run — this script already
  # printed the equivalent, with accurate next steps.
  _cfg="${RAYU_CONFIG_DIR:-$HOME/.rayu}"
  mkdir -p "$_cfg" 2>/dev/null || true
  [ -f "$_cfg/.installed" ] || printf '%s\n' "$INSTALLED_VERSION" >"$_cfg/.installed" 2>/dev/null || true
}

verify_install() {
  step "verifying the install"
  _out=$("$BIN_DIR/rayu" --version 2>&1) || {
    # A dynamic-linker failure here means the runtime is unusable, not that Rayu
    # is broken — say what to install instead of asking for a bug report.
    case "$_out" in
      *'shared library'*|*'relocating'*|*'not found'*)
        die "Rayu was installed to $BIN_DIR/rayu but its runtime cannot start:

$_out

Install the missing system libraries, or install Node >= $MIN_NODE_MAJOR and
re-run this installer:
  Alpine:        sudo apk add libstdc++ libgcc   # or: sudo apk add nodejs
  Debian/Ubuntu: sudo apt-get install -y libstdc++6"
        ;;
    esac
    printf '%s\n' "$_out" >&2
    die "'$BIN_DIR/rayu --version' failed. Nothing else was changed; please report
this output at https://github.com/$GITHUB_REPO/issues"
  }
  REPORTED_VERSION=$(printf '%s' "$_out" | head -1)
}

# Another copy of `rayu` earlier on PATH (typically a previous
# `npm install -g`) would keep winning, so say so explicitly.
warn_if_shadowed() {
  have rayu || return 0
  _found=$(command -v rayu 2>/dev/null || true)
  [ -n "$_found" ] || return 0
  [ "$_found" = "$BIN_DIR/rayu" ] && return 0
  warn "another 'rayu' is earlier on your PATH and will be used instead:
  $_found
Remove it so the new install takes effect:
  npm uninstall -g $NPM_PACKAGE
(or delete $_found)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

detect_platform
[ "$DO_UNINSTALL" -eq 1 ] && do_uninstall

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t rayu) \
  || die "could not create a temporary directory"

have tar || die "need 'tar'. Install it and re-run:
  Debian/Ubuntu: sudo apt-get install -y tar
  Alpine:        sudo apk add tar"

title "Rayu CLI installer"
field platform "$NATIVE_PLATFORM$([ "$LIBC" = musl ] && printf ' (musl)' || true)"
info ""

INSTALL_METHOD=''
INSTALLED_VERSION=''
NODE_BIN=''

if [ "$DO_LOCAL" -eq 1 ]; then
  try_install_local
  ok "installed from a local build"
elif try_install_native; then
  ok "installed the standalone $NATIVE_PLATFORM binary"
else
  [ "$FORCE_TARBALL" -eq 1 ] || step "no standalone build for $NATIVE_PLATFORM yet ${C_DIM}— using the bundled JS build${C_RESET}"
  install_from_tarball
fi

setup_path
write_metadata
verify_install

case "$INSTALL_METHOD" in
  native) _method_label="standalone binary" ;;
  tarball) _method_label="bundled JS build" ;;
  local-binary) _method_label="local binary" ;;
  local-bundle) _method_label="local bundle" ;;
  *) _method_label="$INSTALL_METHOD" ;;
esac

title "${C_GREEN}${MARK_OK}${C_RESET}${C_BOLD} Rayu CLI $INSTALLED_VERSION installed${C_RESET}"
field version "$REPORTED_VERSION"
field command "$BIN_DIR/rayu"
field method "$_method_label"
[ -n "$NODE_BIN" ] && field runtime "$NODE_BIN"
info ""

if [ "$PATH_ALREADY_ACTIVE" -eq 1 ]; then
  info "  Run it now:"
  info "      ${C_BOLD}${C_CYAN}rayu${C_RESET}"
elif [ "$MODIFY_PATH" -eq 0 ]; then
  info "  PATH was left untouched (--no-modify-path). Add this yourself:"
  info "      ${C_BOLD}export PATH=\"$BIN_DIR:\$PATH\"${C_RESET}"
else
  if [ -n "${PROFILES_UPDATED:-}" ]; then
    info "  ${C_DIM}PATH updated in:${PROFILES_UPDATED}${C_RESET}"
  elif [ -n "${PROFILES_MANAGED:-}" ]; then
    info "  ${C_DIM}PATH entry already present in:${PROFILES_MANAGED}${C_RESET}"
  fi
  info ""
  info "  Open a new terminal — or run this once in the current one:"
  info "      ${C_BOLD}export PATH=\"$BIN_DIR:\$PATH\"${C_RESET}"
  info ""
  info "  Then start Rayu:"
  info "      ${C_BOLD}${C_CYAN}rayu${C_RESET}"
fi

info ""
info "  ${C_DIM}update     rayu update   (or re-run this installer)"
info "  uninstall  curl -fsSL $INSTALLER_URL | bash -s -- --uninstall"
info "  docs       https://rayucode.com/docs${C_RESET}"
info ""

warn_if_shadowed
