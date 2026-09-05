/**
 * What an uninstall is allowed to delete — and, more importantly, what it is not.
 *
 * THE RULE: RAYU may delete resources it created and registered as RAYU-owned. It
 * must never recursively delete an arbitrary directory. A remote uninstall runs
 * unattended on a developer's workstation, so "delete this path" has to be a
 * decision made HERE, from a fixed manifest, rather than anything derived from a
 * message, a config value, or an argument.
 *
 * Every candidate path is checked against `isPathInScope` before removal. That
 * check is an allowlist over the manifest, not a denylist of dangerous paths: a
 * denylist can always be circumvented by a path nobody thought of, whereas an
 * allowlist fails closed on exactly the paths nobody thought of.
 */

import { resolve, sep } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { getInstallerOwnedPaths } from '../../utils/installerManifest.js'
import { ipcSocketDir } from '../../ipc/paths.js'
import { getNativeInstallPaths, type InstallMethod } from './installMethod.js'

/** One removable artifact. */
export interface ScopedArtifact {
  path: string
  kind: 'file' | 'directory'
  /** Shown in `--dry-run` and in the Telegram confirmation card. */
  label: string
  /**
   * True when removing this destroys state the user cannot recover (API keys,
   * session history). Kept behind `--keep-data` / an explicit confirmation.
   */
  userData: boolean
}

/**
 * Directories that must NEVER be the target of a recursive delete, even if some
 * future refactor accidentally routes them through here.
 *
 * This is a belt-and-braces assertion, not the primary control — the primary
 * control is that `isPathInScope` only permits paths derived from the manifest.
 */
function isObviouslyUnsafe(target: string): boolean {
  const normalized = resolve(target)
  // Root, or a single path segment from root (/usr, /etc, C:\Windows …).
  if (normalized === sep) return true
  const segments = normalized.split(sep).filter(Boolean)
  if (segments.length <= 1) return true
  // A bare home directory.
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home && normalized === resolve(home)) return true
  return false
}

/**
 * The RAYU-owned artifacts for this install.
 *
 * Split by `userData` so config/credentials can be preserved independently of
 * the binaries — which is what `--keep-data` means, and what a user who is
 * reinstalling almost always wants.
 */
export function buildScopeManifest(method: InstallMethod): ScopedArtifact[] {
  const configHome = getRayuConfigHomeDir()
  const artifacts: ScopedArtifact[] = []

  // ---- Runtime state created by the Telegram bridge + session routing -------
  // Listed individually rather than as "the config dir" so a --keep-data
  // uninstall still severs remote control: leaving telegram.json behind would
  // leave a linked chat pointed at a machine the user believes is clean.
  artifacts.push(
    {
      path: `${configHome}${sep}telegram.json`,
      kind: 'file',
      label: 'Telegram bridge credentials and link',
      userData: false,
    },
    {
      path: `${configHome}${sep}telegram-attached.json`,
      kind: 'file',
      label: 'Telegram session attachment pointer',
      userData: false,
    },
    {
      path: `${configHome}${sep}telegram-bridge.lock`,
      kind: 'file',
      label: 'Telegram bridge leader lock',
      userData: false,
    },
    {
      path: `${configHome}${sep}device.json`,
      kind: 'file',
      label: 'Device identity',
      userData: false,
    },
    {
      path: `${configHome}${sep}sessions`,
      kind: 'directory',
      label: 'Session registry',
      userData: false,
    },
    {
      path: `${configHome}${sep}uninstall-state.json`,
      kind: 'file',
      label: 'Uninstall progress state',
      userData: false,
    },
  )

  // Local IPC sockets. Not under the config dir on purpose (see ipc/paths.ts),
  // so they would survive a config-dir removal and leave stale endpoints behind.
  try {
    artifacts.push({
      path: ipcSocketDir(),
      kind: 'directory',
      label: 'Local IPC sockets',
      userData: false,
    })
  } catch {
    // Socket dir could not be resolved — nothing to remove.
  }

  // ---- Install artifacts ---------------------------------------------------
  if (method === 'installer') {
    // Paths recorded by https://rayucode.com/install in $RAYU_HOME/install.json.
    // getInstallerOwnedPaths() only ever returns launcher entries as individual
    // FILES (binDir is user-controlled via --dir) and constrains the recursive
    // entries to $RAYU_HOME, so a hand-edited manifest cannot redirect a
    // recursive delete.
    const owned = getInstallerOwnedPaths()
    for (const path of owned.files) {
      artifacts.push({
        path,
        kind: 'file',
        label: `rayu launcher / installer copy (${path})`,
        userData: false,
      })
    }
    for (const path of owned.directories) {
      artifacts.push({
        path,
        kind: 'directory',
        label: path.endsWith('runtime')
          ? 'Private Node runtime'
          : 'Installed bundles',
        userData: false,
      })
    }
  }

  if (method === 'native') {
    const native = getNativeInstallPaths()
    artifacts.push(
      {
        path: native.executable,
        kind: 'file',
        label: 'rayu executable (user bin)',
        userData: false,
      },
      {
        path: native.versions,
        kind: 'directory',
        label: 'Installed versions',
        userData: false,
      },
      {
        path: native.staging,
        kind: 'directory',
        label: 'Download staging cache',
        userData: false,
      },
      {
        path: native.locks,
        kind: 'directory',
        label: 'Version locks',
        userData: false,
      },
    )
  }

  // ---- User data -----------------------------------------------------------
  // The whole config dir, last. Removing it subsumes the individual files above;
  // they are listed separately so a --keep-data run still removes remote-control
  // state while preserving settings and history.
  artifacts.push({
    path: configHome,
    kind: 'directory',
    label: 'Configuration, provider API keys, and session history',
    userData: true,
  })

  return artifacts
}

/**
 * Is `target` inside the manifest?
 *
 * A path is in scope when it EQUALS a manifest entry, or is contained by a
 * manifest DIRECTORY entry. Containment is tested on resolved paths with a
 * trailing separator, so `/home/u/.rayu-evil` is not treated as being inside
 * `/home/u/.rayu` — a plain `startsWith` would accept it.
 */
export function isPathInScope(
  target: string,
  manifest: readonly ScopedArtifact[],
): boolean {
  if (!target) return false
  const normalized = resolve(target)
  if (isObviouslyUnsafe(normalized)) return false

  for (const artifact of manifest) {
    const scoped = resolve(artifact.path)
    if (normalized === scoped) return true
    if (
      artifact.kind === 'directory' &&
      normalized.startsWith(scoped.endsWith(sep) ? scoped : scoped + sep)
    ) {
      return true
    }
  }
  return false
}

/**
 * Paths that are explicitly NOT RAYU's to delete, for the dry-run output.
 *
 * Documented as a promise to the user rather than as an implementation detail:
 * the manifest above already excludes them by construction, and this exists so
 * that promise is visible in `--dry-run` where someone will actually read it.
 */
export const NEVER_REMOVED = [
  'your projects, source code, and git repositories',
  'shell configuration (.bashrc, .zshrc, and similar)',
  'anything outside the RAYU install and config directories',
] as const
