// Windows first-run self-install.
//
// Problem: a freshly downloaded `rayu-windows-x64.exe` (or any standalone exe)
// isn't on PATH, so typing `rayu` in PowerShell/CMD fails and users resort to
// double-clicking the file. This makes the binary register itself the first
// time it runs from a non-install location: it copies itself to
// %USERPROFILE%\.rayu\bin\rayu.exe and adds that dir to the user PATH, so
// `rayu` works from any new terminal afterwards.
//
// Fully no-op on Linux/macOS, when launched via `node`/`bun` (dev), or when the
// already-installed copy is running. Best-effort: never throws into the CLI.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, normalize } from 'node:path'

function eq(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

/**
 * If running as a standalone Windows exe from outside the install dir, copy it
 * into %USERPROFILE%\.rayu\bin\rayu.exe and add that dir to the user PATH.
 * Returns the install dir when an install was performed, else null. Never throws.
 */
export function maybeSelfInstallWindows(): string | null {
  try {
    if (process.platform !== 'win32') return null

    const exe = process.execPath
    const exeBase = basename(exe).toLowerCase()
    // Running via the node/bun runtime (dev/`node dist/rayu.js`) — not a
    // standalone binary, nothing to self-install.
    if (['node.exe', 'node', 'bun.exe', 'bun'].includes(exeBase)) return null

    const home = process.env.USERPROFILE || homedir()
    if (!home) return null
    const installDir = join(home, '.rayu', 'bin')
    const dest = join(installDir, 'rayu.exe')

    // Already running the installed copy → nothing to do.
    if (eq(exe, dest)) return null

    mkdirSync(installDir, { recursive: true })
    // Copy the running exe to the canonical location (only if absent, to avoid
    // re-copying ~100MB on every launch of a downloaded exe).
    if (!existsSync(dest)) copyFileSync(exe, dest)

    addDirToUserPath(installDir)

    // biome-ignore lint/suspicious/noConsole: intentional first-run notice
    console.log(
      `\nRayu-CLI installed to ${dest} and added to your PATH.\n` +
        `Open a NEW terminal (PowerShell/CMD) and run: rayu\n`,
    )
    return installDir
  } catch {
    return null // never block the CLI on install failure
  }
}

/** Add a directory to the persistent user PATH (idempotent) via PowerShell. */
function addDirToUserPath(dir: string): void {
  // PowerShell updates the persistent HKCU user PATH; a new shell picks it up.
  // Single-quote the dir and escape embedded single quotes for PS literal.
  const psDir = `'${dir.replace(/'/g, "''")}'`
  const script =
    `$d=${psDir}; ` +
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); ` +
    `if(-not $p){$p=''}; ` +
    `if(($p -split ';') -notcontains $d){` +
    `$n=if($p){($p.TrimEnd(';'))+';'+$d}else{$d}; ` +
    `[Environment]::SetEnvironmentVariable('Path',$n,'User')}`
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  })
  // Also expose it to the current process so any child sees it immediately.
  if (!(process.env.PATH ?? '').split(';').some(p => eq(p, dir))) {
    process.env.PATH = `${process.env.PATH ?? ''};${dir}`
  }
}
