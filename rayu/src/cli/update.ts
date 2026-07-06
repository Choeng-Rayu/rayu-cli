import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { homedir } from 'os'
import { isInBundledMode } from 'src/utils/bundledMode.js'
import { writeToStdout } from 'src/utils/process.js'

// On Windows, npm is installed as npm.cmd (a shell shim), not a directly
// executable PE binary. execFileSync spawns the file directly and cannot
// resolve/exec .cmd shims without going through a shell — without shell:true
// this throws "spawn npm ENOENT" on every Windows machine. shell:true routes
// the spawn through cmd.exe, which resolves npm.cmd via PATH correctly.
//
// Node deprecates (DEP0190) passing an `args` array together with
// `shell: true` to execFileSync/execFile/spawn, because the args are just
// concatenated into the shell command line, not escaped — the exact pattern
// this codebase's own win32 spawns avoid (see src/utils/editor.ts). So on
// win32 we build a single, manually-quoted command string instead of an args
// array. All npmArgs here are internal literals (never raw user/network
// input), so quoting each with double quotes is sufficient and safe.
const IS_WINDOWS = process.platform === 'win32'

function execNpmSync(
  npmArgs: string[],
  options: { timeout?: number; stdio: 'pipe' | 'inherit' | Array<'pipe' | 'ignore'> },
): string {
  if (IS_WINDOWS) {
    const commandStr = `npm ${npmArgs.map(a => `"${a}"`).join(' ')}`
    return execFileSync(commandStr, [], {
      encoding: 'utf8',
      cwd: homedir(),
      shell: true,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      stdio: options.stdio as never,
    }) as unknown as string
  }
  return execFileSync('npm', npmArgs, {
    encoding: 'utf8',
    cwd: homedir(),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    stdio: options.stdio as never,
  }) as unknown as string
}

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
  } catch {
    process.stderr.write(chalk.red('Failed to check for updates\n'))
    process.stderr.write('Unable to reach npm registry. Check your network.\n')
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
  } catch {
    process.stderr.write(chalk.red('\nFailed to install update\n'))
    process.stderr.write('\nTry manually:\n')
    process.stderr.write(
      chalk.bold(`  npm install -g ${MACRO.PACKAGE_URL}@latest\n`),
    )
    process.stderr.write(
      'Or with sudo if you have permission issues:\n',
    )
    process.stderr.write(
      chalk.bold(`  sudo npm install -g ${MACRO.PACKAGE_URL}@latest\n`),
    )
    process.exit(1)
    return
  }

  writeToStdout(
    chalk.green(
      `\nSuccessfully updated from ${MACRO.VERSION} to ${latestVersion}\n`,
    ),
  )
  process.exit(0)
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
