'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const message = [
  '',
  '  +--------------------------------------------------+',
  '  |                                                  |',
  '  |   Rayu CLI installed successfully!               |',
  '  |                                                  |',
  '  |   Run rayu to start                              |',
  '  |                                                  |',
  '  +--------------------------------------------------+',
  '',
  '  Quick reference:',
  '    rayu                  Start an interactive AI session',
  '    rayu update           Update to the latest version',
  '    rayu uninstall        Remove Rayu CLI from your system',
  '    rayu --help           See all commands and options',
  '',
  '  Docs & issues:  https://github.com/Choeng-Rayu/rayu-cli',
  '',
  'Whats new?:',
  '    - Improve the ask user question tool for all LLMs providers.',
  '    - Fix the Gateway upstream error.',
  '    - Fix the bug for plan credit calculation.',
  '',
].join('\n') + '\n';

// Write the first-run marker so the binary does not show the message again
function writeMarker() {
  try {
    const dir = path.join(os.homedir(), '.rayu');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.installed'), 'postinstall', 'utf8');
  } catch (_) {}
}

// npm v7+ pipes lifecycle script stdout/stderr, so we open the terminal
// device directly to write straight to the user's terminal.
// On Unix: /dev/tty, on Windows: CON
const isWindows = process.platform === 'win32';
const ttyDevice = isWindows ? 'CON' : '/dev/tty';

// Rayu-driven installs (the in-session auto-updater, and the local-install
// updater) set this. In that case the terminal device is NOT free real estate:
// it is the terminal an Ink TUI is actively rendering into, so writing here
// bypasses the parent's piped stdio and smears this banner over the live UI.
// The banner is redundant there anyway — the user already has Rayu open.
// Still write the marker so the binary does not replay the welcome later.
// Keep this env var name in sync with MANAGED_INSTALL_ENV_VAR in
// src/utils/npmExec.ts (this file is CommonJS run by npm and cannot import it).
const isManagedInstall = !!process.env.RAYU_MANAGED_INSTALL;

if (isManagedInstall) {
  writeMarker();
  process.exit(0);
}

try {
  const fd = fs.openSync(ttyDevice, 'w');
  fs.writeSync(fd, message);
  fs.closeSync(fd);
  // Postinstall showed the message — mark as done so binary skips it
  writeMarker();
} catch (_) {
  // No controlling terminal (CI, Docker, headless) — fall through.
  // Write to stdout as best-effort, and still write the marker so the
  // binary doesn't try to show it again in a non-interactive context.
  try {
    process.stdout.write(message);
  } catch (_e) {
    // stdout may be closed in some CI environments
  }
  writeMarker();
}
