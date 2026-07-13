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
  role: string
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
const LOCAL_TOKEN_KEY = 'rayu_admin_token'

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

  // Validate a Rayu access token via /me and return the user.
  const validateToken = useCallback(async (t: string): Promise<AdminMe> => {
    const res = await fetch(apiUrl('/me'), {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (!res.ok) throw new Error(`Token invalid (${res.status})`)
    const data = (await res.json()) as { user: AdminMe }
    return data.user
  }, [])

  useEffect(() => {
    if (status === 'loading') return

    // 1. Check for a stored local admin token first.
    const stored = typeof window !== 'undefined'
      ? localStorage.getItem(LOCAL_TOKEN_KEY)
      : null

    if (stored) {
      void (async () => {
        try {
          const user = await validateToken(stored)
          if (user.role !== 'admin' && user.role !== 'superadmin') {
            localStorage.removeItem(LOCAL_TOKEN_KEY)
            setForbidden(true)
          } else {
            setToken(stored)
            setMe(user)
          }
        } catch {
          localStorage.removeItem(LOCAL_TOKEN_KEY)
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
        const data = (await res.json()) as { accessToken: string; user: AdminMe }
        setToken(data.accessToken)
        setMe(data.user)
        if (data.user?.role !== 'admin' && data.user?.role !== 'superadmin') {
          setForbidden(true)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setReady(true)
      }
    })()
  }, [status, session, validateToken])

  const localLogin = useCallback(async (email: string, password: string) => {
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
    const data = (await res.json()) as { accessToken: string; user: AdminMe }
    localStorage.setItem(LOCAL_TOKEN_KEY, data.accessToken)
    setToken(data.accessToken)
    setMe(data.user)
    setForbidden(false)
  }, [])

  const localLogout = useCallback(() => {
    localStorage.removeItem(LOCAL_TOKEN_KEY)
    setToken(null)
    setMe(null)
    setForbidden(false)
  }, [])

  const oauthLogout = useCallback(() => {
    sessionStorage.removeItem(RAYU_SESSION_KEY)
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
