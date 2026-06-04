import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { homedir } from 'os'
import { writeToStdout } from 'src/utils/process.js'

export async function update() {
  writeToStdout(`Current version: ${MACRO.VERSION}\n`)
  writeToStdout(`Checking for updates...\n`)

  // Check latest version from npm registry
  let latestVersion: string
  try {
    latestVersion = execFileSync(
      'npm',
      ['view', `${MACRO.PACKAGE_URL}@latest`, 'version', '--prefer-online'],
      { encoding: 'utf8', timeout: 15000, cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] },
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
    execFileSync(
      'npm',
      ['install', '-g', `${MACRO.PACKAGE_URL}@latest`],
      { encoding: 'utf8', cwd: homedir(), stdio: 'inherit' },
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
