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

  /*
   * Rayu Studio is gated on a WebContainer licence for this origin, so the link is
   * hidden unless the deployment has opted in. Read at module scope from a
   * NEXT_PUBLIC_ var, which Next inlines at build time.
   */
  const studioEnabled = process.env.NEXT_PUBLIC_STUDIO_ENABLED === 'true'

  if (loading) return null

  if (session?.user) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link href="/dashboard">Dashboard</Link>
        {/* Teams is shown to every signed-in user: the page itself is both the
            "your team" view and the create-a-team entry point, so gating the link
            on membership would hide the only way to make one. */}
        <Link href="/dashboard/team">Team</Link>
        {studioEnabled && (
          /*
           * A plain <a>, deliberately not next/link. /studio is served with
           * COOP: same-origin and COEP: credentialless so WebContainer can boot,
           * and those are per-DOCUMENT headers — a soft navigation would reuse this
           * non-isolated document, leaving window.crossOriginIsolated false and
           * WebContainer.boot() failing for no visible reason.
           */
          <a href="/studio">Studio</a>
        )}
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