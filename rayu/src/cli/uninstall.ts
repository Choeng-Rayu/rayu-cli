import chalk from 'chalk'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { getRayuConfigHomeDir } from 'src/utils/envUtils.js'
import { execNpmSync, isLikelyEacces } from 'src/utils/npmExec.js'
import { writeToStdout } from 'src/utils/process.js'

function execNpmUninstallSync(): void {
  execNpmSync(['uninstall', '-g', MACRO.PACKAGE_URL], { stdio: 'inherit' })
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
  } catch (err) {
    process.stderr.write(
      chalk.red(`\nFailed to uninstall ${MACRO.PACKAGE_URL}\n`),
    )
    process.stderr.write('\nTry running manually:\n')
    process.stderr.write(
      chalk.bold(`  npm uninstall -g ${MACRO.PACKAGE_URL}\n`),
    )
    if (isLikelyEacces(err)) {
      process.stderr.write(
        '\nThis looks like a permissions error on npm\'s global install\n' +
          'directory. If Node was installed via nvm, Homebrew, Volta, or fnm,\n' +
          'do NOT use sudo. Only use sudo if Node was installed system-wide\n' +
          '(e.g. via apt/yum or the nodejs.org installer):\n' +
          `  sudo npm uninstall -g ${MACRO.PACKAGE_URL}\n`,
      )
    } else {
      process.stderr.write(
        'Or with sudo if you installed with elevated permissions:\n',
      )
      process.stderr.write(
        chalk.bold(`  sudo npm uninstall -g ${MACRO.PACKAGE_URL}\n`),
      )
    }
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
