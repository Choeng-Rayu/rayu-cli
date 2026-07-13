'use client'

import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { apiUrl } from './config'

export interface RayuSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: {
    id: number
    email: string | null
    displayName: string | null
    role: string
  }
}

export const RAYU_SESSION_KEY = 'rayu_session'

function loadStoredSession(): RayuSession | null {
  if (typeof window === 'undefined') return null
  const raw = sessionStorage.getItem(RAYU_SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RayuSession
    if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
      sessionStorage.removeItem(RAYU_SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Returns the active Rayu session, sourcing it from:
 * 1. A previously stored email/password session in sessionStorage
 * 2. A Google OAuth session exchanged via POST /auth/oauth/google
 *
 * Shared by the billing + credits dashboard pages.
 */
export function useRayuToken() {
  const { data: session, status } = useSession()
  const [token, setToken] = useState<string | null>(null)
  const [authError, setAuthError] = useState('')
  const [rayuSession, setRayuSession] = useState<RayuSession | null>(null)

  useEffect(() => {
    // 1. Prefer an existing stored Rayu session (email/password flow).
    const stored = loadStoredSession()
    if (stored) {
      setToken(stored.accessToken)
      setRayuSession(stored)
      return
    }

    // 2. Otherwise exchange a Google ID token for a Rayu session.
    if (status !== 'authenticated' || !session?.idToken) return
    void (async () => {
      try {
        const res = await fetch(apiUrl('/auth/oauth/google'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: session.idToken }),
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as RayuSession
        setToken(data.accessToken)
        setRayuSession(data)
        sessionStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(data))
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [status, session])

  return { token, rayuSession, authError, status }
}
