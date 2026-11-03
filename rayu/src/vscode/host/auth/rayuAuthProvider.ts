/**
 * Rayu in VS Code's Accounts menu: who is signed in, "Sign in with Rayu", and "Sign Out".
 *
 * A thin adapter over Rayucode's existing sign-in: `createSession` runs the same
 * editor-native login as the Sign In button, `removeSession` the same sign-out, and the
 * session list is read from Rayucode's profile. The session's token is a placeholder —
 * see `authProviderCore.ts` for why Rayu's real token is never handed to VS Code.
 */
import * as vscode from 'vscode'

import {
  RAYU_AUTH_PROVIDER_ID,
  RAYU_AUTH_PROVIDER_LABEL,
  diffSessions,
  sessionFor,
  type AccountSessionLike,
  type AccountUser,
} from './authProviderCore.js'

export interface RayuAuthProviderDeps {
  currentUser(): AccountUser | null
  /** The editor-native sign-in. Resolves once it has finished, successfully or not. */
  signIn(): Promise<void>
  /** Sign out, without asking again: the Accounts menu has already asked. */
  signOut(): Promise<void>
}

export class RayuAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
  readonly onDidChangeSessions = this.changes.event
  private last: AccountSessionLike | null

  constructor(private readonly deps: RayuAuthProviderDeps) {
    this.last = this.current()
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const session = this.current()
    return session ? [session] : []
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    await this.deps.signIn()
    const session = this.current()
    if (!session) throw new Error('Sign-in to Rayu was not completed.')
    this.refresh()
    return session
  }

  async removeSession(): Promise<void> {
    await this.deps.signOut()
    this.refresh()
  }

  /** Re-read the sign-in and tell VS Code what changed. Called when the profile changes. */
  refresh(): void {
    const next = this.current()
    const change = diffSessions(this.last, next)
    this.last = next
    if (change) this.changes.fire(change)
  }

  dispose(): void {
    this.changes.dispose()
  }

  private current(): AccountSessionLike | null {
    const user = this.deps.currentUser()
    return user ? sessionFor(user) : null
  }
}

/**
 * Register the provider and make the signed-in account appear in the Accounts menu.
 *
 * VS Code lists an account there once an extension has asked for its session, so
 * Rayucode asks for its own — silently: no prompt, and nothing when signed out.
 */
export function registerRayuAuthProvider(context: vscode.ExtensionContext, deps: RayuAuthProviderDeps): RayuAuthProvider {
  const provider = new RayuAuthProvider(deps)
  const announce = (): void => {
    void Promise.resolve(vscode.authentication.getSession(RAYU_AUTH_PROVIDER_ID, [], { silent: true })).catch(() => {
      // Only affects whether the menu lists the account; nothing to report.
    })
  }
  context.subscriptions.push(
    provider,
    vscode.authentication.registerAuthenticationProvider(RAYU_AUTH_PROVIDER_ID, RAYU_AUTH_PROVIDER_LABEL, provider, {
      supportsMultipleAccounts: false,
    }),
    provider.onDidChangeSessions(() => announce()),
  )
  announce()
  return provider
}
