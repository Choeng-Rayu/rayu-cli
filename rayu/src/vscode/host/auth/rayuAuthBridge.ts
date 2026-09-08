/**
 * The extension's view of the Rayu account session.
 *
 * ── ONE CREDENTIAL, TWO SURFACES ───────────────────────────────────────────────
 *
 * This file is the extension's OWN auth module, but it is emphatically NOT a
 * second credential store. Every read and write goes through
 * `services/rayuAuth/rayuSession.ts`, which owns `~/.rayu/rayu-auth.json` at mode
 * 0600. Sign in from the CLI and the extension is signed in; sign in from the
 * extension and the CLI is too. Whichever happens first, the other syncs.
 *
 * A second store was the obvious-looking alternative and it is a trap. The backend
 * ROTATES the refresh token on every `/cli/refresh`: two stores means two refresh
 * cycles racing over the same token, and the loser is logged out with no
 * explanation and no way to tell why. Sharing the file makes that impossible
 * rather than unlikely.
 *
 * What is genuinely per-surface is the LOGIN TRANSPORT — how the browser gets
 * opened and how the callback comes back — and that lives in `vscodeLogin.ts`.
 * That is the whole extent of the split.
 *
 * ── TOKENS DO NOT CROSS INTO THE WEBVIEW ───────────────────────────────────────
 *
 * The webview is web content rendering model and tool output. It gets a boolean
 * and a display name; it never gets an access token, a refresh token, or an
 * expiry. `toWebviewIdentity()` is the only shape that leaves this module for the
 * UI, and it exists so the omission is a deliberate mapping rather than a field
 * someone forgot to strip.
 */
import { join } from 'node:path'

import {
  clearRayuSession,
  hasRayuSession,
  isUseRayuOAuthEnabled,
  readRayuSession,
  rayuLoginGateMessage,
  getValidRayuAccessToken,
} from '../../../services/rayuAuth/rayuSession.js'
import { getRayuConfigHomeDir } from '../../../utils/envUtils.js'

/** Filename owned by `rayuSession.ts`; mirrored here only for the watcher. */
const SESSION_FILE = 'rayu-auth.json'

/** Identity as the WEBVIEW is allowed to see it. No secrets, by construction. */
export interface WebviewIdentity {
  email: string | null
  displayName: string | null
}

export interface AuthSnapshot {
  /** True when a usable Rayu credential exists — a session OR a validated API key. */
  signedIn: boolean
  /**
   * Why a turn would be refused, phrased for an editor, or null when it would
   * proceed.
   *
   * ── THE DECISION IS SHARED; THE WORDING IS NOT ───────────────────────────────
   *
   * Whether to gate comes from `rayuLoginGateMessage()`, the SAME function the
   * CLI's REPL and the engine's headless path consult. That part must never be
   * re-derived: a prompt allowed by the panel and refused by the engine is worse
   * than no gate at all, because the user sees a failure instead of a requirement.
   *
   * The TEXT is a different matter. The shared message reads "Run /login to sign
   * in, or /connect → Rayu to use a Rayu API key" — correct instructions for a
   * terminal, and wrong ones in a panel that has buttons for both. So this carries
   * editor wording, exactly as `formatActivityForVSCode` renders the same activity
   * differently from the Telegram and web formatters.
   */
  gateMessage: string | null
  /** Null when signed out, or when signed in via API key rather than an account. */
  identity: WebviewIdentity | null
  /** Whether Rayu account login is switched on at all. */
  oauthEnabled: boolean
}

/**
 * Editor-appropriate phrasing for the gate.
 *
 * Says what is required, not which slash command to type. The panel supplies the
 * actions.
 */
const EDITOR_GATE_MESSAGE =
  'Sign in to Rayu to start a session. You can sign in with your Rayu account, ' +
  'or connect a Rayu API key instead.'

/** Absolute path of the shared session file. Used by the watcher. */
export function sessionFilePath(): string {
  return join(getRayuConfigHomeDir(), SESSION_FILE)
}

/** The directory holding it. Watched instead of the file — see `authWatcher.ts`. */
export function sessionDirPath(): string {
  return getRayuConfigHomeDir()
}

/**
 * Read the current state. Cheap and synchronous, so it is safe on the UI path.
 *
 * Deliberately does NOT refresh the token. Refreshing is a network call, and a
 * snapshot used to decide which surface to render must not block on the network —
 * an offline user would get a hung panel instead of a transcript.
 */
export function getAuthSnapshot(): AuthSnapshot {
  // The shared gate is the authority on WHETHER to block. `hasRayuSession()` alone
  // would be wrong: a validated Rayu API key satisfies the gate too, and a user who
  // connected that way is fully entitled to send a prompt. Keying the UI off the
  // session would tell them to sign in for something they can already do.
  const blocked = rayuLoginGateMessage() !== null
  const session = readRayuSession()

  return {
    signedIn: !blocked,
    gateMessage: blocked ? EDITOR_GATE_MESSAGE : null,
    identity: session
      ? {
          email: session.user?.email ?? null,
          displayName: session.user?.displayName ?? null,
        }
      : null,
    oauthEnabled: isUseRayuOAuthEnabled(),
  }
}

/** True when an account session exists, as distinct from an API key. */
export function hasAccountSession(): boolean {
  return hasRayuSession()
}

/**
 * Forget the session.
 *
 * Writes through the shared store, so the CLI observes it too. That is the
 * intended behaviour: one credential means one sign-out.
 */
export function signOutShared(): void {
  clearRayuSession()
}

/**
 * A valid access token for a host-side backend call, refreshing if needed.
 *
 * HOST ONLY. Nothing that returns this value may be forwarded to the webview.
 */
export async function getAccessTokenForHost(): Promise<string | null> {
  return await getValidRayuAccessToken()
}
