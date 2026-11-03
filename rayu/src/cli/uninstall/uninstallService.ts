/**
 * The uninstall lifecycle service.
 *
 * Plans an uninstall (what would be removed, and whether RAYU can do it at all)
 * and executes it, reporting an honest outcome. Shared by the interactive
 * `rayu uninstall` and — from Task 17 — by the remote Telegram operation, so both
 * are subject to the same scope manifest and the same success criteria.
 *
 * PARTIAL IS THE DEFAULT OUTCOME. `completed` is only returned when every planned
 * artifact is verified GONE afterwards. Reporting success while files remain is
 * exactly the failure the previous npm-only implementation had, and it is far
 * worse remotely than locally: the user is told their machine is clean and stops
 * looking.
 */

import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import {
  buildNpmRemediation,
  describeNpmError,
  execNpmSync,
} from '../../utils/npmExec.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { detectInstallMethod, type InstallMethodInfo } from './installMethod.js'
import {
  buildScopeManifest,
  isPathInScope,
  type ScopedArtifact,
} from './scopeManifest.js'

/** Outcome of an uninstall attempt. */
export type UninstallOutcome = 'completed' | 'partial' | 'failed'

export interface UninstallPlan {
  install: InstallMethodInfo
  /** Everything in scope, already filtered by `keepData`. */
  artifacts: ScopedArtifact[]
  /** Artifacts that exist right now — what would actually be removed. */
  present: ScopedArtifact[]
  /** True when the package removal step can be performed by RAYU. */
  canRemovePackage: boolean
}

export interface UninstallStepResult {
  label: string
  ok: boolean
  detail?: string
}

export interface UninstallReport {
  outcome: UninstallOutcome
  install: InstallMethodInfo
  steps: UninstallStepResult[]
  /** Artifacts still present after the attempt. Non-empty ⇒ never `completed`. */
  leftovers: string[]
  /** Command the user must run themselves, when RAYU cannot finish the job. */
  manualCommand?: string
}

export interface UninstallOptions {
  /** Preserve config, provider keys, and history. */
  keepData?: boolean
}

/**
 * Work out what an uninstall would do, without doing any of it.
 *
 * Backs both `--dry-run` and the Telegram confirmation card: the user should see
 * the real artifact list before approving, not a generic warning.
 */
export async function planUninstall(
  options: UninstallOptions = {},
): Promise<UninstallPlan> {
  const install = await detectInstallMethod()
  const all = buildScopeManifest(install.method)
  const artifacts = options.keepData ? all.filter(a => !a.userData) : all
  return {
    install,
    artifacts,
    present: artifacts.filter(a => existsSync(a.path)),
    canRemovePackage: install.selfRemovable,
  }
}

/**
 * Remove the installed package for methods RAYU owns.
 *
 * Native installs are handled by artifact removal (their binaries ARE scoped
 * artifacts), so only npm-global needs an external command here.
 */
function removePackage(install: InstallMethodInfo): UninstallStepResult {
  if (install.method === 'npm-global') {
    try {
      execNpmSync(['uninstall', '-g', MACRO.PACKAGE_URL], { stdio: 'inherit' })
      return { label: `npm uninstall -g ${MACRO.PACKAGE_URL}`, ok: true }
    } catch (e) {
      return {
        label: `npm uninstall -g ${MACRO.PACKAGE_URL}`,
        ok: false,
        detail: [describeNpmError(e), buildNpmRemediation('uninstall', MACRO.PACKAGE_URL, e)]
          .filter(Boolean)
          .join(' — '),
      }
    }
  }
  if (install.method === 'native') {
    // The native binary and versions dir are in the manifest, so there is no
    // separate package step. Reported so the log shows the decision was made.
    return { label: 'native install (removed as scoped artifacts)', ok: true }
  }
  if (install.method === 'installer') {
    // Same shape as native: the launcher, the versioned bundles and the private
    // Node runtime are all scoped artifacts. Running npm here would be actively
    // wrong — it would uninstall an unrelated npm copy the user may still want.
    return {
      label: 'installer-managed install (removed as scoped artifacts)',
      ok: true,
    }
  }
  return {
    label: `package removal skipped (${install.method})`,
    ok: false,
    detail: install.manualCommand
      ? `run: ${install.manualCommand}`
      : install.reason,
  }
}

/**
 * Remove one artifact, refusing anything outside the manifest.
 *
 * The in-scope check is repeated here even though the caller only passes
 * manifest entries. This is the last line before an irreversible `rm -rf`, and a
 * guard that only runs at the call site is a guard that a future caller can skip.
 */
async function removeArtifact(
  artifact: ScopedArtifact,
  manifest: readonly ScopedArtifact[],
): Promise<UninstallStepResult> {
  if (!isPathInScope(artifact.path, manifest)) {
    return {
      label: artifact.label,
      ok: false,
      detail: `refused: ${artifact.path} is outside the RAYU-owned scope`,
    }
  }
  if (!existsSync(artifact.path)) {
    return { label: artifact.label, ok: true, detail: 'already absent' }
  }
  try {
    await rm(artifact.path, {
      recursive: artifact.kind === 'directory',
      force: true,
    })
    // Verify rather than trust: `rm` with force resolves successfully for paths
    // it could not remove in some edge cases (permissions, open handles on
    // Windows), and an unverified success is what produces a false `completed`.
    if (existsSync(artifact.path)) {
      return {
        label: artifact.label,
        ok: false,
        detail: `still present after removal: ${artifact.path}`,
      }
    }
    return { label: artifact.label, ok: true }
  } catch (e) {
    return { label: artifact.label, ok: false, detail: errorMessage(e) }
  }
}

/**
 * Execute an uninstall.
 *
 * Artifacts are removed in manifest order, which puts the config directory LAST —
 * so if removal fails partway the remote-control state (telegram.json, the
 * attachment pointer, the device identity) is already gone. A half-uninstalled
 * machine should not still be drivable from a chat.
 */
export async function executeUninstall(
  options: UninstallOptions = {},
): Promise<UninstallReport> {
  const plan = await planUninstall(options)
  const steps: UninstallStepResult[] = []

  if (plan.install.method === 'development') {
    return {
      outcome: 'failed',
      install: plan.install,
      steps: [{ label: 'development checkout', ok: false, detail: plan.install.reason }],
      leftovers: [],
    }
  }

  steps.push(removePackage(plan.install))

  for (const artifact of plan.artifacts) {
    steps.push(await removeArtifact(artifact, plan.artifacts))
  }

  const leftovers = plan.artifacts
    .map(a => a.path)
    .filter(path => existsSync(path))

  // `completed` requires BOTH: every step succeeded and nothing is left behind.
  const allStepsOk = steps.every(step => step.ok)
  const outcome: UninstallOutcome =
    allStepsOk && leftovers.length === 0
      ? 'completed'
      : leftovers.length === plan.artifacts.length && !plan.canRemovePackage
        ? 'failed'
        : 'partial'

  logForDebugging(
    `[uninstall] outcome=${outcome} method=${plan.install.method} leftovers=${leftovers.length}`,
  )

  return {
    outcome,
    install: plan.install,
    steps,
    leftovers,
    ...(plan.install.manualCommand ? { manualCommand: plan.install.manualCommand } : {}),
  }
}

/** Human-readable plan, used by `--dry-run` and the confirmation card. */
export function describePlan(plan: UninstallPlan): string[] {
  const lines: string[] = []
  lines.push(`Install method: ${plan.install.method} (${plan.install.reason})`)
  if (!plan.canRemovePackage) {
    lines.push(
      plan.install.manualCommand
        ? `RAYU cannot remove this install itself. Run: ${plan.install.manualCommand}`
        : 'RAYU cannot remove this install itself.',
    )
  }
  lines.push('')
  if (plan.present.length === 0) {
    lines.push('Nothing to remove — no RAYU artifacts found.')
  } else {
    lines.push('Would remove:')
    for (const artifact of plan.present) {
      lines.push(`  • ${artifact.label}`)
      lines.push(`    ${artifact.path}`)
    }
  }
  return lines
}
