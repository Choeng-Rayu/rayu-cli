'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const ttyDevice = isWindows ? 'CON' : '/dev/tty';
const installOneLiner = isWindows
  ? 'irm https://rayucode.com/install.ps1 | iex'
  : 'curl -fsSL https://rayucode.com/install | bash';

const message = [
  '',
  '  +--------------------------------------------------+',
  '  |                                                  |',
  '  |   Rayu CLI installed successfully!               |',
  '  |                                                  |',
  '  |   RayuCode v3 (native Rust) transition bridge    |',
  '  |   Legacy Node CLI is preserved as: rayu-legacy   |',
  '  |                                                  |',
  '  +--------------------------------------------------+',
  '',
  '  Install / upgrade to RayuCode v3 (Rust):',
  `    ${installOneLiner}`,
  '',
  '  Remove legacy npm package later:',
  '    npm uninstall -g @rayu-dev/rayu-cli',
  '',
].join('\n') + '\n';

function writeMarker() {
  try {
    const dir = path.join(os.homedir(), '.rayu');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.installed'), 'postinstall', 'utf8');
  } catch (_) {}
}

function writeTty(text) {
  try {
    const fd = fs.openSync(ttyDevice, 'w');
    fs.writeSync(fd, text);
    fs.closeSync(fd);
  } catch (_) {
    try {
      process.stdout.write(text);
    } catch (_e) {}
  }
}

const isManagedInstall = !!process.env.RAYU_MANAGED_INSTALL;
if (isManagedInstall) {
  writeMarker();
  process.exit(0);
}

writeMarker();

const skipMigration =
  process.env.RAYU_SKIP_V3_MIGRATION === '1' ||
  process.env.CI === 'true' ||
  process.env.NODE_ENV === 'test';

// Only run the network v3 installer automatically when a real controlling
// terminal is attached (e.g. a user running `rayu update` / `npm install -g`),
// or when explicitly forced via RAYU_FORCE_V3_MIGRATION=1. Headless/test runs
// never block on network I/O and still print the banner cleanly.
let migrated = false;
if (!skipMigration) {
  let ttyIn = null;
  let ttyOut = null;
  let hasTty = false;

  if (isWindows) {
    hasTty = !!(process.stdout.isTTY || process.env.RAYU_FORCE_V3_MIGRATION === '1');
  } else {
    try {
      ttyIn = fs.openSync('/dev/tty', 'r');
      ttyOut = fs.openSync('/dev/tty', 'w');
      hasTty = true;
    } catch (_) {
      hasTty = process.env.RAYU_FORCE_V3_MIGRATION === '1';
    }
  }

  if (hasTty) {
    try {
      const env = Object.assign({}, process.env, {
        RAYU_FROM_NPM_POSTINSTALL: '1',
      });
      let res;
      if (isWindows) {
        const url = process.env.RAYU_INSTALLER_URL || 'https://rayucode.com/install.ps1';
        const cmd = `irm '${url.replace(/'/g, "''")}' | iex`;
        res = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
          { env, stdio: 'inherit' },
        );
      } else {
        const url = process.env.RAYU_INSTALLER_URL || 'https://rayucode.com/install.sh';
        const escaped = url.replace(/'/g, "'\\''");
        const cmd =
          `if command -v curl >/dev/null 2>&1; then curl -fsSL '${escaped}' | bash; ` +
          `elif command -v wget >/dev/null 2>&1; then wget -qO- '${escaped}' | bash; ` +
          `else exit 1; fi`;
        const stdio = ttyIn !== null && ttyOut !== null ? [ttyIn, ttyOut, ttyOut] : 'inherit';
        res = spawnSync('sh', ['-c', cmd], { env, stdio });
      }
      migrated = !!(res && res.status === 0);
    } catch (_) {
      migrated = false;
    }
  }

  if (ttyIn !== null) try { fs.closeSync(ttyIn); } catch (_) {}
  if (ttyOut !== null) try { fs.closeSync(ttyOut); } catch (_) {}
}

if (!migrated) {
  writeTty(message);
}
