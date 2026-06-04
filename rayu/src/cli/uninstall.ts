import chalk from 'chalk'
import { homedir } from 'os'
import { execFileNoThrowWithCwd } from 'src/utils/execFileNoThrow.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { writeToStdout } from 'src/utils/process.js'

export async function uninstall() {
  writeToStdout(`Uninstalling Rayu CLI (${MACRO.VERSION})...\n`)
  writeToStdout(`Running: npm uninstall -g ${MACRO.PACKAGE_URL}\n\n`)

  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['uninstall', '-g', MACRO.PACKAGE_URL],
    { cwd: homedir() },
  )

  if (result.code !== 0) {
    process.stderr.write(
      chalk.red(`Failed to uninstall ${MACRO.PACKAGE_URL}\n`),
    )
    if (result.stderr) {
      process.stderr.write(result.stderr + '\n')
    }
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
    await gracefulShutdown(1)
    return
  }

  writeToStdout(
    chalk.green(
      `Successfully uninstalled ${MACRO.PACKAGE_URL} ${MACRO.VERSION}\n`,
    ),
  )
  writeToStdout('Thanks for using Rayu CLI!\n')
  await gracefulShutdown(0)
}
