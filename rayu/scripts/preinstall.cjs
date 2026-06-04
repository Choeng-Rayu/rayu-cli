'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

// Check if rayu is already installed
let currentVersion = null;
try {
  const output = execSync('rayu --version', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (match) currentVersion = match[1];
} catch (_) {
  // rayu not installed — fresh install, proceed silently
}

if (!currentVersion) {
  process.exit(0);
}

// npm redirects stdin away from the terminal when running lifecycle scripts,
// so process.stdin.isTTY is always false. Open /dev/tty directly to get
// real interactive input from the user.
let ttyFd;
try {
  ttyFd = fs.openSync('/dev/tty', 'r+');
} catch (_) {
  // Non-interactive environment (CI, pipes, Windows) — proceed with install
  process.exit(0);
}

process.stdout.write(
  '\n  Rayu CLI v' + currentVersion + ' is already installed.\n' +
  '  Replace with the latest version? Your config will not be changed. [y/N] '
);

// Read answer synchronously directly from the terminal
const buf = Buffer.alloc(256);
let bytesRead = 0;
try {
  bytesRead = fs.readSync(ttyFd, buf, 0, buf.length, null);
} catch (_) {
  fs.closeSync(ttyFd);
  process.exit(0);
}
fs.closeSync(ttyFd);

const answer = buf.slice(0, bytesRead).toString().trim();

if (answer.toLowerCase() === 'y') {
  process.stdout.write('  Installing latest version...\n\n');
  process.exit(0);
} else {
  process.stdout.write('  Keeping current version. No changes made.\n\n');
  process.exit(1);
}
