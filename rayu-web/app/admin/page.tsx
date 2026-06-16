
'use client'
export const dynamic = 'force-dynamic'

import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../lib/config'

const PLAN_CODES = ['free', 'pro', 'pro_plus', 'max', 'enterprise'] as const
type PlanCode = typeof PLAN_CODES[number]

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

interface UserDetail {
  user: { id: number; email: string | null; displayName: string | null; avatarUrl: string | null; role: string; status: string; createdAt: string; lastActiveAt: string | null }
  plan: { code: string; name: string; priceCents: number } | null
  subscription: { id: number; status: string; startedAt: string; currentPeriodEnd: string | null } | null
}

interface PaymentItem {
  id: number
  planCode: string | null
  provider: string
  amountCents: number
  currency: string
  status: string
  externalRef: string | null
  createdAt: string
  paidAt: string | null
}

export default function AdminPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [rayuToken, setRayuToken] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string>('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [payments, setPayments] = useState<PaymentItem[]>([])
  const [planSaving, setPlanSaving] = useState(false)
  const [planMsg, setPlanMsg] = useState('')

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

  const load = useCallback(async (token: string, term: string) => {
    const headers = { Authorization: `Bearer ${token}` }
    const usersRes = await fetch(
      apiUrl(`/admin/users?search=${encodeURIComponent(term)}`),
      { headers },
    )
    if (usersRes.status === 403) { setForbidden(true); return }
    if (usersRes.ok) {
      const data = (await usersRes.json()) as { items: AdminUser[] }
      setUsers(data.items)
    }
    const statsRes = await fetch(apiUrl('/admin/stats'), { headers })
    if (statsRes.ok) setStats((await statsRes.json()) as Stats)
  }, [])

  useEffect(() => {
    if (rayuToken) void load(rayuToken, '')
  }, [rayuToken, load])

  async function setStatus(id: number, status: string) {
    if (!rayuToken) return
    await fetch(apiUrl(`/admin/users/${id}/status`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rayuToken}` },
      body: JSON.stringify({ status }),
    })
    await load(rayuToken, search)
  }

  async function viewUser(id: number) {
    if (!rayuToken) return
    setSelectedUserId(id)
    setDetail(null)
    setPayments([])
    setPlanMsg('')
    const headers = { Authorization: `Bearer ${rayuToken}` }
    const [detailRes, paymentsRes] = await Promise.all([
      fetch(apiUrl(`/admin/users/${id}`), { headers }),
      fetch(apiUrl(`/admin/users/${id}/payments`), { headers }),
    ])
    if (detailRes.ok) setDetail((await detailRes.json()) as UserDetail)
    if (paymentsRes.ok) {
      const d = (await paymentsRes.json()) as { items: PaymentItem[] }
      setPayments(d.items)
    }
  }

  async function changePlan(userId: number, planCode: PlanCode) {
    if (!rayuToken) return
    setPlanSaving(true)
    setPlanMsg('')
    try {
      const res = await fetch(apiUrl(`/admin/users/${userId}/plan`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rayuToken}` },
        body: JSON.stringify({ planCode }),
      })
      if (!res.ok) {
        const err = (await res.json()) as { message?: string }
        setPlanMsg(err.message ?? `Error ${res.status}`)
      } else {
        const d = (await res.json()) as UserDetail
        setDetail(d)
        setPlanMsg('Plan updated.')
      }
    } finally {
      setPlanSaving(false)
    }
  }

  if (isLoaded && !isSignedIn) {
    return (
      <main className="container">
        <div style={{ marginBottom: '2rem' }}>
          <span className="section-eyebrow">SYSTEM ACCESS</span>
          <h1 style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>Admin Area</h1>
          <p style={{ color: 'var(--text)', opacity: 0.6 }}>Please sign in to proceed.</p>
        </div>
      </main>
    )
  }

  if (forbidden) {
    return (
      <main className="container">
        <div style={{ marginBottom: '2rem' }}>
          <span className="section-eyebrow" style={{ color: 'var(--red)' }}>ACCESS FORBIDDEN</span>
          <h1 style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>Permission Denied</h1>
          <p style={{ color: 'var(--red)', opacity: 0.8 }}>
            You do not have administrative permissions to view this terminal page.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="container">
      <div style={{ marginBottom: '3rem' }}>
        <span className="section-eyebrow">CONTROL ROOM</span>
        <h1 style={{ marginTop: '0.5rem' }}>Admin Dashboard</h1>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255, 51, 102, 0.05)', marginBottom: '2rem' }}>
          <p style={{ color: 'var(--red)', margin: 0, fontWeight: 600 }}>{error}</p>
        </div>
      )}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
          <div className="stat-cell"><div className="stat-num">{stats.totalUsers}</div><div className="stat-label">Total Users</div></div>
          <div className="stat-cell"><div className="stat-num">{stats.activeUsers24h}</div><div className="stat-label">Active (24h)</div></div>
          <div className="stat-cell"><div className="stat-num">{stats.activeUsers7d}</div><div className="stat-label">Active (7d)</div></div>
          <div className="stat-cell">
            <div className="stat-num" style={{ fontSize: '1.75rem', textTransform: 'uppercase', height: '54px', display: 'flex', alignItems: 'center' }}>
              {stats.usageByProvider[0]?.provider ?? '—'}
            </div>
            <div className="stat-label">Top Provider</div>
          </div>
        </div>
      )}

      {/* User detail panel */}
      {selectedUserId !== null && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h2 style={{ margin: 0 }}>User Detail — ID {selectedUserId}</h2>
            <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: '0.85rem' }} onClick={() => setSelectedUserId(null)}>
              Close
            </button>
          </div>

          {!detail && <p style={{ opacity: 0.5 }}>Loading...</p>}

          {detail && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                  <p style={{ margin: '0 0 0.25rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Email</p>
                  <p style={{ margin: 0 }}>{detail.user.email ?? '—'}</p>
                </div>
                <div>
                  <p style={{ margin: '0 0 0.25rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Role</p>
                  <p style={{ margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>{detail.user.role}</p>
                </div>
                <div>
                  <p style={{ margin: '0 0 0.25rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Current Plan</p>
                  <p style={{ margin: 0 }}>{detail.plan ? `${detail.plan.name} (${detail.plan.code})` : '—'}</p>
                </div>
                <div>
                  <p style={{ margin: '0 0 0.25rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Subscription</p>
                  <p style={{ margin: 0 }}>{detail.subscription ? <span className={`badge${detail.subscription.status === 'active' ? ' active' : ''}`}>{detail.subscription.status}</span> : '—'}</p>
                </div>
              </div>

              {/* Plan change */}
              <div style={{ marginBottom: '1.5rem' }}>
                <p style={{ margin: '0 0 0.5rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Change Plan (Admin Override)</p>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  <select
                    id={`plan-select-${selectedUserId}`}
                    defaultValue={detail.plan?.code ?? 'free'}
                    style={{ padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'inherit' }}
                    onChange={(e) => changePlan(selectedUserId, e.target.value as PlanCode)}
                    disabled={planSaving}
                  >
                    {PLAN_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {planSaving && <span style={{ opacity: 0.5, fontSize: '0.85rem' }}>Saving...</span>}
                  {planMsg && <span style={{ fontSize: '0.85rem', color: planMsg.startsWith('Error') || planMsg.startsWith('Plan updated') === false ? 'var(--red)' : 'inherit' }}>{planMsg}</span>}
                </div>
              </div>

              {/* Payment history */}
              <div>
                <p style={{ margin: '0 0 0.75rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Payment History</p>
                {payments.length === 0 ? (
                  <p style={{ opacity: 0.4, fontSize: '0.9rem' }}>No payments on record.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Plan</th>
                        <th>Amount</th>
                        <th>Currency</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id}>
                          <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.id}</td>
                          <td>{p.planCode ?? '—'}</td>
                          <td style={{ fontFamily: 'DM Mono, monospace' }}>${(p.amountCents / 100).toFixed(2)}</td>
                          <td>{p.currency}</td>
                          <td>
                            <span className={`badge${p.status === 'paid' ? ' active' : ''}`}
                              style={p.status === 'failed' ? { color: 'var(--red)', borderColor: 'rgba(255,51,102,0.2)' } : undefined}>
                              {p.status}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{new Date(p.createdAt).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: '2.5rem', marginBottom: '2rem', display: 'flex', gap: '0.75rem' }}>
        <input
          className="btn secondary"
          style={{ flex: 1, padding: '12px 16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)' }}
          placeholder="Search by email, name, or Clerk id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="btn-primary"
          onClick={() => rayuToken && load(rayuToken, search)}
          style={{ padding: '0 24px' }}
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
              <td style={{ fontFamily: 'DM Mono, monospace' }}>{u.id}</td>
              <td>{u.email ?? '—'}</td>
              <td>{u.displayName ?? '—'}</td>
              <td style={{ textTransform: 'uppercase', fontSize: '0.8rem', fontWeight: 600 }}>{u.role}</td>
              <td>
                <span className={`badge ${u.status === 'active' ? 'active' : ''}`} style={u.status !== 'active' ? { color: 'var(--red)', borderColor: 'rgba(255, 51, 102, 0.2)' } : undefined}>
                  {u.status}
                </span>
              </td>
              <td>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn-ghost"
                    style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                    onClick={() => viewUser(u.id)}
                  >
                    View
                  </button>
                  {u.status !== 'active' && (
                    <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => setStatus(u.id, 'active')}>
                      Activate
                    </button>
                  )}
                  {u.status !== 'suspended' && (
                    <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: '0.8rem', color: '#ffbd2e', borderColor: 'rgba(255,189,46,0.3)' }} onClick={() => setStatus(u.id, 'suspended')}>
                      Suspend
                    </button>
                  )}
                  {u.status !== 'banned' && (
                    <button className="btn-ghost" style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--red)', borderColor: 'rgba(255,51,102,0.3)' }} onClick={() => setStatus(u.id, 'banned')}>
                      Ban
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text)', opacity: 0.5 }}>
                No database records found. Search above or connect an agent.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  )
}
