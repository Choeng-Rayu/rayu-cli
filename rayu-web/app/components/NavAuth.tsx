'use client'

import { signIn, signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { apiUrl } from '../../lib/config'
import { RAYU_SESSION_KEY } from '../../lib/useRayuToken'

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

export default function NavAuth() {
  const { data: session, status } = useSession()
  const [rayu, setRayu] = useState<RayuSession | null>(null)
  const loading = status === 'loading'

  useEffect(() => {
    if (status !== 'authenticated' || !session?.idToken) return
    // Exchange the Google ID token for a Rayu session once per sign-in.
    const cached = typeof window !== 'undefined'
      ? sessionStorage.getItem(RAYU_SESSION_KEY)
      : null
    if (cached) {
      try {
        setRayu(JSON.parse(cached))
        return
      } catch {
        // ignore stale cache
      }
    }
    void (async () => {
      try {
        const res = await fetch(apiUrl('/auth/oauth/google'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: session.idToken }),
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as RayuSession
        setRayu(data)
        sessionStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(data))
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Rayu session exchange failed', err)
      }
    })()
  }, [status, session])

  if (loading) return null

  if (session?.user) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/billing" className="btn-primary">Billing</Link>
        <button
          className="btn-primary"
          onClick={() => {
            sessionStorage.removeItem(RAYU_SESSION_KEY)
            void signOut({ callbackUrl: '/' })
          }}
        >
          {rayu?.user.displayName ?? rayu?.user.email ?? session.user.email}
        </button>
      </div>
    )
  }

  return (
    <button
      className="btn-primary"
      onClick={() => void signIn('google')}
    >
      Sign in
    </button>
  )
}
