'use client'

import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from './config'

export interface RayuSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: {
    id: number
    email: string | null
    displayName: string | null
    avatarUrl: string | null
    role: string
  }
}

export const RAYU_SESSION_KEY = 'rayu_session'
// Refresh this far ahead of the access-token expiry so a request never leaves
// with a token that expires in-flight.
const REFRESH_SKEW_MS = 60_000

function readStoredSession(): RayuSession | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(RAYU_SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RayuSession
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.expiresAt) {
      localStorage.removeItem(RAYU_SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    localStorage.removeItem(RAYU_SESSION_KEY)
    return null
  }
}

function writeStoredSession(s: RayuSession): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(s))
}

function clearStoredSession(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(RAYU_SESSION_KEY)
}

/**
 * Exchange a refresh token for a fresh access token via the backend's
 * /cli/refresh endpoint (same endpoint the CLI uses). Returns the new session
 * or null if the refresh token is no longer valid.
 */
async function refreshSession(s: RayuSession): Promise<RayuSession | null> {
  try {
    const res = await fetch(apiUrl('/cli/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    })
    if (!res.ok) return null
    const tokens = (await res.json()) as {
      accessToken: string
      refreshToken: string
      expiresAt: number
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      user: s.user,
    }
  } catch {
    return null
  }
}

/**
 * Returns the active Rayu session, sourcing it from:
 * 1. A previously stored session in localStorage (email/password or Google OAuth)
 * 2. A Google OAuth session exchanged via POST /auth/oauth/google
 *
 * Sessions persist across browser restarts (localStorage) and are silently
 * refreshed before the access token expires using the stored refresh token
 * (30-day lifetime, issued by the backend). Falls back to a fresh Google
 * OAuth exchange if no stored session exists or the refresh token has expired.
 */
export function useRayuToken() {
  const { data: session, status } = useSession()
  const [token, setToken] = useState<string | null>(null)
  const [authError, setAuthError] = useState('')
  const [rayuSession, setRayuSession] = useState<RayuSession | null>(null)

  /**
   * If the access token is still valid for at least REFRESH_SKEW_MS, return
   * the session unchanged. Otherwise try to refresh using the stored refresh
   * token; on failure, drop the session (the caller can re-exchange via OAuth).
   */
  const ensureFresh = useCallback(async (s: RayuSession): Promise<RayuSession | null> => {
    if (s.expiresAt - REFRESH_SKEW_MS > Date.now()) return s
    const refreshed = await refreshSession(s)
    if (!refreshed) {
      clearStoredSession()
      return null
    }
    writeStoredSession(refreshed)
    return refreshed
  }, [])

  useEffect(() => {
    void (async () => {
      // 1. Prefer an existing stored Rayu session (email/password or prior OAuth).
      const stored = readStoredSession()
      if (stored) {
        const fresh = await ensureFresh(stored)
        if (fresh) {
          setToken(fresh.accessToken)
          setRayuSession(fresh)
          return
        }
        // ensureFresh returned null — refresh token invalid; fall through to a
        // fresh Google OAuth exchange so the user isn't stuck with no session.
      }

      // 2. Exchange a Google ID token for a Rayu session.
      if (status !== 'authenticated' || !session?.idToken) return
      try {
        const res = await fetch(apiUrl('/auth/oauth/google'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: session.idToken }),
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as RayuSession
        writeStoredSession(data)
        setToken(data.accessToken)
        setRayuSession(data)
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [status, session, ensureFresh])

  // Schedule a proactive refresh REFRESH_SKEW_MS before the access token
  // expires, so the user never sees a stale-token 401 on a dashboard page.
  useEffect(() => {
    if (!rayuSession) return
    const msUntilRefresh = rayuSession.expiresAt - Date.now() - REFRESH_SKEW_MS
    if (msUntilRefresh <= 0) return
    const id = setTimeout(() => {
      void (async () => {
        const refreshed = await refreshSession(rayuSession)
        if (!refreshed) {
          clearStoredSession()
          setToken(null)
          setRayuSession(null)
          return
        }
        writeStoredSession(refreshed)
        setToken(refreshed.accessToken)
        setRayuSession(refreshed)
      })()
    }, msUntilRefresh)
    return () => clearTimeout(id)
  }, [rayuSession])

  return { token, rayuSession, authError, status }
}