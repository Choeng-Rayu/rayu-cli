'use client'

import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../lib/config'

interface AdminUser {
  id: number
  email: string | null
  displayName: string | null
  role: string
  status: string
  createdAt: string
  lastActiveAt: string | null
}

interface Stats {
  totalUsers: number
  activeUsers24h: number
  activeUsers7d: number
  usageByProvider: Array<{ provider: string; count: number }>
}

export default function AdminPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [rayuToken, setRayuToken] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string>('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [search, setSearch] = useState('')

  // Exchange the Clerk session for a Rayu access token (web login).
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return
    void (async () => {
      try {
        const clerkToken = await getToken()
        const res = await fetch(apiUrl('/web/session'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${clerkToken}` },
        })
        if (!res.ok) throw new Error(`Session failed (${res.status})`)
        const data = (await res.json()) as { accessToken: string }
        setRayuToken(data.accessToken)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [isLoaded, isSignedIn, getToken])

  const load = useCallback(
    async (token: string, term: string) => {
      const headers = { Authorization: `Bearer ${token}` }
      const usersRes = await fetch(
        apiUrl(`/admin/users?search=${encodeURIComponent(term)}`),
        { headers },
      )
      if (usersRes.status === 403) {
        setForbidden(true)
        return
      }
      if (usersRes.ok) {
        const data = (await usersRes.json()) as { items: AdminUser[] }
        setUsers(data.items)
      }
      const statsRes = await fetch(apiUrl('/admin/stats'), { headers })
      if (statsRes.ok) setStats((await statsRes.json()) as Stats)
    },
    [],
  )

  useEffect(() => {
    if (rayuToken) void load(rayuToken, '')
  }, [rayuToken, load])

  async function setStatus(id: number, status: string) {
    if (!rayuToken) return
    await fetch(apiUrl(`/admin/users/${id}/status`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rayuToken}`,
      },
      body: JSON.stringify({ status }),
    })
    await load(rayuToken, search)
  }

  if (isLoaded && !isSignedIn) {
    return (
      <main className="container">
        <h1>Admin</h1>
        <p style={{ color: 'var(--muted)' }}>Please sign in.</p>
      </main>
    )
  }

  if (forbidden) {
    return (
      <main className="container">
        <h1>Admin</h1>
        <p style={{ color: '#ff6b6b' }}>
          You do not have permission to view this page.
        </p>
      </main>
    )
  }

  return (
    <main className="container">
      <h1>Admin dashboard</h1>
      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}

      {stats && (
        <div className="grid">
          <div className="card">
            <h3>{stats.totalUsers}</h3>
            <span className="badge">Total users</span>
          </div>
          <div className="card">
            <h3>{stats.activeUsers24h}</h3>
            <span className="badge">Active (24h)</span>
          </div>
          <div className="card">
            <h3>{stats.activeUsers7d}</h3>
            <span className="badge">Active (7d)</span>
          </div>
          <div className="card">
            <h3>{stats.usageByProvider[0]?.provider ?? '—'}</h3>
            <span className="badge">Top provider</span>
          </div>
        </div>
      )}

      <div style={{ marginTop: '2rem', display: 'flex', gap: '0.5rem' }}>
        <input
          className="btn secondary"
          style={{ flex: 1 }}
          placeholder="Search by email, name, or Clerk id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => rayuToken && load(rayuToken, search)}
        >
          Search
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.email ?? '—'}</td>
              <td>{u.displayName ?? '—'}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td style={{ display: 'flex', gap: '0.4rem' }}>
                {u.status !== 'active' && (
                  <button className="btn secondary" onClick={() => setStatus(u.id, 'active')}>
                    Activate
                  </button>
                )}
                {u.status !== 'suspended' && (
                  <button className="btn secondary" onClick={() => setStatus(u.id, 'suspended')}>
                    Suspend
                  </button>
                )}
                {u.status !== 'banned' && (
                  <button className="btn secondary" onClick={() => setStatus(u.id, 'banned')}>
                    Ban
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
