import chalk from 'chalk'
import { createInterface } from 'node:readline'
import { writeToStdout } from 'src/utils/process.js'
import {
  describePlan,
  executeUninstall,
  planUninstall,
} from './uninstall/uninstallService.js'
import { NEVER_REMOVED } from './uninstall/scopeManifest.js'

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

/**
 * `rayu uninstall` — remove RAYU from this machine.
 *
 * Now a thin front-end over the uninstall lifecycle service, which is shared with
 * the remote (Telegram) operation so both obey the same scope manifest and the
 * same success criteria.
 *
 * Behaviour change worth knowing: this used to run `npm uninstall -g`
 * unconditionally and report success regardless. It now DETECTS the install
 * method first, and on a Homebrew / deb / rpm / mise / asdf / winget install it
 * says so and prints the correct command instead of pretending to have removed
 * something.
 *
 * Flags: `--yes`/`-y` (skip prompts), `--keep-data` (preserve config, provider
 * keys, and history), `--dry-run` (print the plan and exit).
 */
export async function uninstall(args: string[] = []) {
  const yes = args.includes('--yes') || args.includes('-y')
  const keepData = args.includes('--keep-data')
  const dryRun = args.includes('--dry-run')

  const plan = await planUninstall({ keepData })

  writeToStdout(`Rayu CLI ${MACRO.VERSION}\n\n`)
  for (const line of describePlan(plan)) writeToStdout(`${line}\n`)
  writeToStdout('\nNever removed:\n')
  for (const item of NEVER_REMOVED) writeToStdout(`  • ${item}\n`)
  writeToStdout('\n')

  if (dryRun) {
    writeToStdout(chalk.dim('Dry run — nothing was changed.\n'))
    process.exit(0)
    return
  }

  if (plan.install.method === 'development') {
    process.stderr.write(
      chalk.yellow(
        'Running from a source checkout — there is no installation to remove.\n',
      ),
    )
    process.exit(1)
    return
  }

  if (plan.present.length === 0 && !plan.canRemovePackage) {
    writeToStdout('Nothing for RAYU to remove.\n')
    if (plan.install.manualCommand) {
      writeToStdout(`Run this to finish: ${plan.install.manualCommand}\n`)
    }
    process.exit(0)
    return
  }

  const hasUserData = plan.present.some(a => a.userData)
  if (!yes) {
    const question = hasUserData
      ? 'Remove RAYU, including saved provider API keys and session history?'
      : 'Remove RAYU?'
    if (!(await confirm(question, false))) {
      writeToStdout('Cancelled — nothing was changed.\n')
      process.exit(0)
      return
    }
  }

  const report = await executeUninstall({ keepData })

  writeToStdout('\n')
  for (const step of report.steps) {
    const mark = step.ok ? chalk.green('✓') : chalk.red('✗')
    writeToStdout(`${mark} ${step.label}${step.detail ? ` — ${step.detail}` : ''}\n`)
  }
  writeToStdout('\n')

  if (report.outcome === 'completed') {
    writeToStdout(chalk.green('RAYU has been removed. Thanks for using Rayu CLI!\n'))
    process.exit(0)
    return
  }

  // PARTIAL / FAILED: say exactly what is left, so the user can finish the job.
  process.stderr.write(
    chalk.yellow(
      report.outcome === 'partial'
        ? '\nUninstall was PARTIAL — some things remain:\n'
        : '\nUninstall FAILED — nothing was removed:\n',
    ),
  )
  for (const leftover of report.leftovers) {
    process.stderr.write(`  • ${leftover}\n`)
  }
  if (report.manualCommand) {
    process.stderr.write(`\nRun this to finish: ${report.manualCommand}\n`)
  }
  process.exit(1)
}
