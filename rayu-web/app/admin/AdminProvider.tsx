'use client'

import { useSession } from 'next-auth/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { apiUrl } from '../../lib/config'
import { RAYU_SESSION_KEY } from '../../lib/useRayuToken'

export interface AdminMe {
  id: number
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  role: string
}

interface AdminSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: AdminMe
}

interface AdminCtx {
  /** Session-exchange attempt finished (success or failure). */
  ready: boolean
  /** Signed in but not an admin/superadmin. */
  forbidden: boolean
  error: string
  me: AdminMe | null
  token: string | null
  /** Fetch against the Rayu API with the bearer token attached. */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Log in with local admin credentials (email + password). */
  localLogin: (email: string, password: string) => Promise<void>
  /** Log out the local admin session. */
  localLogout: () => void
  /** Log out the Google session (admin area only). */
  oauthLogout: () => void
}

const Ctx = createContext<AdminCtx | null>(null)
const LOCAL_SESSION_KEY = 'rayu_admin_session'
// Refresh this far ahead of the access-token expiry so a request never leaves
// with a token that expires in-flight.
const REFRESH_SKEW_MS = 60_000

function readStoredAdmin(): AdminSession | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(LOCAL_SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AdminSession
    if (
      !parsed?.accessToken ||
      !parsed?.refreshToken ||
      !parsed?.expiresAt ||
      !parsed?.user
    ) {
      localStorage.removeItem(LOCAL_SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    localStorage.removeItem(LOCAL_SESSION_KEY)
    return null
  }
}

function writeStoredAdmin(s: AdminSession): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(s))
}

function clearStoredAdmin(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(LOCAL_SESSION_KEY)
}

async function refreshAdminSession(s: AdminSession): Promise<AdminSession | null> {
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

export function useAdmin(): AdminCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAdmin must be used within <AdminProvider>')
  return c
}

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const [token, setToken] = useState<string | null>(null)
  const [me, setMe] = useState<AdminMe | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  // Validate a Rayu access token via /me and return the user. Throws on 401/etc.
  const validateToken = useCallback(async (t: string): Promise<AdminMe> => {
    const res = await fetch(apiUrl('/me'), {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (!res.ok) throw new Error(`Token invalid (${res.status})`)
    const data = (await res.json()) as { user: AdminMe; status: string }
    return data.user
  }, [])

  // Apply a refreshed admin session: persist + update state + verify role.
  const applySession = useCallback(
    async (s: AdminSession): Promise<void> => {
      try {
        const user = await validateToken(s.accessToken)
        if (user.role !== 'admin' && user.role !== 'superadmin') {
          clearStoredAdmin()
          setForbidden(true)
          return
        }
        const persisted: AdminSession = { ...s, user }
        writeStoredAdmin(persisted)
        setToken(persisted.accessToken)
        setMe(persisted.user)
      } catch {
        clearStoredAdmin()
      }
    },
    [validateToken],
  )

  useEffect(() => {
    if (status === 'loading') return

    // 1. Check for a stored local admin session first.
    const stored = readStoredAdmin()
    if (stored) {
      void (async () => {
        try {
          // Refresh if the access token is near/past expiry; the refresh token
          // is valid for 30 days, so a tab that's been closed for hours can still
          // recover without forcing the admin to re-enter credentials.
          const live =
            stored.expiresAt - REFRESH_SKEW_MS > Date.now()
              ? stored
              : await refreshAdminSession(stored)
          if (!live) {
            clearStoredAdmin()
            return
          }
          await applySession(live)
        } catch {
          // Defensive: applySession/refreshAdminSession swallow their own
          // errors, but if anything escapes we still must unblock the UI.
          clearStoredAdmin()
        } finally {
          setReady(true)
        }
      })()
      return
    }

    // 2. Fall back to Google OAuth session.
    if (status !== 'authenticated') {
      setReady(true)
      return
    }
    void (async () => {
      try {
        const idToken = session?.idToken
        if (!idToken) throw new Error('Missing Google ID token')
        const res = await fetch(apiUrl('/auth/oauth/google'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as {
          accessToken: string
          refreshToken: string
          expiresAt: number
          user: AdminMe
        }
        await applySession(data)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setReady(true)
      }
    })()
  }, [status, session, validateToken, applySession])

  // Schedule a proactive refresh before the access token expires.
  useEffect(() => {
    if (!token || !me) return
    const stored = readStoredAdmin()
    if (!stored) return
    const msUntilRefresh = stored.expiresAt - Date.now() - REFRESH_SKEW_MS
    if (msUntilRefresh <= 0) return
    const id = setTimeout(() => {
      void (async () => {
        const refreshed = await refreshAdminSession(stored)
        if (!refreshed) {
          clearStoredAdmin()
          setToken(null)
          setMe(null)
          return
        }
        writeStoredAdmin(refreshed)
        setToken(refreshed.accessToken)
      })()
    }, msUntilRefresh)
    return () => clearTimeout(id)
  }, [token, me])

  const localLogin = useCallback(
    async (email: string, password: string) => {
      setError('')
      const res = await fetch(apiUrl('/admin-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ message: 'Login failed' }))
        throw new Error((msg as { message?: string }).message ?? 'Login failed')
      }
      const data = (await res.json()) as {
        accessToken: string
        refreshToken: string
        expiresAt: number
        user: AdminMe
      }
      await applySession(data)
      setForbidden(false)
    },
    [applySession],
  )

  const localLogout = useCallback(() => {
    clearStoredAdmin()
    setToken(null)
    setMe(null)
    setForbidden(false)
  }, [])

  const oauthLogout = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(RAYU_SESSION_KEY)
      localStorage.removeItem(LOCAL_SESSION_KEY)
    }
    setToken(null)
    setMe(null)
    setForbidden(false)
  }, [])

  // Keep latest token in a ref so apiFetch has a stable identity.
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = token

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      const t = tokenRef.current
      if (t) headers.set('Authorization', `Bearer ${t}`)
      if (init?.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }
      return fetch(apiUrl(path), { ...init, headers })
    },
    [],
  )

  const value = useMemo(
    () => ({ ready, forbidden, error, me, token, apiFetch, localLogin, localLogout, oauthLogout }),
    [ready, forbidden, error, me, token, apiFetch, localLogin, localLogout, oauthLogout],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}