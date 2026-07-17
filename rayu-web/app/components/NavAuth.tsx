'use client'

import { signIn, signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { RAYU_SESSION_KEY } from '../../lib/useRayuToken'

/**
 * Navbar auth controls. Reads the Google/NextAuth session for display only
 * (name/email). The Rayu session exchange (access token for API calls) is
 * handled by `useRayuToken` on the dashboard/billing pages — NOT here. This
 * avoids a redundant /auth/oauth/google exchange on every page load and the
 * 401 that results when the Google ID token is expired.
 */
export default function NavAuth() {
  const { data: session, status } = useSession()
  const loading = status === 'loading'

  if (loading) return null

  if (session?.user) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/billing" className="btn-primary">Billing</Link>
        <button
          className="btn-primary"
          onClick={() => {
            localStorage.removeItem(RAYU_SESSION_KEY)
            void signOut({ callbackUrl: '/' })
          }}
        >
          {session.user.name ?? session.user.email}
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