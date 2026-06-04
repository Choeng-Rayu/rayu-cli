import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import { homedir } from 'os'
import { writeToStdout } from 'src/utils/process.js'

export async function uninstall() {
  writeToStdout(`Uninstalling Rayu CLI (${MACRO.VERSION})...\n`)
  writeToStdout(`Running: npm uninstall -g ${MACRO.PACKAGE_URL}\n\n`)

  try {
    execFileSync(
      'npm',
      ['uninstall', '-g', MACRO.PACKAGE_URL],
      { encoding: 'utf8', cwd: homedir(), stdio: 'inherit' },
    )
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
  }

  writeToStdout(
    chalk.green(
      `\nSuccessfully uninstalled ${MACRO.PACKAGE_URL} ${MACRO.VERSION}\n`,
    ),
  )
  writeToStdout('Thanks for using Rayu CLI!\n')
  process.exit(0)
}
