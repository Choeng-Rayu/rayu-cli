'use client'

import { useAuth } from '@clerk/nextjs'
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
}

const Ctx = createContext<AdminCtx | null>(null)

export function useAdmin(): AdminCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAdmin must be used within <AdminProvider>')
  return c
}

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [me, setMe] = useState<AdminMe | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) {
      setReady(true)
      return
    }
    void (async () => {
      try {
        const clerkToken = await getToken()
        const res = await fetch(apiUrl('/web/session'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}` },
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
  }, [isLoaded, isSignedIn, getToken])

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
    () => ({ ready, forbidden, error, me, token, apiFetch }),
    [ready, forbidden, error, me, token, apiFetch],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
