// The Claude.ai subscription (Pro / Max plan) credential slot.
//
// This is the ONLY place the Anthropic OAuth tokens are read from or written to
// disk. They live under the `claudeAiOauth` key of secureStorage
// (~/.rayu/.credentials.json at mode 0600, or the macOS keychain when
// available) — a slot entirely SEPARATE from the Rayu account JWT in
// services/rayuAuth, so `/login` (Rayu) and `/connect → Login with Claude`
// never clobber each other.
//
// utils/auth.ts re-exports thin wrappers over this module (getClaudeAIOAuthTokens,
// saveOAuthTokensIfNeeded, checkAndRefreshOAuthTokenIfNeeded, …) because that is
// the surface the rest of the CLI already imports. Everything stateful lives here.
//
// SECURITY: token VALUES are never logged — only booleans/expiry timings are.
// The refresh call is single-flight (see refreshPromise) so N concurrent Claude
// requests hitting an expired token produce ONE refresh, not N (a second refresh
// with an already-rotated refresh_token would fail and log the user out).
import { logForDebugging } from '../../utils/debug.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import type { OAuthTokens } from './types.js'

/** secureStorage key holding the Claude.ai subscription tokens. */
export const CLAUDE_AI_OAUTH_STORAGE_KEY = 'claudeAiOauth'

/**
 * Refresh this long before the access token actually expires, so a request that
 * is built now cannot arrive after expiry.
 */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

/** Max attempts for a single logical refresh (transient network failures). */
const MAX_REFRESH_ATTEMPTS = 3

/**
 * True when a token with this absolute expiry should be refreshed now.
 * `null` means "no known expiry" — never treated as expired.
 */
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false
  }
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
}

function isUsableTokenRecord(value: unknown): value is OAuthTokens {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<OAuthTokens>
  return (
    typeof record.accessToken === 'string' &&
    record.accessToken.length > 0 &&
    Array.isArray(record.scopes)
  )
}

/** Read the stored tokens (sync). Returns null when not signed in. */
export function readClaudeAIOAuthTokens(): OAuthTokens | null {
  try {
    const stored = getSecureStorage().read()?.[CLAUDE_AI_OAUTH_STORAGE_KEY]
    return isUsableTokenRecord(stored) ? stored : null
  } catch {
    // An unreadable credential store is "not signed in", never a crash.
    return null
  }
}

/**
 * Read the stored tokens without a blocking keychain read on the hot path.
 * Falls back to the sync reader when the storage backend has no async form.
 */
export async function readClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  try {
    const storage = getSecureStorage()
    const data = storage.readAsync
      ? await storage.readAsync()
      : storage.read()
    const stored = data?.[CLAUDE_AI_OAUTH_STORAGE_KEY]
    return isUsableTokenRecord(stored) ? stored : null
  } catch {
    return null
  }
}

/**
 * Persist the tokens, preserving every other credential in the store
 * (read-modify-write — the storage API writes the whole blob).
 */
export function writeClaudeAIOAuthTokens(tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  try {
    const storage = getSecureStorage()
    const existing = storage.read() ?? {}
    const result = storage.update({
      ...existing,
      [CLAUDE_AI_OAUTH_STORAGE_KEY]: tokens,
    })
    return result ?? { success: false }
  } catch {
    return { success: false }
  }
}

/** Forget the subscription login. Leaves every other credential untouched. */
export function deleteClaudeAIOAuthTokens(): boolean {
  try {
    const storage = getSecureStorage()
    const existing = storage.read()
    if (!existing?.[CLAUDE_AI_OAUTH_STORAGE_KEY]) return true
    delete existing[CLAUDE_AI_OAUTH_STORAGE_KEY]
    return storage.update(existing)?.success ?? false
  } catch {
    return false
  }
}

/** Granted scopes of the stored login (empty when not signed in). */
export function claudeAIOAuthScopes(): string[] {
  return readClaudeAIOAuthTokens()?.scopes ?? []
}

// --- single-flight refresh --------------------------------------------------

let refreshPromise: Promise<boolean> | null = null

/**
 * Refresh the stored access token when it is at (or near) expiry.
 *
 * Returns true when a VALID token is available afterwards — including the case
 * where no refresh was necessary. Returns false when there is no subscription
 * login, or when the refresh definitively failed.
 *
 * Single-flight: concurrent callers share one in-flight refresh. This matters
 * because the refresh_token rotates — two parallel refreshes would race, and the
 * loser would persist a token the server has already invalidated.
 */
export async function refreshClaudeAIOAuthTokensIfNeeded(
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const tokens = readClaudeAIOAuthTokens()
  if (!tokens?.refreshToken) {
    // Nothing stored, or a token with no refresh capability: usable as-is if it
    // has not expired, otherwise there is nothing we can do here.
    return !!tokens?.accessToken && !isOAuthTokenExpired(tokens.expiresAt ?? null)
  }

  if (!opts.force && !isOAuthTokenExpired(tokens.expiresAt ?? null)) {
    return true
  }

  if (refreshPromise) {
    return refreshPromise
  }

  refreshPromise = performRefresh(tokens).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function performRefresh(tokens: OAuthTokens): Promise<boolean> {
  // Dynamic import: client.ts pulls in axios + the profile fetcher, and it
  // imports utils/auth.ts (which imports this module). Loading it lazily keeps
  // that cycle out of module-evaluation order and off the startup path.
  const { refreshOAuthToken } = await import('./client.js')

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      const refreshed = await refreshOAuthToken(tokens.refreshToken, {
        scopes: tokens.scopes,
      })
      const merged: OAuthTokens = {
        ...refreshed,
        // The refresh response omits the account block on some grants; keep the
        // one we already had so the /connect status view doesn't lose the email.
        tokenAccount: refreshed.tokenAccount ?? tokens.tokenAccount,
        profile: refreshed.profile ?? tokens.profile,
      }
      const { success } = writeClaudeAIOAuthTokens(merged)
      if (!success) {
        logForDebugging('[oauth] refreshed token could not be persisted', {
          level: 'error',
        })
        return false
      }
      logForDebugging('[oauth] access token refreshed')
      return true
    } catch (error) {
      lastError = error
      if (attempt < MAX_REFRESH_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt))
      }
    }
  }
  logForDebugging(
    `[oauth] token refresh failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { level: 'error' },
  )
  return false
}

/** Drop any in-flight refresh (tests / logout). */
export function resetClaudeAIOAuthRefreshState(): void {
  refreshPromise = null
}
