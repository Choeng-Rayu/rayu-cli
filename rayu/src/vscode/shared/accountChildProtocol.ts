/**
 * The `--rayucode-account` helper: the extension host asks a short-lived engine child to
 * sign out of Rayu, because the clean-up (`src/services/rayuAuth/rayuSignOut.ts`) reaches
 * the engine's logger and provider configuration, which the host bundle does not carry.
 *
 * Same shape as the other helper flags: one action as JSON on stdin, NDJSON frames on
 * stdout, ending with exactly one result frame. A dependency-free leaf, so the host can
 * share the contract without importing the engine entrypoint.
 */

export const ACCOUNT_FLAG = '--rayucode-account'

export type AccountChildAction = { action: 'sign-out' }

export interface AccountResultFrame {
  type: 'rayucode_account_result'
  ok: boolean
  /** Already user-facing. */
  error?: string
  /** Whether an account session was signed out (false: there was none). */
  hadSession?: boolean
}
