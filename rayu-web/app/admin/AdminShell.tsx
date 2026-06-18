'use client'

import { useAuth, SignInButton } from '@clerk/nextjs'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAdmin } from './AdminProvider'

const NAV = [
  { href: '/admin', label: 'Overview', icon: '◎', exact: true },
  { href: '/admin/analytics', label: 'Analytics', icon: '📈' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/plans', label: 'Plans & Features', icon: '🎚' },
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

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth()
  const { ready, forbidden, error, me, token } = useAdmin()
  const pathname = usePathname()

  if (!isLoaded || (isSignedIn && !ready)) {
    return (
      <Centered>
        <h1>Loading…</h1>
        <p style={{ opacity: 0.6 }}>Authorizing your admin session.</p>
      </Centered>
    )
  }

  if (!isSignedIn) {
    return (
      <Centered>
        <h1>Admin Area</h1>
        <p style={{ opacity: 0.6, marginBottom: '1.5rem' }}>
          Please sign in with an administrator account.
        </p>
        <SignInButton>
          <button className="btn-primary">Sign in</button>
        </SignInButton>
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
        <Link href="/" className="btn-ghost" style={{ marginTop: '1rem' }}>
          Back to site
        </Link>
      </Centered>
    )
  }

  if (error && !token) {
    return (
      <Centered>
        <h1>Connection error</h1>
        <p style={{ color: 'var(--red)' }}>{error}</p>
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
