// Rayu-CLI brand identity. Kept here as the single source of truth for the
// product name and CLI command. (API hostnames / model IDs below remain the
// providers' own identities and are intentionally unchanged.)
export const PRODUCT_NAME = 'Rayu-CLI'
export const PRODUCT_COMMAND = 'rayu'
export const PRODUCT_CONFIG_DIRNAME = '.rayu'

export const PRODUCT_URL = 'https://github.com/rayu-cli/rayu-cli'

// Human-readable changelog, linked from the "update available" notice (see
// src/utils/updateNotice.ts) so users can see what a new version contains
// before running `rayu update`. Kept here rather than in releaseNotes.ts so the
// notice helpers stay free of that module's axios/fs import weight;
// releaseNotes.ts' CHANGELOG_URL/RAW_CHANGELOG_URL point at the raw
// CHANGELOG.md in git, which is what the /release-notes command parses.
export const CHANGELOG_WEB_URL = 'https://rayucode.com/changelog'

// RAYU remote-session base URL. Rayu hardcodes no third-party remote-session
// host: the production base is sourced from RAYU_REMOTE_SESSION_URL (falling
// back to RAYU_WEB_URL) and is empty when neither is set. Remote-session
// viewing is a hosted add-on and is inert without a configured host — the
// remote bridge also requires an account login, which is disabled in Rayu.
export const REMOTE_SESSION_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * Determine if we're in a staging environment for remote sessions.
 * Checks session ID format and ingress URL.
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * Determine if we're in a local-dev environment for remote sessions.
 * Checks session ID format (e.g. `session_local_...`) and ingress URL.
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * Base URL for viewing a remote session. Local-dev sessions use localhost;
 * every other environment resolves to the Rayu-configured remote-session host
 * (empty when unset — Rayu hardcodes no third-party host).
 */
export function getRemoteSessionBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return REMOTE_SESSION_LOCAL_BASE_URL
  }
  return process.env.RAYU_REMOTE_SESSION_URL || process.env.RAYU_WEB_URL || ''
}

/**
 * Get the full session URL for a remote session (base + `/code/{id}`).
 *
 * The cse_→session_ translation is a prefix-shim handled by toCompatSessionId
 * (see src/bridge/sessionIdCompat.ts), lazy-required here to keep constants/ a
 * leaf of the module DAG at load time. When no remote-session host is
 * configured the base is empty and the result is a relative `/code/{id}` path.
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const baseUrl = getRemoteSessionBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
