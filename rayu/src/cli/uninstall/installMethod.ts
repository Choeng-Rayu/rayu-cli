/**
 * How was this copy of RAYU installed?
 *
 * WHY THIS EXISTS. The previous `rayu uninstall` ran `npm uninstall -g` and
 * nothing else. On an npm-global install that is correct; on a Homebrew cask, a
 * `.deb`, a mise/asdf shim, or the native binary installer it removes NOTHING and
 * still prints "Successfully uninstalled". A local user can notice and work
 * around that. A REMOTE uninstall cannot — it would report success while leaving
 * the CLI, its credentials, and its Telegram link fully in place, which is the
 * worst possible outcome for a security-relevant operation.
 *
 * So detection comes first, and an install method we cannot fully remove is
 * reported honestly as PARTIAL with the exact command the user should run.
 *
 * REUSES `getPackageManager()` from utils/nativeInstaller/packageManagers.ts,
 * which already probes Homebrew Caskroom paths, WinGet paths, mise/asdf install
 * dirs, and dpkg/rpm/pacman/apk file ownership. This module only adds the
 * npm-global vs native-binary distinction that detection does not cover.
 */

import { realpathSync } from 'fs'
import { join, resolve } from 'path'
import { getPackageManager, type PackageManager } from '../../utils/nativeInstaller/packageManagers.js'
import { getUserBinDir, getXDGCacheHome, getXDGDataHome, getXDGStateHome } from '../../utils/xdg.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  isInstallerManagedInstall,
  readInstallerManifest,
} from '../../utils/installerManifest.js'

export type InstallMethod =
  /** `npm install -g` — removable with `npm uninstall -g`. */
  | 'npm-global'
  /** The native binary installer: versions dir + ~/.local/bin symlink. */
  | 'native'
  /**
   * Created by the one-liner at https://rayucode.com/install: a launcher in
   * $RAYU_HOME/bin over $RAYU_HOME/lib/current. Removable by RAYU, because every
   * artifact is a path the installer recorded in $RAYU_HOME/install.json.
   */
  | 'installer'
  /** Managed by an external package manager we must not fight. */
  | 'homebrew'
  | 'winget'
  | 'deb'
  | 'rpm'
  | 'pacman'
  | 'apk'
  | 'mise'
  | 'asdf'
  /** Running from a source checkout (`bun run dev`) — nothing to uninstall. */
  | 'development'
  /** Detection failed. Treated as not-removable. */
  | 'unknown'

/** Native-install directories, derived the same way installer.ts derives them. */
export interface NativeInstallPaths {
  versions: string
  staging: string
  locks: string
  executable: string
}

export function getNativeInstallPaths(): NativeInstallPaths {
  const executableName = process.platform === 'win32' ? 'rayu.exe' : 'rayu'
  return {
    versions: join(getXDGDataHome(), 'rayu', 'versions'),
    staging: join(getXDGCacheHome(), 'rayu', 'staging'),
    locks: join(getXDGStateHome(), 'rayu', 'locks'),
    executable: join(getUserBinDir(), executableName),
  }
}

export interface InstallMethodInfo {
  method: InstallMethod
  /** The executable this process is running from. */
  execPath: string
  /**
   * True when this method's artifacts can be removed by RAYU itself.
   * False means the user (or their package manager) must do it.
   */
  selfRemovable: boolean
  /** Exact command to run when RAYU cannot do it. */
  manualCommand?: string
  /** Why we concluded this, for the audit trail and for `--dry-run`. */
  reason: string
}

/** Commands for install methods RAYU deliberately does not drive itself. */
const MANUAL_COMMANDS: Partial<Record<InstallMethod, string>> = {
  homebrew: 'brew uninstall --cask rayu',
  winget: 'winget uninstall rayu',
  deb: 'sudo apt-get remove rayu',
  rpm: 'sudo dnf remove rayu',
  pacman: 'sudo pacman -R rayu',
  apk: 'sudo apk del rayu',
  mise: 'mise uninstall rayu',
  asdf: 'asdf uninstall rayu',
}

/**
 * True when this process is running from a source checkout rather than an
 * install. Checked FIRST: a developer running `bun run dev` must never have their
 * repo treated as an installation to be deleted.
 */
function isDevelopmentCheckout(execPath: string): boolean {
  // A dev run executes the bun/node binary directly against source, so argv[1]
  // is a .ts/.tsx entrypoint rather than a bundled or installed binary.
  const entry = process.argv[1] ?? ''
  if (/\.(ts|tsx)$/.test(entry)) return true
  // A source tree has a package.json next to the entrypoint's project root and
  // no versions-dir ancestry.
  return /[/\\]src[/\\]entrypoints[/\\]/.test(entry) && !execPath.includes('versions')
}

/**
 * True when the running binary IS the native install.
 *
 * Deliberately strict. An earlier version also returned true whenever
 * `~/.local/bin/rayu` merely existed, which misclassifies a *different* copy
 * (an npm-global or a dev build) as the native install — and would then aim a
 * destructive removal at the native install the user never invoked. For a
 * destructive operation, classification must describe THIS process, so the test
 * is ancestry of the running executable, plus a realpath comparison because the
 * user-bin entry is a symlink into the versions directory.
 */
function isNativeInstall(execPath: string): boolean {
  if (!execPath) return false
  const { versions, executable } = getNativeInstallPaths()
  const resolvedExec = realpathIfPossible(execPath)
  if (resolvedExec.startsWith(resolve(versions))) return true
  return resolvedExec === realpathIfPossible(executable)
}

/** realpath, falling back to a plain resolve when the path does not exist. */
function realpathIfPossible(target: string): string {
  try {
    return realpathSync(resolve(target))
  } catch {
    return resolve(target)
  }
}

/**
 * True when this looks like an npm global install.
 *
 * Deliberately LAST among the positive checks: Homebrew's npm places global
 * packages under the Homebrew prefix too, so `node_modules` alone cannot
 * distinguish npm-global from a Homebrew cask. getPackageManager() has already
 * ruled Homebrew out by the time this runs (it checks `/Caskroom/` specifically).
 */
function isNpmGlobalInstall(execPath: string): boolean {
  return /[/\\]node_modules[/\\]/.test(execPath)
}

/**
 * Resolve the install method.
 *
 * Order matters and is deliberate:
 *  1. development — never touch a source checkout;
 *  2. installer-managed — must precede the package-manager probe, which
 *     inspects `process.execPath`. For a launcher install that is the *Node
 *     binary*, so a Node installed by Homebrew/apt/mise would otherwise make
 *     RAYU classify itself as owned by that package manager and refuse to
 *     uninstall, printing e.g. `brew uninstall --cask rayu` for an install
 *     Homebrew has never heard of;
 *  3. external package managers — they own their files, and fighting them
 *     leaves a broken half-state their database still believes in;
 *  4. native binary installer;
 *  5. npm-global;
 *  6. unknown — refuse to guess.
 */
export async function detectInstallMethod(): Promise<InstallMethodInfo> {
  const execPath = process.execPath || process.argv[0] || ''

  if (isDevelopmentCheckout(execPath)) {
    return {
      method: 'development',
      execPath,
      selfRemovable: false,
      reason: 'running from a source checkout — there is no installation to remove',
    }
  }

  const installerManifest = readInstallerManifest()
  if (isInstallerManagedInstall(installerManifest)) {
    return {
      method: 'installer',
      execPath,
      // Every artifact is enumerated in the scope manifest, so RAYU can finish
      // the job: the launcher, the versioned bundles and the private Node
      // runtime all live under $RAYU_HOME. No `manualCommand` — setting one
      // makes `rayu uninstall` print "Run this to finish" after a clean
      // removal. The only thing left behind is the PATH line in the user's
      // shell profile, which RAYU promises never to edit (see NEVER_REMOVED)
      // and which is inert once the launcher is gone.
      selfRemovable: true,
      reason:
        `installed by ${installerManifest?.installer ?? 'the rayucode.com installer'}` +
        (installerManifest?.method ? ` (${installerManifest.method})` : ''),
    }
  }

  const packageManager: PackageManager = await getPackageManager()
  if (packageManager !== 'unknown') {
    const method = packageManager as InstallMethod
    return {
      method,
      execPath,
      // RAYU will not run a package manager's uninstall on the user's behalf: it
      // may need sudo, may prompt, and may remove shared dependencies. Reporting
      // the command is more honest than half-doing it.
      selfRemovable: false,
      ...(MANUAL_COMMANDS[method] ? { manualCommand: MANUAL_COMMANDS[method]! } : {}),
      reason: `installed and owned by ${packageManager}`,
    }
  }

  if (isNativeInstall(execPath)) {
    return {
      method: 'native',
      execPath,
      selfRemovable: true,
      reason: 'native binary install (versions directory + user bin symlink)',
    }
  }

  if (isNpmGlobalInstall(execPath)) {
    return {
      method: 'npm-global',
      execPath,
      selfRemovable: true,
      reason: 'npm global install (executable resolves inside node_modules)',
    }
  }

  logForDebugging(`[uninstall] could not classify install at ${execPath}`)
  return {
    method: 'unknown',
    execPath,
    selfRemovable: false,
    reason: `could not determine how RAYU was installed (running from ${execPath || 'an unknown path'})`,
  }
}
