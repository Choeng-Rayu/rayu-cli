/**
 * The host's side of `--rayucode-account`: signing out of Rayu through a short-lived
 * engine child, which clears everything the CLI's /logout clears in Rayucode's profile.
 *
 * If the child cannot run, the sign-out still happens — the session file, which every
 * surface reads, is cleared in the host — and the caches it could not clear are left
 * for the next sign-in to replace. Free of `vscode` imports.
 */
import { clearFeatureUsage } from '../../../services/rayuAuth/rayuFeatureUsage.js'
import { invalidateRayuConfigCache } from '../../../utils/rayuConfig.js'
import { ACCOUNT_FLAG, type AccountChildAction } from '../../shared/accountChildProtocol.js'
import type { AccountPart } from '../../shared/settingsProtocol.js'
import { signOutShared } from '../auth/rayuAuthBridge.js'
import { runEngineChild, stderrExcerpt, type EngineLaunch } from '../engine/engineLaunch.js'

/** Clearing a few files; generous for a cold engine start. */
const ACCOUNT_TIMEOUT_MS = 30_000

export async function signOutThroughEngine(launch: EngineLaunch): Promise<AccountPart<true>> {
  const action: AccountChildAction = { action: 'sign-out' }
  const result = await runEngineChild<AccountPart<true>>(launch, {
    flag: ACCOUNT_FLAG,
    stdin: JSON.stringify(action),
    timeoutMs: ACCOUNT_TIMEOUT_MS,
    onFrame: frame => {
      if (frame.type !== 'rayucode_account_result') return undefined
      return frame.ok === true
        ? { ok: true, value: true }
        : { ok: false, error: typeof frame.error === 'string' ? frame.error : 'Signing out failed.' }
    },
  })
  switch (result.kind) {
    case 'done':
      return result.value
    case 'exited':
      return { ok: false, error: `The sign-out helper stopped (code ${result.code}).${stderrExcerpt(result.stderrTail)}` }
    case 'timeout':
      return { ok: false, error: 'The sign-out helper did not respond in time.' }
    case 'spawn-error':
    case 'protocol-error':
      return { ok: false, error: result.message }
    case 'aborted':
      return { ok: false, error: 'Cancelled.' }
  }
}

export interface SignOutDeps {
  signOutThroughEngine(): Promise<AccountPart<true>>
  /** The session file only: what the host can clear itself. */
  clearSession(): void
  /** This process's own caches of the account. */
  clearHostCaches(): void
  warn(message: string): void
}

/** Sign Rayucode out. Never fails: at worst only the session itself is cleared. */
export async function signOutRayucode(deps: SignOutDeps): Promise<void> {
  const outcome = await deps.signOutThroughEngine()
  if (!outcome.ok) {
    deps.warn(`[rayucode] full sign-out failed, cleared the session only: ${outcome.error}`)
    deps.clearSession()
  }
  deps.clearHostCaches()
}

export function liveSignOutDeps(launch: EngineLaunch): SignOutDeps {
  return {
    signOutThroughEngine: () => signOutThroughEngine(launch),
    clearSession: signOutShared,
    clearHostCaches: () => {
      clearFeatureUsage()
      // The child removed the rayu-hosted provider; do not wait for the file watcher.
      invalidateRayuConfigCache()
    },
    warn: message => console.warn(message),
  }
}
