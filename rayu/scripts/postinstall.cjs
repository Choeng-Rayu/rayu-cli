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
].join('\n') + '\n';

// Write the first-run marker so the binary does not show the message again
function writeMarker() {
  try {
    const dir = path.join(os.homedir(), '.rayu');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.installed'), 'postinstall', 'utf8');
  } catch (_) {}
}

// npm v7+ pipes lifecycle script stdout/stderr, so we open /dev/tty directly
// to write straight to the user's terminal (proven to work with PTY parent).
try {
  const fd = fs.openSync('/dev/tty', 'w');
  fs.writeSync(fd, message);
  fs.closeSync(fd);
  // Postinstall showed the message — mark as done so binary skips it
  writeMarker();
} catch (_) {
  // No controlling terminal (CI, Docker, Windows) — fall through.
  // The binary will show the message on the user's first rayu run instead.
  process.stdout.write(message);
}
