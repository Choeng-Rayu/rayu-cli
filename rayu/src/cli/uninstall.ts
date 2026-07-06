import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'os'
import { getRayuConfigHomeDir } from 'src/utils/envUtils.js'
import { writeToStdout } from 'src/utils/process.js'

// On Windows, npm is installed as npm.cmd (a shell shim), not a directly
// executable PE binary. execFileSync spawns the file directly and cannot
// resolve/exec .cmd shims without going through a shell — without shell:true
// this throws "spawn npm ENOENT" on every Windows machine. shell:true routes
// the spawn through cmd.exe, which resolves npm.cmd via PATH correctly.
//
// Node deprecates (DEP0190) passing an `args` array together with
// `shell: true`, since the args are concatenated (not escaped) into the shell
// command line. Matching this codebase's own win32 spawn convention (see
// src/utils/editor.ts), we build a single quoted command string on win32
// instead. The uninstall args here are fixed internal literals, never raw
// user/network input, so quoting is sufficient and safe.
const IS_WINDOWS = process.platform === 'win32'

function execNpmUninstallSync(): void {
  if (IS_WINDOWS) {
    execFileSync(`npm uninstall -g "${MACRO.PACKAGE_URL}"`, [], {
      encoding: 'utf8',
      cwd: homedir(),
      stdio: 'inherit',
      shell: true,
    })
    return
  }
  execFileSync('npm', ['uninstall', '-g', MACRO.PACKAGE_URL], {
    encoding: 'utf8',
    cwd: homedir(),
    stdio: 'inherit',
  })
}

/** Prompt the user with a y/n question on stdin/stdout. Returns true for yes. */
async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  // Non-interactive stdin (piped/CI) can't be prompted — fall back to the
  // caller-specified default rather than hanging on rl.question forever.
  if (!process.stdin.isTTY) return defaultYes

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultYes ? '(Y/n)' : '(y/N)'
  try {
    const answer = await new Promise<string>(resolve => {
      rl.question(`${question} ${suffix} `, resolve)
    })
    const normalized = answer.trim().toLowerCase()
    if (!normalized) return defaultYes
    return normalized === 'y' || normalized === 'yes'
  } finally {
    rl.close()
  }
}

async function removeDataDir(dir: string): Promise<boolean> {
  writeToStdout(`Removing configuration and data: ${dir}\n`)
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export async function uninstall(args: string[] = []) {
  const yes = args.includes('--yes') || args.includes('-y')
  const keepData = args.includes('--keep-data')

  writeToStdout(`Uninstalling Rayu CLI (${MACRO.VERSION})...\n`)
  writeToStdout(`Running: npm uninstall -g ${MACRO.PACKAGE_URL}\n\n`)

  try {
    execNpmUninstallSync()
  } catch {
    process.stderr.write(
      chalk.red(`\nFailed to uninstall ${MACRO.PACKAGE_URL}\n`),
    )
    process.stderr.write('\nTry running manually:\n')
    process.stderr.write(
      chalk.bold(`  npm uninstall -g ${MACRO.PACKAGE_URL}\n`),
    )
    process.stderr.write(
      'Or with sudo if you installed with elevated permissions:\n',
    )
    process.stderr.write(
      chalk.bold(`  sudo npm uninstall -g ${MACRO.PACKAGE_URL}\n`),
    )
    process.exit(1)
    return
  }

  writeToStdout(
    chalk.green(
      `\nSuccessfully uninstalled ${MACRO.PACKAGE_URL} ${MACRO.VERSION}\n`,
    ),
  )

  // The npm uninstall above only removes the package itself. Config, saved
  // provider API keys, settings, and session history live separately under
  // the Rayu config dir (~/.rayu by default, or $RAYU_CONFIG_DIR) and survive
  // npm uninstall unless removed explicitly here.
  const configDir = getRayuConfigHomeDir()
  const dataExists = existsSync(configDir)

  if (dataExists && !keepData) {
    writeToStdout(
      `\nRayu also stores configuration and data at:\n  ${configDir}\n` +
        'This includes saved provider API keys, settings, and session history.\n',
    )
    const shouldRemove =
      yes || (await confirm('Remove this configuration and data too?', false))

    if (shouldRemove) {
      const removed = await removeDataDir(configDir)
      if (!removed || existsSync(configDir)) {
        process.stderr.write(
          chalk.yellow(`\nCould not fully remove ${configDir}. Remove it manually if needed.\n`),
        )
      } else {
        writeToStdout(chalk.green(`Removed ${configDir}\n`))
      }
    } else {
      writeToStdout(`Keeping configuration and data at ${configDir}\n`)
    }
  } else if (dataExists && keepData) {
    writeToStdout(`\nKeeping configuration and data at ${configDir} (--keep-data)\n`)
  }

  writeToStdout('\nThanks for using Rayu CLI!\n')
  process.exit(0)
}
