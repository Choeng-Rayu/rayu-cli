import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRayuConfigHomeDir } from './envUtils.js'

// Marker written on first run — prevents showing the message more than once
function markerPath(): string {
  return join(getRayuConfigHomeDir(), '.installed')
}

export function showFirstRunWelcome(): void {
  try {
    if (existsSync(markerPath())) {
      return
    }
  } catch {
    return
  }

  const lines = [
    '',
    '  +--------------------------------------------------+',
    '  |                                                  |',
    '  |   Rayu CLI installed successfully!               |',
    '  |                                                  |',
    '  |   Run rayu to start an AI session                |',
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
  ]

  process.stdout.write(lines.join('\n') + '\n')

  // Write the marker so we never show this again
  try {
    mkdirSync(getRayuConfigHomeDir(), { recursive: true })
    writeFileSync(markerPath(), MACRO.VERSION, 'utf8')
  } catch {
    // If we can't write the marker, the message will show again next run.
    // That's acceptable — better than silently failing.
  }
}
