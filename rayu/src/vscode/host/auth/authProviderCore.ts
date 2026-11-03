/**
 * The Rayu account as VS Code's Accounts menu sees it — the pure part of
 * `rayuAuthProvider.ts`.
 *
 * ── THE SESSION CARRIES NO CREDENTIAL ──────────────────────────────────────────
 *
 * An authentication provider's sessions can be requested by ANY extension through
 * `vscode.authentication.getSession('rayu', …)`; once the user grants that extension
 * access, it receives `accessToken`. Rayu's JWT spends the user's credits and reads their
 * account, and no other extension needs it, so the session's token is a fixed
 * placeholder. Rayucode itself never reads it: its requests use the token in its own
 * profile, in the extension host.
 *
 * Free of `vscode` imports; the shapes below are structurally VS Code's own.
 */

/** Also the `contributes.authentication` id in the manifest. */
export const RAYU_AUTH_PROVIDER_ID = 'rayu'
export const RAYU_AUTH_PROVIDER_LABEL = 'Rayu'

/** Not a credential: see the header. */
export const PLACEHOLDER_ACCESS_TOKEN = 'rayucode-account'

export interface AccountUser {
  id: number
  email: string | null
  displayName: string | null
}

export interface AccountSessionLike {
  readonly id: string
  readonly accessToken: string
  readonly account: { readonly id: string; readonly label: string }
  readonly scopes: readonly string[]
}

export interface SessionsChange {
  added: AccountSessionLike[]
  removed: AccountSessionLike[]
  changed: AccountSessionLike[]
}

export function accountLabel(user: AccountUser): string {
  return user.displayName?.trim() || user.email?.trim() || 'Rayu account'
}

export function sessionFor(user: AccountUser): AccountSessionLike {
  return {
    id: `rayu-${user.id}`,
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    account: { id: String(user.id), label: accountLabel(user) },
    scopes: [],
  }
}

/**
 * What changed between two sign-in states, or null when nothing did. A different user
 * is a removal and an addition; the same user with a new name is a change.
 */
export function diffSessions(previous: AccountSessionLike | null, next: AccountSessionLike | null): SessionsChange | null {
  if (!previous && !next) return null
  if (previous && next && previous.id === next.id) {
    return previous.account.label === next.account.label ? null : { added: [], removed: [], changed: [next] }
  }
  return { added: next ? [next] : [], removed: previous ? [previous] : [], changed: [] }
}
