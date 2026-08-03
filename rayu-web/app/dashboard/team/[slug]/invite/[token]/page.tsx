'use client'
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../../../../../lib/config'
import { useRayuToken } from '../../../../../../lib/useRayuToken'

type State = 'idle' | 'accepting' | 'joined' | 'failed'

/**
 * Accept-invite landing page (/dashboard/team/<slug>/invite/<token>).
 *
 * The token is the authorization, but the backend still requires the signed-in
 * account's email to match the invited address — so a forwarded or leaked link
 * cannot buy someone a free seat on a paid team. A visitor who is not signed in
 * is sent through Google first and returns here.
 */
export default function AcceptInvitePage() {
  const routeParams = useParams<{ slug: string; token: string }>()
  const slug = routeParams.slug
  const inviteToken = routeParams.token
  const router = useRouter()
  const { token, status } = useRayuToken()
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState('')

  const accept = useCallback(async () => {
    if (!token) return
    setState('accepting')
    setError('')
    try {
      const res = await fetch(apiUrl(`/organizations/invites/${inviteToken}/accept`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json().catch(() => ({}))) as { message?: string | string[] }
      if (!res.ok) {
        const msg = Array.isArray(data.message) ? data.message.join(', ') : data.message
        setError(msg ?? `Could not accept the invite (${res.status})`)
        setState('failed')
        return
      }
      setState('joined')
      // A fresh sign-in is what puts the team claims on the token; the team page
      // works immediately either way, so just go there.
      setTimeout(() => router.push(`/dashboard/team/${slug}`), 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('failed')
    }
  }, [token, inviteToken, slug, router])

  // Auto-accept as soon as a session is available: the user already clicked the
  // link, so making them click a second button adds nothing.
  useEffect(() => {
    if (token && state === 'idle') void accept()
  }, [token, state, accept])

  return (
    <main className="container" style={{ maxWidth: 620 }}>
      <span className="section-eyebrow">TEAM INVITE</span>
      <h1 style={{ marginTop: '0.5rem' }}>Join {slug}</h1>

      {status === 'unauthenticated' && !token && (
        <div className="card">
          <p style={{ marginTop: 0, opacity: 0.7 }}>
            Sign in with the Google account this invite was sent to, and you&apos;ll join the
            team automatically.
          </p>
          <button className="btn-primary" style={{ padding: '10px 22px' }} onClick={() => void signIn('google')}>
            Sign in to accept
          </button>
        </div>
      )}

      {state === 'accepting' && <p style={{ opacity: 0.6 }}>Accepting your invite…</p>}

      {state === 'joined' && (
        <div className="card" style={{ borderColor: 'var(--green)', background: 'var(--green-glow)' }}>
          <p style={{ color: 'var(--green)', margin: 0 }}>
            You&apos;re in. Taking you to the team…
          </p>
        </div>
      )}

      {state === 'failed' && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)' }}>
          <p style={{ color: 'var(--red)', marginTop: 0 }}>{error}</p>
          <p style={{ opacity: 0.6, fontSize: '0.85rem', marginBottom: '1rem' }}>
            Invites expire after 7 days and only work for the address they were sent to. Ask the
            team admin to send a new one if this link is stale.
          </p>
          <Link href="/dashboard/team" className="btn-ghost" style={{ padding: '8px 16px' }}>
            Back to teams
          </Link>
        </div>
      )}
    </main>
  )
}
