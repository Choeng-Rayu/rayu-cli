'use client'

import { signIn, signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useAdmin } from './AdminProvider'
import { RAYU_SESSION_KEY } from '../../lib/useRayuToken'

const NAV = [
  { href: '/admin', label: 'Overview', icon: '◎', exact: true },
  { href: '/admin/analytics', label: 'Analytics', icon: '📈' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/plans', label: 'Plans & Features', icon: '🎚' },
  { href: '/admin/promo-codes', label: 'Promo Codes', icon: '🏷' },
  { href: '/admin/models', label: 'Models', icon: '🧠' },
  { href: '/admin/credit-settings', label: 'Credit Settings', icon: '⚙' },
  { href: '/admin/payments', label: 'Payments', icon: '💰' },
  { href: '/admin/feedback', label: 'Feedback', icon: '✉' },
]

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="container" style={{ maxWidth: 560 }}>
      <span className="section-eyebrow">SYSTEM ACCESS</span>
      <div style={{ marginTop: '1rem' }}>{children}</div>
    </div>
  )
}

function LocalLoginForm() {
  const { localLogin } = useAdmin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await localLogin(email, password)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <input
        type="email"
        placeholder="Admin email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ padding: '0.6rem 0.8rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'inherit', fontSize: '0.95rem' }}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={{ padding: '0.6rem 0.8rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'inherit', fontSize: '0.95rem' }}
      />
      {err && <p style={{ color: 'var(--red)', margin: 0, fontSize: '0.85rem' }}>{err}</p>}
      <button className="btn-primary" type="submit" disabled={loading}>
        {loading ? 'Signing in…' : 'Sign in as Admin'}
      </button>
    </form>
  )
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { status: oauthStatus } = useSession()
  const { ready, forbidden, error, me, token, localLogout, oauthLogout } = useAdmin()
  const pathname = usePathname()

  const loading = oauthStatus === 'loading' || (!token && !ready)

  // Show local login form while OAuth is loading or when not signed in via OAuth.
  // If a valid local admin token is present, AdminProvider sets ready+token directly.
  if (loading) {
    return (
      <Centered>
        <h1>Loading…</h1>
        <p style={{ opacity: 0.6 }}>Authorizing your admin session.</p>
      </Centered>
    )
  }

  // Local admin token is present and valid — skip OAuth flow entirely.
  if (token && me && (me.role === 'admin' || me.role === 'superadmin')) {
    const active = NAV.find((n) => isActive(pathname, n.href, n.exact))
    return (
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <div className="admin-sidebar-title">Control Room</div>
          <ul className="admin-nav">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className={`admin-nav-link${isActive(pathname, n.href, n.exact) ? ' active' : ''}`}
                >
                  <span className="admin-nav-ico">{n.icon}</span>
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
        <div className="admin-main">
          <div className="admin-topbar">
            <h1>{active?.label ?? 'Admin'}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>{me.email ?? ''}</span>
              <button
                onClick={localLogout}
                className="admin-nav-link"
                style={{ opacity: 0.7, background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Logout
              </button>
              <Link href="/" className="admin-nav-link" style={{ opacity: 0.7 }}>
                ↩ Site
              </Link>
            </div>
          </div>
          <div className="admin-content">{children}</div>
        </div>
      </div>
    )
  }

  // Not signed in via OAuth — show both local login and Google sign-in.
  if (oauthStatus !== 'authenticated' && !token) {
    return (
      <Centered>
        <h1>Admin Area</h1>
        <p style={{ opacity: 0.6, marginBottom: '1.5rem' }}>
          Sign in with your admin credentials.
        </p>
        <LocalLoginForm />
        <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem', opacity: 0.7 }}>
          <p style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>Or sign in with Google:</p>
          <button
            className="btn-ghost"
            onClick={() => void signIn('google', { callbackUrl: '/admin' })}
          >
            Sign in with Google
          </button>
        </div>
      </Centered>
    )
  }

  if (oauthStatus === 'authenticated' && !ready) {
    return (
      <Centered>
        <h1>Loading…</h1>
        <p style={{ opacity: 0.6 }}>Authorizing your admin session.</p>
      </Centered>
    )
  }

  if (forbidden) {
    return (
      <Centered>
        <span className="section-eyebrow" style={{ color: 'var(--red)' }}>
          ACCESS DENIED
        </span>
        <h1 style={{ marginTop: '0.5rem' }}>Permission Denied</h1>
        <p style={{ color: 'var(--red)', opacity: 0.85 }}>
          Your account does not have administrator access.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <Link href="/" className="btn-ghost">Back to site</Link>
        </div>
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
          <p style={{ opacity: 0.6, fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            Try the admin account instead:
          </p>
          <LocalLoginForm />
        </div>
      </Centered>
    )
  }

  if (error && !token) {
    return (
      <Centered>
        <h1>Connection error</h1>
        <p style={{ color: 'var(--red)' }}>{error}</p>
        <div style={{ marginTop: '1.5rem' }}>
          <LocalLoginForm />
        </div>
      </Centered>
    )
  }

  const active = NAV.find((n) => isActive(pathname, n.href, n.exact))

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-title">Control Room</div>
        <ul className="admin-nav">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link
                href={n.href}
                className={`admin-nav-link${
                  isActive(pathname, n.href, n.exact) ? ' active' : ''
                }`}
              >
                <span className="admin-nav-ico">{n.icon}</span>
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <div className="admin-main">
        <div className="admin-topbar">
          <h1>{active?.label ?? 'Admin'}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>
              {me?.email ?? ''}
            </span>
            <button
              onClick={() => {
                localStorage.removeItem(RAYU_SESSION_KEY)
                oauthLogout()
                void signOut({ callbackUrl: '/' })
              }}
              className="admin-nav-link"
              style={{ opacity: 0.7, background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Logout
            </button>
            <Link href="/" className="admin-nav-link" style={{ opacity: 0.7 }}>
              ↩ Site
            </Link>
          </div>
        </div>
        <div className="admin-content">{children}</div>
      </div>
    </div>
  )
}
