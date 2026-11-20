#!/usr/bin/env bash
# RayuCode CLI (v3 Rust) — universal installer for Linux, macOS, and Git Bash.
# rayu-installer-api: 2
#
#   curl -fsSL https://rayucode.com/install | bash
#   curl -fsSL https://rayucode.com/install.sh | bash
#
# Need the legacy Node/Bun v2 CLI instead?
#   curl -fsSL https://rayucode.com/install-rayu-legacy.sh | bash
set -euo pipefail

REPO="${RAYU_RELEASE_REPO:-Choeng-Rayu/rayucode-v2-releases}"
RELEASE_METADATA_BASE="${RAYU_RELEASE_METADATA_BASE:-https://raw.githubusercontent.com/$REPO/main/releases}"
LEGACY_INSTALLER_URL="${RAYU_LEGACY_INSTALLER_URL:-https://rayucode.com/install-rayu-legacy.sh}"
NPM_LEGACY_PACKAGE="@rayu-dev/rayu-cli"

IS_WINDOWS=false
IS_TERMUX=false
INSTALL_STAGE="startup"
INSTALL_SUCCEEDED=0
INSTALL_OS="unknown"
INSTALL_ARCH="unknown"
INSTALL_VERSION="unknown"
tmpdir=""

WANT_VERSION="${RAYU_VERSION:-}"
MODIFY_PATH=1
QUIET=0
DO_UNINSTALL=0
LEGACY_ACTION="ask"
if [ "${RAYU_REMOVE_LEGACY:-0}" = "1" ]; then
  LEGACY_ACTION="remove"
elif [ "${RAYU_KEEP_LEGACY:-0}" = "1" ]; then
  LEGACY_ACTION="keep"
fi

info() { [ "$QUIET" -eq 1 ] || printf '\033[1;34m%s\033[0m\n' "$*"; }
ok()   { [ "$QUIET" -eq 1 ] || printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
RayuCode CLI installer (v3 Rust — Linux / macOS / Git Bash)

  curl -fsSL https://rayucode.com/install | bash

Options:
  --version <v>      install an exact v3.x release tag (e.g. v3.0.0)
  --dir <path>       launcher directory (default: ~/.local/bin)
  --no-modify-path   do not modify shell startup profiles
  --remove-legacy    automatically uninstall legacy Node rayu (rayu-legacy) after upgrade
  --keep-legacy      keep legacy Node rayu as rayu-legacy without prompting
  --uninstall        uninstall RayuCode binaries (keeps user settings in ~/.rayu)
  --quiet, -q        reduce output (implies non-interactive)
  --help, -h         show this help message

Legacy Node v2 CLI:
  curl -fsSL $LEGACY_INSTALLER_URL | bash

Environment:
  RAYU_INSTALL_DIR, RAYU_HOME, RAYU_VERSION, RAYU_RELEASE_REPO,
  RAYU_RELEASE_METADATA_BASE, RAYU_REMOVE_LEGACY, RAYU_KEEP_LEGACY
USAGE
  exit 0
}

EXPLICIT_VERSION_ARG=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || err "--version requires a value"
      WANT_VERSION="$2"
      EXPLICIT_VERSION_ARG=1
      shift 2
      ;;
    --version=*)
      WANT_VERSION="${1#--version=}"
      EXPLICIT_VERSION_ARG=1
      shift
      ;;
    --dir)
      [ "$#" -ge 2 ] || err "--dir requires a path"
      RAYU_INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      RAYU_INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    --remove-legacy)
      LEGACY_ACTION="remove"
      shift
      ;;
    --keep-legacy)
      LEGACY_ACTION="keep"
      shift
      ;;
    --uninstall|--remove)
      DO_UNINSTALL=1
      shift
      ;;
    --quiet|-q)
      QUIET=1
      shift
      ;;
    --npm-tarball|--no-native)
      # Accepted for compatibility with legacy installer invocations.
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      err "Unknown option: $1 (try --help)"
      ;;
  esac
done

valid_release_tag() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([+.-][[:alnum:].-]+)?$'
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print tolower($NF)}'
  else
    return 1
  fi
}

valid_conversion_id() {
  printf '%s' "${RAYU_INSTALL_CONVERSION_ID:-}" |
    grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
}

telemetry_value() {
  printf '%s' "$1" | tr -cd '[:alnum:]_. -' | cut -c1-100
}

report_install_funnel() {
  stage="$1"
  outcome="$2"
  failure_stage="${3:-}"
  [ "${RAYU_TELEMETRY:-}" = "1" ] || return 0
  [ "${RAYU_NO_TELEMETRY:-}" != "1" ] || return 0
  [ "${DO_NOT_TRACK:-}" != "1" ] || return 0
  telemetry_url="${RAYU_TELEMETRY_URL:-}"
  [ -n "$telemetry_url" ] || return 0
  valid_conversion_id || return 0

  payload=$(printf '{"id":"%s","event":"install_funnel","version":"%s","os":"%s","arch":"%s","conversion_id":"%s","stage":"%s","outcome":"%s","source":"installer","install_method":"shell","failure_stage":"%s"}' \
    "$RAYU_INSTALL_CONVERSION_ID" \
    "$(telemetry_value "$INSTALL_VERSION")" \
    "$(telemetry_value "$INSTALL_OS")" \
    "$(telemetry_value "$INSTALL_ARCH")" \
    "$RAYU_INSTALL_CONVERSION_ID" \
    "$(telemetry_value "$stage")" \
    "$(telemetry_value "$outcome")" \
    "$(telemetry_value "$failure_stage")")
  curl -fsS --max-time 2 -H 'Content-Type: application/json' \
    --data "$payload" "${telemetry_url%/}/v1/event" >/dev/null 2>&1 || true
}

persist_install_conversion_id() {
  [ "${RAYU_NO_TELEMETRY:-}" != "1" ] || return 0
  [ "${DO_NOT_TRACK:-}" != "1" ] || return 0
  valid_conversion_id || return 0
  rayu_home="${RAYU_HOME:-$HOME/.rayu}"
  mkdir -p "$rayu_home" 2>/dev/null || return 0
  (umask 077; printf '%s\n' "$RAYU_INSTALL_CONVERSION_ID" > "$rayu_home/install_conversion_id") \
    2>/dev/null || return 0
  chmod 600 "$rayu_home/install_conversion_id" 2>/dev/null || true
}

install_exit() {
  status=$?
  trap - EXIT
  set +e
  [ -z "$tmpdir" ] || rm -rf "$tmpdir"
  if [ "$DO_UNINSTALL" = "0" ]; then
    if [ "$INSTALL_SUCCEEDED" = "1" ] && [ "$status" = "0" ]; then
      report_install_funnel "installer_finish" "success" ""
    else
      report_install_funnel "installer_finish" "failure" "$INSTALL_STAGE"
    fi
  fi
  exit "$status"
}
trap install_exit EXIT

# ---------------------------------------------------------------------------
# Uninstall mode (--uninstall)
# ---------------------------------------------------------------------------

if [ "$DO_UNINSTALL" -eq 1 ]; then
  OS_UN="$(uname -s)"
  case "$OS_UN" in
    MINGW*|MSYS*|CYGWIN*)
      UN_RAYU_HOME="${RAYU_HOME:-${LOCALAPPDATA:?LOCALAPPDATA not set}/rayu}"
      UN_DIR="${RAYU_INSTALL_DIR:-$LOCALAPPDATA/rayu/bin}"
      rm -f "$UN_DIR/rayu.exe" "$UN_DIR/rayucode.exe"
      rm -rf "$UN_RAYU_HOME/builds"
      ;;
    *)
      UN_RAYU_HOME="${RAYU_HOME:-$HOME/.rayu}"
      UN_DIR="${RAYU_INSTALL_DIR:-$HOME/.local/bin}"
      rm -f "$UN_DIR/rayu" "$UN_DIR/rayucode"
      rm -rf "$UN_RAYU_HOME/builds"
      ;;
  esac
  ok "RayuCode binaries uninstalled. Your settings and sessions in $UN_RAYU_HOME were kept."
  exit 0
fi

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

INSTALL_STAGE="platform_detection"
OS="$(uname -s)"
ARCH="$(uname -m)"
INSTALL_OS="$OS"
INSTALL_ARCH="$ARCH"

if [ -n "${TERMUX_VERSION:-}" ] || [ "${PREFIX:-}" = "/data/data/com.termux/files/usr" ] || [ -d "/data/data/com.termux/files/usr" ]; then
  IS_TERMUX=true
fi

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)        ARTIFACT="rayu-linux-x86_64" ;;
      aarch64|arm64) ARTIFACT="rayu-linux-aarch64" ;;
      *)             err "Unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      arm64)  ARTIFACT="rayu-macos-aarch64" ;;
      x86_64) ARTIFACT="rayu-macos-x86_64" ;;
      *)      err "Unsupported macOS architecture: $ARCH" ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    IS_WINDOWS=true
    WINDOWS_ARCH=""
    # Git for Windows may itself be an emulated x64 process on Windows ARM64,
    # making `uname -m` report x86_64. Prefer any ARM64 OS environment signal.
    for candidate in "${PROCESSOR_ARCHITEW6432:-}" "${PROCESSOR_ARCHITECTURE:-}" "$ARCH"; do
      case "$candidate" in
        aarch64|AARCH64|arm64|Arm64|ARM64) WINDOWS_ARCH="aarch64"; break ;;
      esac
    done
    if [ -z "$WINDOWS_ARCH" ]; then
      for candidate in "${PROCESSOR_ARCHITEW6432:-}" "${PROCESSOR_ARCHITECTURE:-}" "$ARCH"; do
        case "$candidate" in
          x86_64|X64|AMD64) WINDOWS_ARCH="x86_64"; break ;;
        esac
      done
    fi
    case "$WINDOWS_ARCH" in
      x86_64)  ARTIFACT="rayu-windows-x86_64" ;;
      aarch64) ARTIFACT="rayu-windows-aarch64" ;;
      *)       err "Unsupported Windows architecture: $ARCH" ;;
    esac
    ;;
  *)
    err "Unsupported OS: $OS (check releases at https://github.com/$REPO/releases)"
    ;;
esac

report_install_funnel "installer_start" "success" ""

RAYU_HOME_DIR="${RAYU_HOME:-$HOME/.rayu}"
if [ "$IS_WINDOWS" = true ]; then
  INSTALL_DIR="${RAYU_INSTALL_DIR:-$LOCALAPPDATA/rayu/bin}"
  EXE=".exe"
  builds_dir="${LOCALAPPDATA}/rayu/builds"
else
  INSTALL_DIR="${RAYU_INSTALL_DIR:-$HOME/.local/bin}"
  EXE=""
  builds_dir="$RAYU_HOME_DIR/builds"
fi

# ---------------------------------------------------------------------------
# Release resolution
# ---------------------------------------------------------------------------

INSTALL_STAGE="release_lookup"
VERSION="$WANT_VERSION"
if [ -n "$VERSION" ]; then
  case "$VERSION" in
    v*) ;;
    *)  VERSION="v$VERSION" ;;
  esac
  # Legacy v2 auto-updaters invoke this installer with `--version 2.x.y`.
  # Upgrade seamlessly to the latest v3.x release unless explicitly opted out.
  if [ "$EXPLICIT_VERSION_ARG" -eq 1 ] && [ "${RAYU_ALLOW_LEGACY_TAG:-0}" != "1" ]; then
    req_major="${VERSION#v}"
    req_major="${req_major%%.*}"
    case "$req_major" in
      0|1|2)
        info "Requested legacy version $VERSION — upgrading to the latest RayuCode v3 (Rust) release."
        info "  (To install the legacy Node v2 CLI instead: curl -fsSL $LEGACY_INSTALLER_URL | bash)"
        VERSION=""
        ;;
    esac
  fi
fi

if [ -z "$VERSION" ]; then
  METADATA_VERSION=$(curl -fsSL --retry 2 --connect-timeout 10 \
    "$RELEASE_METADATA_BASE/latest/version" 2>/dev/null | tr -d '\r\n' || true)
  LATEST_RELEASE_URL=$(curl -fsSIL --retry 2 --connect-timeout 10 \
    -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)
  case "$LATEST_RELEASE_URL" in
    */releases/tag/*) GITHUB_VERSION="${LATEST_RELEASE_URL##*/}" ;;
    *) GITHUB_VERSION="" ;;
  esac
  if valid_release_tag "$GITHUB_VERSION"; then
    VERSION="$GITHUB_VERSION"
  elif valid_release_tag "$METADATA_VERSION"; then
    VERSION="$METADATA_VERSION"
    info "GitHub release lookup unavailable; using fallback release metadata ($VERSION)."
  fi
fi
valid_release_tag "$VERSION" || err "Failed to determine latest version"
INSTALL_VERSION="${VERSION#v}"

GITHUB_RELEASE_BASE="https://github.com/$REPO/releases/download/$VERSION"

stable_dir="$builds_dir/stable"
current_dir="$builds_dir/current"
version_dir="$builds_dir/versions"
launcher_path="$INSTALL_DIR/rayu${EXE}"
alias_path="$INSTALL_DIR/rayucode${EXE}"

EXISTING=""
if [ -x "$launcher_path" ]; then
  EXISTING=$("$launcher_path" --version 2>/dev/null | head -1 || echo "unknown")
fi

if [ -n "$EXISTING" ]; then
  if echo "$EXISTING" | grep -qF "${VERSION#v}"; then
    info "rayu $VERSION is already installed — reinstalling"
  else
    info "Updating rayu $EXISTING → $VERSION"
  fi
else
  info "Installing rayu $VERSION"
fi
info "  launcher: $launcher_path"

tmpdir=$(mktemp -d)

# ---------------------------------------------------------------------------
# Artifact download & SHA-256 verification (before touching any legacy files!)
# ---------------------------------------------------------------------------

INSTALL_STAGE="artifact_download"
download_mode=""
downloaded_asset=""
DOWNLOAD_BASES=$(curl -fsSL --retry 2 --connect-timeout 10 \
  "$RELEASE_METADATA_BASE/$VERSION/download-bases" 2>/dev/null || true)
DOWNLOAD_BASES=$(printf '%s\n%s\n' "$DOWNLOAD_BASES" "$GITHUB_RELEASE_BASE" |
  awk '/^https:\/\/[^[:space:]]+$/ && !seen[$0]++')

for candidate in "$ARTIFACT.tar.gz" "$ARTIFACT$EXE"; do
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    if curl -fsSL --retry 2 --connect-timeout 10 \
      "${base%/}/$candidate" -o "$tmpdir/rayu.download" 2>/dev/null; then
      downloaded_asset="$candidate"
      case "$candidate" in
        *.tar.gz) download_mode="tar" ;;
        *)        download_mode="bin" ;;
      esac
      break 2
    fi
  done <<EOF
$DOWNLOAD_BASES
EOF
done

if [ -n "$download_mode" ]; then
  INSTALL_STAGE="artifact_verification"
  EXPECTED_SHA256=""
  for checksum_url in \
    "$RELEASE_METADATA_BASE/$VERSION/SHA256SUMS" \
    "$GITHUB_RELEASE_BASE/SHA256SUMS"; do
    CHECKSUMS=$(curl -fsSL --retry 2 --connect-timeout 10 \
      "$checksum_url" 2>/dev/null || true)
    EXPECTED_SHA256=$(printf '%s\n' "$CHECKSUMS" |
      awk -v asset="$downloaded_asset" '$2 == asset || $2 == "*" asset { print tolower($1); exit }')
    if printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
      break
    fi
    EXPECTED_SHA256=""
  done
  printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
    || err "Could not find a trusted SHA-256 checksum for $downloaded_asset in $VERSION"
  ACTUAL_SHA256=$(sha256_file "$tmpdir/rayu.download") \
    || err "sha256sum, shasum, or openssl is required to verify the download"
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] \
    || err "SHA-256 verification failed for $downloaded_asset"
  info "Verified SHA-256: $downloaded_asset"
fi

# ---------------------------------------------------------------------------
# Binary installation
# ---------------------------------------------------------------------------

INSTALL_STAGE="binary_install"
mkdir -p "$INSTALL_DIR" "$stable_dir" "$current_dir" "$version_dir"

version="${VERSION#v}"
dest_version_dir="$version_dir/$version"
mkdir -p "$dest_version_dir"

bin_name="rayu${EXE}"
notices_source=""

if [ "$download_mode" = "tar" ]; then
  tar xzf "$tmpdir/rayu.download" -C "$tmpdir"
  src_bin="$tmpdir/${ARTIFACT}${EXE}"
  [ -f "$src_bin" ] || err "Downloaded archive did not contain expected binary: ${ARTIFACT}${EXE}"
  find "$tmpdir" -maxdepth 1 -type f \( -name "${ARTIFACT}${EXE}.bin" -o -name 'libssl.so*' -o -name 'libcrypto.so*' \) \
    -exec cp -f {} "$dest_version_dir/" \;
  mv "$src_bin" "$dest_version_dir/$bin_name"
  notices_source="$tmpdir"
elif [ "$download_mode" = "bin" ]; then
  mv "$tmpdir/rayu.download" "$dest_version_dir/$bin_name"
else
  if [ "${RAYU_ALLOW_SOURCE_BUILD:-0}" != "1" ]; then
    err "No prebuilt binary found for $ARTIFACT in $VERSION. Check available downloads at https://github.com/$REPO/releases"
  fi
  info "No prebuilt asset found for $ARTIFACT in $VERSION; building from source..."
  command -v git >/dev/null 2>&1 || err "git is required to build from source"
  command -v cargo >/dev/null 2>&1 || err "cargo is required to build from source"

  src_dir="$tmpdir/rayu-src"
  git clone --depth 1 --branch "$VERSION" "https://github.com/$REPO.git" "$src_dir" \
    || err "Failed to clone $REPO at $VERSION"
  cargo build --release --manifest-path "$src_dir/Cargo.toml" \
    || err "cargo build failed while building $REPO from source"

  src_bin="$src_dir/target/release/$bin_name"
  [ -f "$src_bin" ] || err "Built binary not found at $src_bin"
  cp "$src_bin" "$dest_version_dir/$bin_name"
  notices_source="$src_dir"
fi

for notice in LICENSE THIRD_PARTY_NOTICES dependency-inventory.json; do
  if [ -n "$notices_source" ] && [ -f "$notices_source/$notice" ]; then
    cp -f "$notices_source/$notice" "$dest_version_dir/$notice"
  fi
done

chmod +x "$dest_version_dir/$bin_name" 2>/dev/null || true

if [ "$IS_TERMUX" = true ] && [ "$IS_WINDOWS" = false ]; then
  termux_glibc_dir="/data/data/com.termux/files/usr/glibc/lib"
  termux_glibc_linker=""
  case "$ARCH" in
    aarch64|arm64) termux_glibc_linker="$termux_glibc_dir/ld-linux-aarch64.so.1" ;;
    x86_64)        termux_glibc_linker="$termux_glibc_dir/ld-linux-x86-64.so.2" ;;
  esac
  if [ "$OS" = "Linux" ] && [ -n "$termux_glibc_linker" ]; then
    if [ -x "$termux_glibc_linker" ]; then
      if command -v patchelf >/dev/null 2>&1; then
        patchelf --set-interpreter "$termux_glibc_linker" "$dest_version_dir/$bin_name" \
          || err "Failed to patch rayu ELF interpreter for Termux glibc"
        info "Patched Termux glibc ELF interpreter: $termux_glibc_linker"
      else
        info "Termux detected: install patchelf with 'pkg install patchelf' and rerun this installer if rayu fails to start."
      fi
    else
      info "Termux detected: install glibc with 'pkg install glibc' if rayu fails due to a missing dynamic linker."
    fi
  fi
fi

if [ "$IS_WINDOWS" = true ]; then
  cp -f "$dest_version_dir/$bin_name" "$stable_dir/$bin_name"
  for notice in LICENSE THIRD_PARTY_NOTICES dependency-inventory.json; do
    if [ -f "$dest_version_dir/$notice" ]; then
      cp -f "$dest_version_dir/$notice" "$stable_dir/$notice"
    fi
  done
  printf '%s\n' "$version" > "$builds_dir/stable-version"
  cp -f "$stable_dir/$bin_name" "$launcher_path"
  cp -f "$stable_dir/$bin_name" "$alias_path"
else
  ln -sfn "$dest_version_dir/$bin_name" "$stable_dir/$bin_name"
  printf '%s\n' "$version" > "$builds_dir/stable-version"
  if [ "$IS_TERMUX" = true ]; then
    rm -f "$launcher_path" "$alias_path"
    cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
unset LD_PRELOAD
exec "$stable_dir/$bin_name" "\$@"
EOF
    chmod +x "$launcher_path"
    ln -sfn "$launcher_path" "$alias_path"
  else
    ln -sfn "$stable_dir/$bin_name" "$launcher_path"
    ln -sfn "$stable_dir/$bin_name" "$alias_path"
  fi
fi

if [ "$(uname -s)" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$dest_version_dir/$bin_name" 2>/dev/null || true
  if "$launcher_path" setup-launcher </dev/null >/dev/null 2>&1; then
    info "Installed macOS turn-notification helper."
  fi
fi

hotkey_setup_ready=false
case "$(uname -s)" in
Darwin|Linux)
  if "$launcher_path" setup-hotkey </dev/null >/dev/null 2>&1; then
    hotkey_setup_ready=true
  fi
  ;;
esac

# Gracefully retire any background server running the old Rust binary.
INSTALL_STAGE="server_reload"
if [ "${RAYU_SKIP_SERVER_RELOAD:-}" != "1" ]; then
  reload_bin="$launcher_path"
  [ -x "$reload_bin" ] || reload_bin="$stable_dir/$bin_name"
  if [ -x "$reload_bin" ]; then
    if "$reload_bin" server reload </dev/null >/dev/null 2>&1; then
      info "Reloaded the running rayu server onto $VERSION (if one was active)."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Legacy Node v2 CLI migration (runs ONLY after Rust v3 binary is installed!)
# ---------------------------------------------------------------------------

INSTALL_STAGE="legacy_migration"

LEGACY_FOUND=0
LEGACY_SCRIPT_FOUND=0
LEGACY_RENAMED_NOW=0
LEGACY_NPM_FOUND=0
LEGACY_VERSION=""
LEGACY_BIN_DIR="$RAYU_HOME_DIR/bin"
LEGACY_BIN_PATH=""
LEGACY_NPM_BIN_RENAMED=""
LEGACY_SHADOW_WARNING=""

read_legacy_install_json_field() {
  _json="$1"
  _key="$2"
  [ -f "$_json" ] || return 0
  sed -n "s/.*\"${_key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$_json" 2>/dev/null | head -n1 || true
}

write_guarded_legacy_launcher() {
  _target="$1"
  _node_bin="$2"
  _entry="$3"
  cat > "${_target}.tmp" <<LEGACY_LAUNCHER
#!/bin/sh
# Legacy Rayu CLI (Node v2) launcher — preserved as rayu-legacy during RayuCode v3 upgrade.
RAYU_HOME="\${RAYU_HOME:-$RAYU_HOME_DIR}"
ENTRY="$_entry"
NODE="$_node_bin"

if [ ! -x "\$NODE" ]; then
  NODE="\$(command -v node 2>/dev/null || true)"
fi
if [ -z "\$NODE" ] || [ ! -x "\$NODE" ]; then
  echo "rayu-legacy: Node runtime not found." >&2
  exit 127
fi
if [ ! -f "\$ENTRY" ]; then
  echo "rayu-legacy: legacy bundle missing (\$ENTRY)." >&2
  exit 127
fi

# Legacy launcher preserved as rayu-legacy; prevent self-update from overwriting rayu (rayucode-v2).
if [ "\${1:-}" = "update" ] || [ "\${1:-}" = "upgrade" ]; then
  echo "rayu-legacy: self-update is disabled because 'rayu' is now managed by RayuCode v3." >&2
  echo "rayu-legacy: run 'rayu update' to update RayuCode instead." >&2
  exit 1
fi

exec "\$NODE" "\$ENTRY" "\$@"
LEGACY_LAUNCHER
  chmod 755 "${_target}.tmp"
  mv -f "${_target}.tmp" "$_target"
}

remove_legacy_profile_block() {
  _file="$1"
  [ -f "$_file" ] || return 0
  grep -qF '# >>> rayu cli >>>' "$_file" 2>/dev/null || return 0
  _tmp="${_file}.rayu-legacy.$$"
  awk '
    index($0, "# >>> rayu cli >>>") { skip = 1; next }
    index($0, "# <<< rayu cli <<<") { skip = 0; next }
    !skip { print }
  ' "$_file" > "$_tmp" && cat "$_tmp" > "$_file" && rm -f "$_tmp"
}

migrate_legacy_node_cli() {
  _install_json="$RAYU_HOME_DIR/install.json"
  _json_bin_dir="$(read_legacy_install_json_field "$_install_json" "binDir")"
  _json_version="$(read_legacy_install_json_field "$_install_json" "version")"
  _json_node="$(read_legacy_install_json_field "$_install_json" "node")"
  if [ -n "$_json_bin_dir" ]; then
    LEGACY_BIN_DIR="$_json_bin_dir"
  fi
  if [ -n "$_json_version" ]; then
    LEGACY_VERSION="$_json_version"
  fi

  _legacy_entry="$RAYU_HOME_DIR/lib/current/rayu.js"
  _old_rayu="$LEGACY_BIN_DIR/rayu${EXE}"
  _legacy_rayu="$LEGACY_BIN_DIR/rayu-legacy${EXE}"
  _old_installer="$LEGACY_BIN_DIR/.rayu-installer"

  # 1. Detect legacy script-managed install (~/.rayu/bin/rayu or ~/.rayu/lib).
  if [ "$LEGACY_BIN_DIR" != "$INSTALL_DIR" ]; then
    if [ -e "$_old_rayu" ] || [ -L "$_old_rayu" ]; then
      # Confirm it is a legacy Node launcher, migrator binary, or paired with legacy metadata/lib.
      _is_legacy_old=0
      if [ -f "$_install_json" ] || [ -f "$_legacy_entry" ] || [ -d "$RAYU_HOME_DIR/lib" ]; then
        _is_legacy_old=1
      elif grep -qF "rayu.js" "$_old_rayu" 2>/dev/null || grep -qF "Rayu CLI launcher" "$_old_rayu" 2>/dev/null; then
        _is_legacy_old=1
      fi

      if [ "$_is_legacy_old" -eq 1 ]; then
        LEGACY_FOUND=1
        LEGACY_SCRIPT_FOUND=1
        if [ -z "$LEGACY_VERSION" ] && [ -x "$_old_rayu" ]; then
          LEGACY_VERSION=$("$_old_rayu" --version 2>/dev/null | head -n1 || true)
        fi
        mkdir -p "$LEGACY_BIN_DIR"
        if [ "$IS_WINDOWS" = false ] && [ -f "$_legacy_entry" ]; then
          # Preserve working legacy Node CLI as rayu-legacy with update guard,
          # and remove the old rayu path so ~/.local/bin/rayu wins on PATH.
          _node_candidate="${_json_node:-$RAYU_HOME_DIR/runtime/node/bin/node}"
          [ "$_node_candidate" != "embedded" ] || _node_candidate=""
          write_guarded_legacy_launcher "$_legacy_rayu" "$_node_candidate" "$_legacy_entry"
          rm -f "$_old_rayu"
        else
          mv -f "$_old_rayu" "$_legacy_rayu"
        fi
        rm -f "$_old_installer"
        LEGACY_RENAMED_NOW=1
        LEGACY_BIN_PATH="$_legacy_rayu"
      fi
    elif [ -e "$_legacy_rayu" ] || [ -L "$_legacy_rayu" ] || [ -f "$_legacy_entry" ] || [ -f "$_install_json" ]; then
      # Legacy install already renamed earlier (e.g. ~/.rayu/bin/rayu-legacy) or remnants remain.
      LEGACY_FOUND=1
      LEGACY_SCRIPT_FOUND=1
      rm -f "$_old_installer"
      if [ -e "$_legacy_rayu" ] || [ -L "$_legacy_rayu" ]; then
        LEGACY_BIN_PATH="$_legacy_rayu"
      elif [ "$IS_WINDOWS" = false ] && [ -f "$_legacy_entry" ]; then
        mkdir -p "$LEGACY_BIN_DIR"
        _node_candidate="${_json_node:-$RAYU_HOME_DIR/runtime/node/bin/node}"
        [ "$_node_candidate" != "embedded" ] || _node_candidate=""
        write_guarded_legacy_launcher "$_legacy_rayu" "$_node_candidate" "$_legacy_entry"
        LEGACY_RENAMED_NOW=1
        LEGACY_BIN_PATH="$_legacy_rayu"
      fi
    fi
  fi

  # 2. Detect global npm @rayu-dev/rayu-cli installation (if npm is installed).
  if [ "${RAYU_SKIP_NPM_CHECK:-0}" != "1" ] && command -v npm >/dev/null 2>&1; then
    _npm_ver=$(npm ls -g --depth=0 "$NPM_LEGACY_PACKAGE" 2>/dev/null \
      | sed -n "s/.*@rayu-dev\/rayu-cli@\([^[:space:]]*\).*/\1/p" | head -n1 || true)
    if [ -n "$_npm_ver" ]; then
      LEGACY_FOUND=1
      LEGACY_NPM_FOUND=1
      [ -n "$LEGACY_VERSION" ] || LEGACY_VERSION="npm $_npm_ver"

      # Check if npm's global `rayu` binary shadows our new launcher.
      _npm_prefix=$(npm config get prefix 2>/dev/null || true)
      _npm_bin=""
      if [ -n "$_npm_prefix" ] && [ -e "$_npm_prefix/bin/rayu" ]; then
        _npm_bin="$_npm_prefix/bin/rayu"
      fi
      if [ -n "$_npm_bin" ] && [ "$_npm_bin" != "$launcher_path" ] && [ "$_npm_bin" != "$_old_rayu" ]; then
        _npm_bin_dir=$(dirname "$_npm_bin")
        # If this is not already the 2.6.0 bridge (which ships rayu-legacy),
        # rename npm's rayu symlink -> rayu-legacy when writable so Rust rayu wins.
        if [ -w "$_npm_bin_dir" ] && [ ! -e "$_npm_bin_dir/rayu-legacy" ] && [ "${RAYU_FROM_NPM_POSTINSTALL:-0}" != "1" ] && [ -z "${npm_lifecycle_event:-}" ]; then
          if mv "$_npm_bin" "$_npm_bin_dir/rayu-legacy" 2>/dev/null; then
            LEGACY_RENAMED_NOW=1
            LEGACY_NPM_BIN_RENAMED="$_npm_bin_dir/rayu-legacy"
            [ -n "$LEGACY_BIN_PATH" ] || LEGACY_BIN_PATH="$LEGACY_NPM_BIN_RENAMED"
          fi
        elif [ -e "$_npm_bin_dir/rayu-legacy" ]; then
          [ -n "$LEGACY_BIN_PATH" ] || LEGACY_BIN_PATH="$_npm_bin_dir/rayu-legacy"
        else
          LEGACY_SHADOW_WARNING="$_npm_bin"
        fi
      fi
    fi
  fi
}

uninstall_legacy_node_cli() {
  if [ "$LEGACY_SCRIPT_FOUND" -eq 1 ]; then
    rm -f "$LEGACY_BIN_DIR/rayu-legacy${EXE}" "$LEGACY_BIN_DIR/.rayu-installer"
    rm -rf "$RAYU_HOME_DIR/lib" "$RAYU_HOME_DIR/runtime" "$RAYU_HOME_DIR/install.json"
    rmdir "$LEGACY_BIN_DIR" 2>/dev/null || true
    for _rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zshenv" \
               "$HOME/.profile" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
      remove_legacy_profile_block "$_rc"
    done
  fi

  if [ -n "$LEGACY_NPM_BIN_RENAMED" ] && [ -e "$LEGACY_NPM_BIN_RENAMED" ]; then
    rm -f "$LEGACY_NPM_BIN_RENAMED"
  fi

  if [ "$LEGACY_NPM_FOUND" -eq 1 ]; then
    if [ "${RAYU_FROM_NPM_POSTINSTALL:-0}" = "1" ] || [ -n "${npm_lifecycle_event:-}" ]; then
      warn "Running inside npm lifecycle; finish removing the legacy npm package with:"
      info "    npm uninstall -g $NPM_LEGACY_PACKAGE"
    elif command -v npm >/dev/null 2>&1; then
      if npm uninstall -g "$NPM_LEGACY_PACKAGE" >/dev/null 2>&1; then
        ok "Uninstalled global npm package $NPM_LEGACY_PACKAGE."
      else
        warn "Could not run 'npm uninstall -g $NPM_LEGACY_PACKAGE' automatically. Run it manually to finish cleanup."
      fi
    fi
  fi

  ok "✅ Removed rayu-legacy. Your settings, API keys, and sessions in $RAYU_HOME_DIR were kept."
}

migrate_legacy_node_cli

# ---------------------------------------------------------------------------
# PATH configuration & summary output
# ---------------------------------------------------------------------------

if [ "$IS_WINDOWS" = true ]; then
  INSTALL_STAGE="path_configuration"
  win_install_dir=$(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")

  win_path_persisted=false
  _win_path_key() { printf '%s' "$1" | sed 's|[\\/]*$||' | tr '[:upper:]' '[:lower:]'; }
  if [ "$MODIFY_PATH" -eq 1 ] && command -v powershell.exe >/dev/null 2>&1; then
    current_user_path=$(powershell.exe -NoProfile -NonInteractive -Command \
      "[Environment]::GetEnvironmentVariable('Path','User')" 2>/dev/null | tr -d '\r' || true)
    target_key=$(_win_path_key "$win_install_dir")
    new_user_path="$win_install_dir"
    set -f
    IFS=';'
    for entry in $current_user_path; do
      [ -n "$entry" ] || continue
      [ "$(_win_path_key "$entry")" = "$target_key" ] && continue
      new_user_path="$new_user_path;$entry"
    done
    unset IFS
    set +f
    if [ "$new_user_path" = "$current_user_path" ]; then
      win_path_persisted=true
    elif RAYU_NEW_USER_PATH="$new_user_path" powershell.exe -NoProfile -NonInteractive -Command \
      '[Environment]::SetEnvironmentVariable("Path", $env:RAYU_NEW_USER_PATH, "User")' >/dev/null 2>&1; then
      win_path_persisted=true
      win_broadcast_ps=$(cat <<'RAYU_PS_BROADCAST_EOF'
$sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$type = Add-Type -MemberDefinition $sig -Name 'RayuEnvBroadcast' -Namespace Win32 -PassThru
[UIntPtr]$result = [UIntPtr]::Zero
$type::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
RAYU_PS_BROADCAST_EOF
)
      powershell.exe -NoProfile -NonInteractive -Command "$win_broadcast_ps" >/dev/null 2>&1 || true
    fi
  fi

  [ "$QUIET" -eq 1 ] || echo ""
  ok "✅ rayu $VERSION installed successfully!"
  [ "$QUIET" -eq 1 ] || echo ""
  if [ "$win_path_persisted" = true ]; then
    info "Added $win_install_dir to your user PATH. New terminals will find rayu automatically."
  fi
  if command -v rayu >/dev/null 2>&1; then
    info "Run 'rayu' to get started."
  else
    if [ "$QUIET" -eq 0 ]; then
      echo "  To start using rayu in THIS terminal right now, run:"
      echo ""
      printf '    \033[1;32mexport PATH="%s:$PATH" && rayu\033[0m\n' "$INSTALL_DIR"
      if [ "$win_path_persisted" != true ]; then
        echo ""
        echo "  To add rayu to PATH permanently (PowerShell):"
        echo ""
        printf '    \033[1;32m[Environment]::SetEnvironmentVariable("Path", "%s;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")\033[0m\n' "$win_install_dir"
      fi
    fi
  fi
else
  INSTALL_STAGE="path_configuration"
  PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
  added_to=""

  _have() { command -v "$1" >/dev/null 2>&1; }

  ensure_posix_rc() {
    rc="$1"; create="$2"
    if [ ! -f "$rc" ]; then
      [ "$create" = "yes" ] || return 0
      mkdir -p "$(dirname "$rc")"
    fi
    if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
      printf '\n# Added by rayu installer\n%s\n' "$PATH_LINE" >> "$rc"
      added_to="$added_to $rc"
    fi
  }

  ensure_fish_rc() {
    create="$1"
    rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
    if [ ! -f "$rc" ]; then
      [ "$create" = "yes" ] || return 0
      mkdir -p "$(dirname "$rc")"
    fi
    if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
      {
        printf '\n# Added by rayu installer\n'
        printf 'if not contains "%s" $PATH\n' "$INSTALL_DIR"
        printf '    set -gx PATH "%s" $PATH\n' "$INSTALL_DIR"
        printf 'end\n'
      } >> "$rc"
      added_to="$added_to $rc"
    fi
  }

  if [ "$MODIFY_PATH" -eq 1 ]; then
    if _have zsh || [ "$(uname -s)" = "Darwin" ] || [ -f "$HOME/.zshenv" ] || [ -f "$HOME/.zshrc" ]; then
      ensure_posix_rc "$HOME/.zshenv" yes
    fi
    if _have bash || [ -f "$HOME/.bashrc" ] || [ -f "$HOME/.bash_profile" ]; then
      ensure_posix_rc "$HOME/.bashrc" yes
    fi
    ensure_posix_rc "$HOME/.profile" yes
    if _have fish || [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ]; then
      ensure_fish_rc yes
    fi
    for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile"; do
      ensure_posix_rc "$rc" no
    done
    if [ -n "$added_to" ]; then
      info "Added $INSTALL_DIR to PATH in:$added_to"
    fi
  fi

  [ "$QUIET" -eq 1 ] || echo ""
  ok "✅ rayu $VERSION installed successfully!"
  [ "$QUIET" -eq 1 ] || echo ""

  if [ "$(uname -s)" = "Darwin" ]; then
    if [ "$hotkey_setup_ready" = true ]; then
      info "Global hotkey ready: Cmd+; launches a new rayu from anywhere, system-wide"
    else
      info "Tip: run 'rayu setup-hotkey' so Cmd+; launches rayu system-wide on macOS"
    fi
  fi

  if command -v rayu >/dev/null 2>&1; then
    info "Run 'rayu' to get started."
  elif [ "$QUIET" -eq 0 ]; then
    echo "  To start using rayu right now, run:"
    echo ""
    printf '    \033[1;32mexport PATH="%s:\$PATH" && rayu\033[0m\n' "$INSTALL_DIR"
    echo ""
    echo "  Future terminal sessions will have rayu on PATH automatically."
  fi
fi

# ---------------------------------------------------------------------------
# Post-install legacy migration status & interactive removal prompt
# ---------------------------------------------------------------------------

if [ "$LEGACY_FOUND" -eq 1 ]; then
  _legacy_label="legacy Node Rayu"
  [ -z "$LEGACY_VERSION" ] || _legacy_label="legacy Node Rayu ($LEGACY_VERSION)"
  if [ "$QUIET" -eq 0 ]; then
    echo ""
    info "Migration status:"
    if [ "$LEGACY_RENAMED_NOW" -eq 1 ]; then
      info "  • Your old $_legacy_label was renamed to: rayu-legacy"
    else
      info "  • Existing $_legacy_label detected as: rayu-legacy"
    fi
    [ -z "$LEGACY_BIN_PATH" ] || info "    Location: $LEGACY_BIN_PATH"
    info "  • New RayuCode $VERSION (Rust) is installed at: $launcher_path"
    info "  • Your settings, API keys, and sessions in $RAYU_HOME_DIR were preserved."
    if [ -n "$LEGACY_SHADOW_WARNING" ]; then
      warn "Another legacy 'rayu' binary exists at $LEGACY_SHADOW_WARNING and may shadow $launcher_path."
      info "  Remove it with: npm uninstall -g $NPM_LEGACY_PACKAGE"
    fi
    echo ""
  fi

  if [ "$LEGACY_ACTION" = "remove" ]; then
    uninstall_legacy_node_cli
  elif [ "$LEGACY_ACTION" = "keep" ] || [ "$QUIET" -eq 1 ] || [ -n "${CI:-}" ]; then
    if [ "$QUIET" -eq 0 ]; then
      info "Kept rayu-legacy. You can still run the old CLI with 'rayu-legacy'."
      info "To uninstall rayu-legacy later, run:"
      [ "$LEGACY_SCRIPT_FOUND" -eq 0 ] || info "  curl -fsSL $LEGACY_INSTALLER_URL | bash -s -- --uninstall"
      [ "$LEGACY_NPM_FOUND" -eq 0 ] || info "  npm uninstall -g $NPM_LEGACY_PACKAGE"
    fi
  else
    _prompt_done=0
    _reply=""
    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
      printf 'Do you want to uninstall rayu-legacy now? [y/N] ' >/dev/tty
      IFS= read -r _reply </dev/tty || _reply=""
      _prompt_done=1
    elif [ -t 0 ]; then
      printf 'Do you want to uninstall rayu-legacy now? [y/N] '
      IFS= read -r _reply || _reply=""
      _prompt_done=1
    fi

    if [ "$_prompt_done" -eq 1 ]; then
      case "$_reply" in
        y|Y|yes|YES|Yes)
          uninstall_legacy_node_cli
          ;;
        *)
          info "Kept rayu-legacy. You can still run the old CLI with 'rayu-legacy'."
          info "To uninstall rayu-legacy later, run:"
          [ "$LEGACY_SCRIPT_FOUND" -eq 0 ] || info "  curl -fsSL $LEGACY_INSTALLER_URL | bash -s -- --uninstall"
          [ "$LEGACY_NPM_FOUND" -eq 0 ] || info "  npm uninstall -g $NPM_LEGACY_PACKAGE"
          ;;
      esac
    else
      info "Kept rayu-legacy (non-interactive shell). To uninstall it later, run:"
      [ "$LEGACY_SCRIPT_FOUND" -eq 0 ] || info "  curl -fsSL $LEGACY_INSTALLER_URL | bash -s -- --uninstall"
      [ "$LEGACY_NPM_FOUND" -eq 0 ] || info "  npm uninstall -g $NPM_LEGACY_PACKAGE"
    fi
  fi
fi

persist_install_conversion_id
INSTALL_STAGE="complete"
INSTALL_SUCCEEDED=1
