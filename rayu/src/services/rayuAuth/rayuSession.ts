// Rayu account session for the CLI.
//
// This is the CLI half of the "Rayu login" feature. It is entirely OPT-IN via
// the USE_RAYU_OAUTH env flag: when the flag is unset/false the CLI behaves
// exactly as before and none of this code changes the user experience.
//
// It mirrors the storage pattern of googleOAuth.ts: the session (access +
// refresh token issued by rayu-backend after a Clerk login) is persisted to
// ~/.rayu/rayu-auth.json with 0600 permissions and never logged.
//
// NOTE: This is the Rayu *account* session — distinct from the Anthropic
// "Claude AI" provider OAuth (src/utils/auth.ts), which remains untouched and
// continues to power the Anthropic provider login.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'

const SESSION_FILE = 'rayu-auth.json'
const REFRESH_SKEW_MS = 60 * 1000

export interface RayuSessionUser {
  id: number
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  role: string
}

export interface RayuSessionStore {
  accessToken: string
  refreshToken: string
  /** Absolute expiry of accessToken (epoch ms). */
  expiresAt: number
  user: RayuSessionUser
}

/**
 * True when the user has opted into Rayu account login.
 *
 * Resolution order: runtime env var USE_RAYU_OAUTH (dev override) → baked
 * build-time default (MACRO.RAYU_OAUTH_DEFAULT, set when publishing) → false.
 * This is why a published binary with no .env can still require login: the
 * default is compiled into dist/rayu.js at build time (bun --define inlines
 * MACRO.*; scripts/preload.ts provides it in dev/test).
 */
export function isUseRayuOAuthEnabled(): boolean {
  const env = process.env.USE_RAYU_OAUTH
  if (env !== undefined && env !== '') return isEnvTruthy(env)
  return isEnvTruthy(MACRO.RAYU_OAUTH_DEFAULT || 'false')
}

/** Base URL of the rayu-backend API (no trailing slash). */
export function getRayuApiBaseUrl(): string {
  const base =
    process.env.RAYU_API_URL ||
    MACRO.RAYU_API_URL ||
    'http://localhost:4000/api'
  return base.replace(/\/$/, '')
}

/** Base URL of the rayu-web site (no trailing slash). */
export function getRayuWebBaseUrl(): string {
  const base =
    process.env.RAYU_WEB_URL || MACRO.RAYU_WEB_URL || 'http://localhost:3000'
  return base.replace(/\/$/, '')
}

function sessionPath(): string {
  return join(getRayuConfigHomeDir(), SESSION_FILE)
}

export function readRayuSession(): RayuSessionStore | null {
  try {
    const p = sessionPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as RayuSessionStore
  } catch {
    return null
  }
}

export function writeRayuSession(store: RayuSessionStore): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = sessionPath()
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // best-effort on non-POSIX
  }
}

/** True when a Rayu session token has been stored (user has logged in). */
export function hasRayuSession(): boolean {
  return !!readRayuSession()?.accessToken
}

/** Forget the stored Rayu session. */
export function clearRayuSession(): void {
  try {
    rmSync(sessionPath(), { force: true })
  } catch {
    // ignore
  }
}

/**
 * Best-effort per-tool usage ping. Records which tool the signed-in user
 * invoked (with the active provider/model) so Rayu can track tool usage per
 * user. Never throws, never blocks, and no-ops when not signed in / flag off.
 */
export async function recordRayuToolUsageBestEffort(tool: string): Promise<void> {
  try {
    if (!isUseRayuOAuthEnabled()) return
    const token = await getValidRayuAccessToken()
    if (!token) return
    let provider = 'unknown'
    let model: string | null = null
    try {
      const { getActiveProvider } = await import('../../utils/rayuConfig.js')
      const p = getActiveProvider()
      if (p) {
        provider = p.id
        model = p.defaultModel ?? null
      }
    } catch {
      // active provider unavailable — still record the tool with 'unknown'
    }
    await getFetch()(`${getRayuApiBaseUrl()}/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider, model, tool, source: 'cli' }),
    })
  } catch {
    // swallow — usage tracking must never affect the CLI session
  }
}

/**
 * Login gate used before the first model query. Returns a user-facing message
 * when the request should be blocked (Rayu OAuth enabled but not logged in),
 * or null when the request may proceed.
 *
 * Pure/synchronous and cheap so it is safe to call on the prompt hot path. When
 * USE_RAYU_OAUTH is off this always returns null (no behavior change).
 */
export function rayuLoginGateMessage(): string | null {
  if (!isUseRayuOAuthEnabled()) return null
  if (hasRayuSession()) return null
  return 'You need to sign in to use Rayu. Run /login to sign in, then send your message again.'
}

// --- HTTP (injectable for tests) -------------------------------------------

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

let fetchOverride: FetchLike | null = null

export function _setRayuFetchForTesting(f: FetchLike | null): void {
  fetchOverride = f
}

function getFetch(): FetchLike {
  if (fetchOverride) return fetchOverride
  return globalThis.fetch as unknown as FetchLike
}

/**
 * Return a non-expired access token, refreshing via /cli/refresh when needed.
 * Returns null when the user is not logged in or the refresh fails.
 */
export async function getValidRayuAccessToken(): Promise<string | null> {
  const store = readRayuSession()
  if (!store?.accessToken) return null
  if (Date.now() < store.expiresAt - REFRESH_SKEW_MS) {
    return store.accessToken
  }
  // Access token expired (or about to) — refresh.
  try {
    const res = await getFetch()(`${getRayuApiBaseUrl()}/cli/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: store.refreshToken }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      accessToken: string
      refreshToken: string
      expiresAt: number
    }
    writeRayuSession({ ...store, ...data })
    return data.accessToken
  } catch {
    return null
  }
}

/**
 * Best-effort usage ping. Records the active provider/model so Rayu can track
 * which providers are used most. Never throws and never blocks the prompt.
 */
export async function recordRayuUsageBestEffort(
  provider: string,
  model: string | null,
): Promise<void> {
  try {
    const token = await getValidRayuAccessToken()
    if (!token) return
    await getFetch()(`${getRayuApiBaseUrl()}/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider, model, source: 'cli' }),
    })
  } catch {
    // swallow — usage tracking must never affect the CLI session
  }
}
