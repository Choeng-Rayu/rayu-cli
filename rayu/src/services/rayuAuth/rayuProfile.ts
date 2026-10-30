// The signed-in user's current profile from rayu-backend (GET /me).
//
// The session file already holds the user as they were at sign-in; this is the
// live record, so a changed display name or a suspended account shows up without
// signing in again. Read-only and best-effort: never throws, and any failure
// (signed out, offline, timeout, unexpected shape) is null, so a caller falls back
// to the stored identity.
import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
  type RayuSessionUser,
} from './rayuSession.js'

export interface RayuProfile {
  user: RayuSessionUser
  /** `active` for a usable account; anything else (e.g. `suspended`) is not. */
  status: string
}

const PROFILE_TIMEOUT_MS = 10_000

export async function fetchRayuProfile(
  options: { timeoutMs?: number } = {},
): Promise<RayuProfile | null> {
  const token = await getValidRayuAccessToken()
  if (!token) return null
  try {
    const res = await (globalThis.fetch as typeof fetch)(`${getRayuApiBaseUrl()}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      // The bearer token must not follow a redirect to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? PROFILE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return parseRayuProfile(await res.json())
  } catch {
    return null
  }
}

/** The profile in a `/me` response, or null when it is not one. Exported for tests. */
export function parseRayuProfile(data: unknown): RayuProfile | null {
  if (!data || typeof data !== 'object') return null
  const { user, status } = data as { user?: unknown; status?: unknown }
  if (!user || typeof user !== 'object' || typeof status !== 'string') return null
  const u = user as Record<string, unknown>
  if (typeof u.id !== 'number') return null
  return {
    user: {
      id: u.id,
      email: typeof u.email === 'string' ? u.email : null,
      displayName: typeof u.displayName === 'string' ? u.displayName : null,
      avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
      role: typeof u.role === 'string' ? u.role : 'user',
    },
    status,
  }
}
