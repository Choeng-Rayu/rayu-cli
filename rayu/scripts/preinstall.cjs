'use strict';

// This script intentionally does nothing interactive.
//
// It previously prompted "Replace with the latest version? [y/N]" via a
// blocking fs.readSync() on /dev/tty, and exited 1 (aborting the whole
// `npm install` per npm's lifecycle-script contract) on any answer other
// than "y".
//
// That was broken in two independent ways:
//   1. The prompt's answer never actually controlled anything — npm always
//      overwrites the previous global install once preinstall exits 0,
//      regardless of what the script printed. The y/N choice was purely
//      cosmetic.
//   2. When `npm install -g` is spawned as a child process (e.g. from
//      `rayu update`) or run inside another tool's spinner/output, this
//      prompt's text can be interleaved with or overwritten by the parent
//      process's own terminal output, making the prompt invisible. Users
//      would see a stalled spinner while the script silently blocked on
//      readSync waiting for a keypress that was never visibly requested —
//      indistinguishable from a hang, forcing a Ctrl-C. Any non-"y" answer
//      (including "no answer available", e.g. non-interactive CI/pipes)
//      then aborted the install with a non-zero exit, breaking automated
//      and headless updates entirely.
//
// Always exit 0 so `npm install -g @rayu-dev/rayu-cli[@latest]` completes
// deterministically and non-interactively on every OS and in every
// environment (interactive terminal, CI, piped, Windows).
process.exit(0);
