import chalk from 'chalk'
import { isInBundledMode } from 'src/utils/bundledMode.js'
import {
  buildNpmRemediation,
  describeNpmError,
  execNpmSync,
  IS_WINDOWS,
  isLikelyWindowsFileLock,
  scheduleWindowsDeferredInstall,
} from 'src/utils/npmExec.js'
import { writeToStdout } from 'src/utils/process.js'

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

  // Always update via npm install -g
  try {
    execNpmSync(
      ['install', '-g', `${MACRO.PACKAGE_URL}@latest`],
      { stdio: 'inherit' },
    )
  } catch (err) {
    process.stderr.write(chalk.red('\nFailed to install update\n'))
    const detail = describeNpmError(err)
    if (detail) process.stderr.write(`${detail}\n`)

    // Windows self-update recovery: npm could not overwrite our own launcher
    // because the shell that started us is still holding it open. Nothing we
    // do in-process can release that handle, so hand the install to a detached
    // helper that waits for us to exit first. See isLikelyWindowsFileLock().
    if (IS_WINDOWS && isLikelyWindowsFileLock(err)) {
      const spec = `${MACRO.PACKAGE_URL}@latest`
      if (scheduleWindowsDeferredInstall(spec)) {
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

    process.stderr.write(`${buildNpmRemediation('install', `${MACRO.PACKAGE_URL}@latest`, err)}\n`)
    process.exit(1)
    return
  }

  writeToStdout(
    chalk.green(
      `\nSuccessfully updated to ${getInstalledVersion() ?? latestVersion}\n`,
    ),
  )
  process.exit(0)
}

/**
 * Reads the version actually on disk after `npm install -g` completes,
 * rather than trusting the `npm view ...@latest` result captured before
 * the install ran. A newer version can publish in the window between the
 * two calls, in which case the pre-install snapshot no longer matches what
 * was actually installed. Returns null if it can't be determined (e.g. npm
 * list output format changes) — callers fall back to the pre-install value.
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
