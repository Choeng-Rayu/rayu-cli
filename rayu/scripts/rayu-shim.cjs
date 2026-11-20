#!/usr/bin/env node
'use strict';

/**
 * Rayu CLI v2.6.0 npm -> RayuCode v3 (Rust) transition shim.
 *
 * When a user installed `@rayu-dev/rayu-cli` globally via npm/bun/pnpm/yarn:
 *  - `rayu-legacy` runs the preserved Node v2 CLI (`dist/rayu.js`).
 *  - `rayu` transparently launches the native Rust RayuCode v3 binary once
 *    installed (even if npm's global bin dir precedes `~/.local/bin` on PATH),
 *    or runs the official https://rayucode.com/install(.ps1) installer if
 *    postinstall was skipped (`--ignore-scripts`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG_VERSION = '2.6.0';
const IS_WINDOWS = process.platform === 'win32';

function getRustBinaryPath() {
  const customDir = process.env.RAYU_INSTALL_DIR && process.env.RAYU_INSTALL_DIR.trim();
  const exe = IS_WINDOWS ? 'rayu.exe' : 'rayu';
  if (customDir) {
    return path.join(customDir, exe);
  }
  if (IS_WINDOWS) {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'rayu', 'bin', exe);
  }
  return path.join(os.homedir(), '.local', 'bin', exe);
}

function runV3Installer() {
  if (IS_WINDOWS) {
    const url = process.env.RAYU_INSTALLER_URL || 'https://rayucode.com/install.ps1';
    const cmd = `irm '${url.replace(/'/g, "''")}' | iex`;
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { stdio: 'inherit' },
    );
  }
  const url = process.env.RAYU_INSTALLER_URL || 'https://rayucode.com/install.sh';
  const escaped = url.replace(/'/g, "'\\''");
  const cmd =
    `if command -v curl >/dev/null 2>&1; then curl -fsSL '${escaped}' | bash; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -qO- '${escaped}' | bash; ` +
    `else echo "rayu: curl or wget is required to install RayuCode v3." >&2; exit 1; fi`;
  return spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
}

function forwardToBinary(binPath, args) {
  const result = spawnSync(binPath, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`rayu: failed to launch ${binPath}: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 0);
}

function main() {
  const args = process.argv.slice(2);
  const rustBin = getRustBinaryPath();

  if (fs.existsSync(rustBin)) {
    forwardToBinary(rustBin, args);
    return;
  }

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    process.stdout.write(`${PKG_VERSION}\n`);
    process.exit(0);
  }

  const isUpdate = args[0] === 'update' || args[0] === 'upgrade';
  process.stderr.write(
    'Upgrading Rayu CLI from npm (Node v2) to RayuCode v3 (Rust)...\n',
  );
  const res = runV3Installer();
  if (res.status !== 0) {
    process.stderr.write('\nCould not complete automatic RayuCode v3 install.\n');
    process.stderr.write(
      IS_WINDOWS
        ? 'Install manually in PowerShell:\n  irm https://rayucode.com/install.ps1 | iex\n'
        : 'Install manually:\n  curl -fsSL https://rayucode.com/install | bash\n',
    );
    process.stderr.write('Or run the legacy Node CLI with: rayu-legacy\n');
    process.exit(typeof res.status === 'number' ? res.status : 1);
  }

  if (isUpdate) {
    process.exit(0);
  }

  if (fs.existsSync(rustBin)) {
    forwardToBinary(rustBin, args);
  } else {
    process.stderr.write(
      'RayuCode v3 installed. Open a new terminal and run `rayu`.\n',
    );
    process.exit(0);
  }
}

main();
