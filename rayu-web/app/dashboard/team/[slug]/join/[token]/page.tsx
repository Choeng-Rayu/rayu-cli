'use client'
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../../../../../lib/config'
import { joinBlockedReason, type JoinLinkPreview } from '../../../../../../lib/team'
import { useRayuToken } from '../../../../../../lib/useRayuToken'

/**
 * Request-to-join landing page (/dashboard/team/<slug>/join/<token>).
 *
 * This is the shareable half of team onboarding, and it is deliberately NOT the
 * accept-invite page: an email invite is an entitlement (open it and you are in),
 * while a join link is meant to be forwarded, so holding it only lets someone ASK.
 * Nothing here creates a seat — it files a request, and a team admin approves it.
 *
 * The visitor must be signed in first, so the request carries a real account
 * rather than a typed-in address: that is what makes the admin's "approve" click
 * unambiguous about who they are letting in.
 */
export default function RequestToJoinPage() {
  const routeParams = useParams<{ slug: string; token: string }>()
  const slug = routeParams.slug
  const joinToken = routeParams.token
  const router = useRouter()
  const { token, status } = useRayuToken()

  const [preview, setPreview] = useState<JoinLinkPreview | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(apiUrl(`/organizations/join/${joinToken}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json().catch(() => ({}))) as JoinLinkPreview & {
        message?: string | string[]
      }
      if (!res.ok) {
        const m = Array.isArray(data.message) ? data.message.join(', ') : data.message
        setError(m ?? `This join link is not valid (${res.status})`)
        return
      }
      setError('')
      setPreview(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [token, joinToken])

  useEffect(() => {
    void load()
  }, [load])

  async function send(path: string, okMessage: string) {
    if (!token) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch(apiUrl(`/organizations/join/${joinToken}/${path}`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() || undefined }),
      })
      const data = (await res.json().catch(() => ({}))) as { message?: string | string[] }
      if (!res.ok) {
        const m = Array.isArray(data.message) ? data.message.join(', ') : data.message
        setError(m ?? `Request failed (${res.status})`)
        return
      }
      setNotice(okMessage)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const teamName = preview?.team.name ?? slug
  const blocked = preview ? joinBlockedReason(preview) : null
  const pending = preview?.request?.status === 'pending'
  const isMember = preview?.membership === 'member'

  return (
    <main className="container" style={{ maxWidth: 620 }}>
      <span className="section-eyebrow">JOIN A TEAM</span>
      <h1 style={{ marginTop: '0.5rem' }}>Join {teamName}</h1>
      {preview && (
        <p style={{ opacity: 0.55, margin: '0 0 1.25rem', fontSize: '0.85rem' }}>
          /{preview.team.slug} · {preview.team.memberCount}{' '}
          member{preview.team.memberCount === 1 ? '' : 's'}
          {preview.team.ssoDomain ? ` · ${preview.team.ssoDomain}` : ''}
        </p>
      )}

      {status === 'unauthenticated' && !token && (
        <div className="card">
          <p style={{ marginTop: 0, opacity: 0.7 }}>
            Sign in first — your request is sent to the team admin from your account, so they
            know exactly who they are approving.
          </p>
          <button
            className="btn-primary"
            style={{ padding: '10px 22px' }}
            onClick={() => void signIn('google')}
          >
            Sign in to continue
          </button>
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)' }}
        >
          <p style={{ color: 'var(--red)', marginTop: 0 }}>{error}</p>
          <Link href="/dashboard/team" className="btn-ghost" style={{ padding: '8px 16px' }}>
            Back to teams
          </Link>
        </div>
      )}

      {notice && !error && (
        <div
          className="card"
          style={{
            borderColor: 'var(--green)',
            background: 'var(--green-glow)',
            marginBottom: '1rem',
          }}
        >
          <p style={{ color: 'var(--green)', margin: 0 }}>{notice}</p>
        </div>
      )}

      {preview && !error && (
        <div className="card">
          {isMember ? (
            <>
              <p style={{ marginTop: 0, opacity: 0.7 }}>You&apos;re already on this team.</p>
              <button
                className="btn-primary"
                style={{ padding: '9px 20px' }}
                onClick={() => router.push(`/dashboard/team/${preview.team.slug}`)}
              >
                Go to the team
              </button>
            </>
          ) : pending ? (
            <>
              <p style={{ marginTop: 0, opacity: 0.75 }}>
                Your request is in. A team admin has to approve it before you get a seat —
                you&apos;ll see the team on your dashboard once they do.
              </p>
              <p style={{ opacity: 0.5, fontSize: '0.8rem' }}>
                Asked {new Date(preview.request!.createdAt).toLocaleString()}
              </p>
              <button
                className="btn-ghost"
                style={{ padding: '8px 16px', fontSize: '0.82rem' }}
                disabled={busy}
                onClick={() => void send('cancel', 'Request withdrawn')}
              >
                Withdraw my request
              </button>
            </>
          ) : blocked ? (
            <>
              <p style={{ marginTop: 0, opacity: 0.75 }}>{blocked}</p>
              <Link href="/dashboard/team" className="btn-ghost" style={{ padding: '8px 16px' }}>
                Back to teams
              </Link>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0, opacity: 0.7 }}>
                This link lets you ask to join. A team admin approves requests, so you are not a
                member — and cannot spend the team&apos;s credits — until they do.
              </p>
              {preview.request?.status === 'rejected' && (
                <p style={{ color: '#f5a623', fontSize: '0.82rem' }}>
                  A previous request of yours was declined. You can ask again, and the admin will
                  see that this is a second ask.
                </p>
              )}
              <label
                htmlFor="join-message"
                style={{ display: 'block', fontSize: '0.8rem', opacity: 0.6, marginBottom: 4 }}
              >
                Add a note for the admin (optional)
              </label>
              <input
                id="join-message"
                className="admin-input"
                style={{ width: '100%' }}
                maxLength={280}
                placeholder="e.g. I'm the new backend contractor"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                className="btn-primary"
                style={{ padding: '10px 22px', marginTop: '0.9rem' }}
                disabled={busy}
                onClick={() => void send('request', 'Request sent — waiting for an admin')}
              >
                {busy ? 'Sending…' : 'Ask to join'}
              </button>
            </>
          )}
        </div>
      )}
    </main>
  )
}
