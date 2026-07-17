'use client'

import { signIn, useSession } from 'next-auth/react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { apiUrl } from '../../lib/config'
import { RAYU_SESSION_KEY } from '../../lib/useRayuToken'

export default function SignUpPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // If the user already signed in via Google, exchange for a Rayu session and
  // send them to the dashboard.
  useEffect(() => {
    if (status !== 'authenticated' || !session?.idToken) return
    setLoading(true)
    fetch(apiUrl('/auth/oauth/google'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: session.idToken }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`OAuth session failed (${res.status})`)
        router.push('/dashboard')
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [status, session, router])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: displayName || undefined,
        }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ message: 'Registration failed' }))
        throw new Error((msg as { message?: string }).message ?? 'Registration failed')
      }
      const data = (await res.json()) as { accessToken: string; refreshToken: string; expiresAt: number; user: { id: number; email: string | null; displayName: string | null; role: string } }
      localStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(data))
      router.push('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="container" style={{ maxWidth: 420, marginTop: '4rem' }}>
      <div className="card">
        <h1 style={{ marginBottom: '1.5rem' }}>Create your Rayu account</h1>

        <button
          className="btn-primary"
          style={{ width: '100%', marginBottom: '1.5rem' }}
          onClick={() => void signIn('google', { callbackUrl: '/dashboard' })}
          disabled={loading}
        >
          Sign up with Google
        </button>

        <div
          style={{
            textAlign: 'center',
            marginBottom: '1.5rem',
            color: 'var(--muted)',
            fontSize: '0.85rem',
          }}
        >
          or with email
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <input
            type="text"
            placeholder="Display name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ padding: '0.7rem 0.9rem' }}
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: '0.7rem 0.9rem' }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ padding: '0.7rem 0.9rem' }}
          />
          {error && <p style={{ color: 'var(--red)', fontSize: '0.9rem' }}>{error}</p>}
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Creating account…' : 'Sign up'}
          </button>
        </form>

        <p style={{ marginTop: '1rem', fontSize: '0.9rem', opacity: 0.7 }}>
          Already have an account? <Link href="/sign-in">Sign in</Link>.
        </p>
      </div>
    </main>
  )
}
