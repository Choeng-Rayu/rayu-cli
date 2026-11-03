/**
 * Awareness of installs created by the one-line installer at
 * https://rayucode.com/install (and its Windows twin, /install.ps1).
 *
 * WHY THIS EXISTS. That installer does not use npm: it drops the pre-bundled
 * `dist/rayu.js` into `$RAYU_HOME/lib/<version>/`, points `$RAYU_HOME/lib/current`
 * at it, and writes a launcher into `$RAYU_HOME/bin` that runs it with a pinned
 * Node. Nothing about that layout looks like an npm global install, so the
 * lifecycle commands would otherwise mis-handle it in ways that are worse than
 * useless:
 *
 *   - `rayu update` would run `npm install -g`, installing a SECOND copy into
 *     npm's prefix that the launcher never executes. The user would be told the
 *     update succeeded while `rayu` kept starting the old version.
 *   - `rayu uninstall` would run `npm uninstall -g`, remove nothing that is
 *     actually installed, and report success — the exact false-clean outcome
 *     src/cli/uninstall/ exists to prevent.
 *
 * The installer records what it did in `$RAYU_HOME/install.json`; this module is
 * the only reader. Everything degrades to `null`/`false` when that file is
 * absent or unparseable, so npm and native installs are unaffected.
 */

import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { logForDebugging } from './debug.js'

/** How the installer placed the CLI on disk. */
export type InstallerMethod =
  /** Standalone binary from a GitHub Release (embeds its own runtime). */
  | 'native'
  /** Pre-bundled dist/rayu.js from the npm tarball + a Node runtime. */
  | 'tarball'
  /** `install.sh --local` against a compiled binary in a checkout. */
  | 'local-binary'
  /** `install.sh --local` against dist/rayu.js in a checkout. */
  | 'local-bundle'

/** Shape of `$RAYU_HOME/install.json`, as written by install.sh / install.ps1. */
export interface InstallerManifest {
  /** e.g. "rayucode.com/install" — present on every file we write. */
  installer?: string
  method?: InstallerMethod
  version?: string
  platform?: string
  /** Directory holding the launcher (`--dir`, default `$RAYU_HOME/bin`). */
  binDir?: string
  /** Absolute path to the pinned Node, or "embedded" for native installs. */
  node?: string
  installedAt?: string
}

/**
 * The installer's state directory: `$RAYU_HOME`, default `~/.rayu`.
 *
 * Deliberately NOT `getRayuConfigHomeDir()`: that one honours
 * `RAYU_CONFIG_DIR` and can point somewhere else entirely, while the installer
 * only ever reads `RAYU_HOME`. Reading the wrong variable here would look
 * harmless and then aim uninstall at the wrong tree.
 */
export function getInstallerHomeDir(): string {
  const fromEnv = process.env.RAYU_HOME?.trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.rayu')
}

export function getInstallerManifestPath(): string {
  return join(getInstallerHomeDir(), 'install.json')
}

/**
 * Read and validate `install.json`.
 *
 * Returns null unless the file exists, parses, and carries the `installer`
 * marker — an arbitrary JSON file that happens to sit at that path must not be
 * able to make the CLI believe it is installer-managed.
 */
export function readInstallerManifest(): InstallerManifest | null {
  const path = getInstallerManifestPath()
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const manifest = parsed as InstallerManifest
    if (typeof manifest.installer !== 'string' || !manifest.installer.includes('install')) {
      return null
    }
    return manifest
  } catch (error) {
    logForDebugging(`[installer] could not read ${path}: ${error}`)
    return null
  }
}

/** realpath, falling back to a plain resolve when the path does not exist. */
function realpathIfPossible(target: string): string {
  try {
    return realpathSync(resolve(target))
  } catch {
    return resolve(target)
  }
}

/** Is `child` the same path as, or inside, `parent`? */
function isInside(child: string, parent: string): boolean {
  const c = realpathIfPossible(child)
  const p = realpathIfPossible(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * Is THIS process the copy the installer put on disk?
 *
 * Existence of a manifest is not enough: a user can have an installer-managed
 * copy AND an npm global copy, and `rayu update`/`rayu uninstall` must act on
 * the one that is actually running. So the running entrypoint (argv[1] for the
 * launcher path, execPath for a standalone binary) has to live inside the
 * installer's home directory.
 */
export function isInstallerManagedInstall(
  manifest: InstallerManifest | null = readInstallerManifest(),
): boolean {
  if (!manifest) return false
  const home = getInstallerHomeDir()
  const entry = process.argv[1] ?? ''
  const execPath = process.execPath || process.argv[0] || ''

  // Launcher path: node (or a system node) running $RAYU_HOME/lib/current/rayu.js.
  if (entry && isInside(entry, home)) return true
  // Native/standalone path: the running executable IS $RAYU_HOME/bin/rayu.
  if (execPath && isInside(execPath, home)) return true
  return false
}

/**
 * The local copy of the installer, kept next to the launcher so `rayu update`
 * and uninstall work without going back to the website. Returns null when it is
 * missing (a partially removed install, or `--dir` pointing somewhere the copy
 * could not be written).
 */
export function getInstallerScriptPath(
  manifest: InstallerManifest | null = readInstallerManifest(),
): string | null {
  const binDir = manifest?.binDir?.trim() || join(getInstallerHomeDir(), 'bin')
  const candidates =
    process.platform === 'win32'
      ? ['.rayu-installer.ps1', '.rayu-installer']
      : ['.rayu-installer']
  for (const name of candidates) {
    const candidate = join(binDir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The one-liner to print when the local installer copy is gone. */
export function getInstallerCommand(): string {
  return process.platform === 'win32'
    ? 'irm https://rayucode.com/install.ps1 | iex'
    : 'curl -fsSL https://rayucode.com/install | bash'
}

/** The uninstall form of the one-liner. */
export function getInstallerUninstallCommand(): string {
  const script = getInstallerScriptPath()
  if (process.platform === 'win32') {
    return script
      ? `& "${script}" -Uninstall`
      : 'irm https://rayucode.com/install.ps1 -OutFile install.ps1; .\\install.ps1 -Uninstall'
  }
  return script
    ? `"${script}" --uninstall`
    : 'curl -fsSL https://rayucode.com/install | bash -s -- --uninstall'
}

/**
 * Paths the installer owns, for the uninstall scope manifest.
 *
 * Split into files and directories on purpose. Launcher paths come from
 * `binDir`, which the user can point anywhere with `--dir`, so they are only
 * ever emitted as individual FILES — never as a directory that would be removed
 * recursively. The recursive entries (`lib`, `runtime`) are derived from
 * `$RAYU_HOME` alone and are additionally required to resolve inside it, so a
 * hand-edited manifest cannot redirect a recursive delete.
 */
export function getInstallerOwnedPaths(
  manifest: InstallerManifest | null = readInstallerManifest(),
): { files: string[]; directories: string[] } {
  const home = getInstallerHomeDir()
  const binDir = manifest?.binDir?.trim() || join(home, 'bin')

  const files = [
    join(binDir, 'rayu'),
    join(binDir, 'rayu.cmd'),
    join(binDir, 'rayu.exe'),
    join(binDir, '.rayu-installer'),
    join(binDir, '.rayu-installer.ps1'),
    getInstallerManifestPath(),
  ]

  const directories = [join(home, 'lib'), join(home, 'runtime')].filter(dir =>
    // Belt-and-braces: both are constructed from `home`, so this can only fail
    // if `home` itself is nonsense — in which case emitting nothing is correct.
    isInside(dir, home),
  )

  return { files, directories }
}
