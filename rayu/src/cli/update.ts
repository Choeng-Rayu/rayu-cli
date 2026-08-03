import chalk from 'chalk'
import { isInBundledMode } from 'src/utils/bundledMode.js'
import {
  buildNpmRemediation,
  buildPinnedSpec,
  describeNpmError,
  detectShadowedInstall,
  execNpmSync,
  IS_WINDOWS,
  isLikelyWindowsFileLock,
  scheduleWindowsDeferredInstall,
} from 'src/utils/npmExec.js'
import { writeToStdout } from 'src/utils/process.js'
import {
  acquireUpdateLock,
  releaseUpdateLock,
} from 'src/utils/updateLock.js'

export async function update() {
  writeToStdout(`Current version: ${MACRO.VERSION}\n`)

  const isBundled = isInBundledMode()

  if (isBundled) {
    await updateNativeBinary()
  } else {
    await updateNpmPackage()
  }
}

async function updateNpmPackage() {
  writeToStdout(`Checking for updates...\n`)

  // Check latest version from npm registry
  let latestVersion: string
  try {
    latestVersion = execNpmSync(
      ['view', `${MACRO.PACKAGE_URL}@latest`, 'version', '--prefer-online'],
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch (err) {
    process.stderr.write(chalk.red('Failed to check for updates\n'))
    process.stderr.write('Unable to reach npm registry. Check your network.\n')
    const detail = describeNpmError(err)
    if (detail) process.stderr.write(`\n${detail}\n`)
    process.stderr.write(
      `\nManual check: npm view ${MACRO.PACKAGE_URL} version\n`,
    )
    process.exit(1)
    return
  }

  if (latestVersion === MACRO.VERSION) {
    writeToStdout(chalk.green(`\nRayu CLI is up to date (${MACRO.VERSION})\n`))
    process.exit(0)
  }

  writeToStdout(
    `New version available: ${latestVersion} (current: ${MACRO.VERSION})\n`,
  )
  writeToStdout(`Installing update...\n\n`)

  // Baseline for the "did anything actually change?" check below. Prefer what
  // is on disk in npm's global prefix (the thing npm is about to overwrite)
  // and fall back to the running build's version if npm list can't tell us.
  const versionBeforeInstall = getInstalledVersion() ?? MACRO.VERSION

  // Install the EXACT version we just resolved, not the mutable `@latest`
  // tag. `npm view …@latest` (above, with --prefer-online) and `npm install
  // …@latest` are independent resolutions of a tag that moves on every
  // publish, and npm serves registry metadata from a cache the registry marks
  // `max-age=300`. Within that window the install can resolve `@latest` to an
  // older version than the one we just reported, reinstall the version the
  // user already has, exit 0 — and the old code would then print
  // "Successfully updated to <the same old version>". Pinning removes the
  // second resolution entirely; --prefer-online makes npm revalidate the
  // packument so a freshly published version is guaranteed to be resolvable.
  const installSpec =
    buildPinnedSpec(MACRO.PACKAGE_URL, latestVersion) ??
    `${MACRO.PACKAGE_URL}@latest`

  // Serialize against the in-session auto-updater, which installs the same
  // package into the same global prefix from any Rayu window that happens to be
  // open. npm does no cross-process locking for global installs, so two
  // concurrent installs interleave over one directory tree and can leave a
  // `rayu` launcher pointing at a half-written package.
  if (!(await acquireUpdateLock())) {
    process.stderr.write(
      chalk.yellow('\nAnother Rayu update is already in progress\n'),
    )
    process.stderr.write(
      'A running Rayu session may be auto-updating in the background.\n' +
        'Wait a few seconds and run `rayu update` again.\n',
    )
    process.exit(1)
    return
  }

  let installError: unknown = null
  try {
    execNpmSync(['install', '-g', installSpec, '--prefer-online'], {
      stdio: 'inherit',
    })
  } catch (err) {
    installError = err
  } finally {
    // Release explicitly here rather than relying on this finally to cover the
    // exit paths below: process.exit() terminates immediately without
    // unwinding, and a leaked lock file would block every update on this
    // machine until it ages out of the staleness window.
    await releaseUpdateLock()
  }

  if (installError) {
    const err = installError
    process.stderr.write(chalk.red('\nFailed to install update\n'))
    const detail = describeNpmError(err)
    if (detail) process.stderr.write(`${detail}\n`)

    // Windows self-update recovery: npm could not overwrite our own launcher
    // because the shell that started us is still holding it open. Nothing we
    // do in-process can release that handle, so hand the install to a detached
    // helper that waits for us to exit first. See isLikelyWindowsFileLock().
    //
    // Note: that helper necessarily runs AFTER we exit, so it runs OUTSIDE the
    // update lock (we released it above, and a lock we no longer own cannot be
    // handed to another process). This is a deliberate trade-off: the helper is
    // a last-resort recovery for an install that already failed, and the
    // alternative — leaving a lock behind for a process we no longer control —
    // would block every future update until it aged out.
    if (IS_WINDOWS && isLikelyWindowsFileLock(err)) {
      if (scheduleWindowsDeferredInstall(installSpec)) {
        process.stderr.write(
          chalk.yellow(
            '\nRayu could not replace its own files while it is running.\n',
          ),
        )
        writeToStdout(
          'A new window has opened to finish the update as soon as Rayu exits.\n' +
            'Leave it open until it reports success, then reopen your terminal.\n',
        )
        process.exit(1)
        return
      }
    }

    process.stderr.write(`${buildNpmRemediation('install', installSpec, err)}\n`)
    process.exit(1)
    return
  }

  // npm exiting 0 is not proof the update landed, so verify against disk.
  const versionAfterInstall = getInstalledVersion()

  if (
    classifyUpdateOutcome(
      versionBeforeInstall,
      versionAfterInstall,
      latestVersion,
    ) === 'unchanged'
  ) {
    reportUpdateDidNotApply(versionBeforeInstall, latestVersion, installSpec)
    process.exit(1)
    return
  }

  writeToStdout(
    chalk.green(
      `\nSuccessfully updated to ${versionAfterInstall ?? latestVersion}\n`,
    ),
  )

  // The update is on disk, but a second installation elsewhere on PATH can
  // shadow it, so `rayu` would keep launching the old copy.
  warnIfUpdatedCopyIsShadowed()

  process.exit(0)
}

/**
 * Did the install actually change what is on disk?
 *
 *  - 'applied'   — the installed version moved, or it already equals the
 *                  target (a legitimate outcome when the running build is
 *                  older than the copy in npm's prefix).
 *  - 'unchanged' — npm exited 0 but the version is exactly what it was and is
 *                  NOT the version we asked for. This is the silent failure
 *                  that used to be reported as "Successfully updated to
 *                  <old version>".
 *  - 'unknown'   — we could not read the installed version, so we must not
 *                  claim either way.
 */
export type UpdateOutcome = 'applied' | 'unchanged' | 'unknown'

export function classifyUpdateOutcome(
  versionBefore: string,
  versionAfter: string | null,
  targetVersion: string,
): UpdateOutcome {
  if (versionAfter === null) return 'unknown'
  if (versionAfter === targetVersion) return 'applied'
  return versionAfter === versionBefore ? 'unchanged' : 'applied'
}

/**
 * npm reported success but the installed version did not move. Never print
 * "Successfully updated to <old version>" in this case — that message is what
 * made this failure mode invisible. Tell the user what actually happened and
 * give them a command that cannot hit the same tag/cache ambiguity.
 */
function reportUpdateDidNotApply(
  installedVersion: string,
  targetVersion: string,
  installSpec: string,
): void {
  process.stderr.write(
    chalk.red('\nUpdate did not apply — the installed version did not change\n'),
  )
  process.stderr.write(
    `npm exited successfully, but ${MACRO.PACKAGE_URL} on disk is still ` +
      `${installedVersion} (expected ${targetVersion}).\n`,
  )
  process.stderr.write(
    '\nThis usually means npm resolved the package from stale registry\n' +
      'metadata or a stale cache entry. Retry with a clean fetch:\n',
  )
  process.stderr.write(
    chalk.bold(`  npm install -g ${installSpec} --prefer-online\n`),
  )
  process.stderr.write(
    '\nIf that still reports the old version:\n' +
      `  npm cache clean --force && npm install -g ${installSpec}\n`,
  )

  const shadowWarning = detectShadowedInstall()
  if (shadowWarning) {
    process.stderr.write(`\n${shadowWarning}\n`)
  }
}

/**
 * Warn when the `rayu` launcher the shell resolves first is not the one npm
 * just updated (two installs under different prefixes — e.g. a sudo install in
 * /usr/local shadowing a user install in ~/.npm-global). Without this the
 * update is genuinely successful yet `rayu --version` never changes, which is
 * indistinguishable from a broken updater.
 */
function warnIfUpdatedCopyIsShadowed(): void {
  const warning = detectShadowedInstall()
  if (!warning) return
  process.stderr.write(chalk.yellow('\nWarning: another Rayu install is in the way\n'))
  process.stderr.write(`${warning}\n`)
}

/**
 * Reads the version actually on disk in npm's global prefix. This is the
 * source of truth for both the success message and the "did the update
 * actually apply?" check — npm exiting 0 only means npm ran, not that the
 * package changed (a no-op reinstall of the same version also exits 0).
 * Returns null if it can't be determined (e.g. npm list output format
 * changes) — callers fall back to the resolved target version.
 */
function getInstalledVersion(): string | null {
  try {
    const output = execNpmSync(
      ['list', '-g', MACRO.PACKAGE_URL, '--depth=0', '--json'],
      { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const parsed = JSON.parse(output) as {
      dependencies?: Record<string, { version?: string }>
    }
    return parsed.dependencies?.[MACRO.PACKAGE_URL]?.version ?? null
  } catch {
    return null
  }
}

async function updateNativeBinary() {
  writeToStdout(`Checking for updates...\n`)

  // For native binaries, use the native installer's installLatest mechanism
  const { installLatest } = await import(
    'src/utils/nativeInstaller/index.js'
  )

  // First check the latest version to inform the user
  let latestVersion: string
  try {
    latestVersion = execNpmSync(
      ['view', `${MACRO.PACKAGE_URL}@latest`, 'version', '--prefer-online'],
      { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch {
    // If npm check fails, proceed anyway — installLatest will resolve the version itself
    latestVersion = ''
  }

  if (latestVersion && latestVersion === MACRO.VERSION) {
    writeToStdout(chalk.green(`\nRayu CLI is up to date (${MACRO.VERSION})\n`))
    process.exit(0)
  }

  if (latestVersion) {
    writeToStdout(
      `New version available: ${latestVersion} (current: ${MACRO.VERSION})\n`,
    )
  }
  writeToStdout(`Downloading and installing update...\n`)

  try {
    const result = await installLatest('latest', true)

    if (!result.wasUpdated) {
      if (result.lockFailed) {
        process.stderr.write(
          chalk.yellow('Another update is already in progress. Try again later.\n'),
        )
        process.exit(1)
        return
      }
      // Already up to date (race between version check and install)
      writeToStdout(chalk.green(`\nRayu CLI is up to date (${MACRO.VERSION})\n`))
      process.exit(0)
    }

    const updatedTo = result.latestVersion ?? latestVersion ?? 'latest'
    writeToStdout(
      chalk.green(
        `\nSuccessfully updated from ${MACRO.VERSION} to ${updatedTo}\n`,
      ),
    )
    writeToStdout('Restart your terminal to use the new version.\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write(chalk.red('\nFailed to install update\n'))
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.stderr.write('\nTry manually:\n')
    process.stderr.write(
      chalk.bold(`  npm install -g ${MACRO.PACKAGE_URL}@latest\n`),
    )
    process.exit(1)
  }
}
