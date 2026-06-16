
'use client'
export const dynamic = 'force-dynamic'

import { useAuth } from '@clerk/nextjs'
import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../../lib/config'
import { BarChart, Donut, HBar, LineChart } from '../../components/Charts'

const PLAN_CODES = ['free', 'basic', 'pro', 'pro_plus', 'max', 'enterprise'] as const
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

      {/* Analytics (revenue, users, activity, plans, usage) */}
      {rayuToken && <Analytics token={rayuToken} />}

      {/* Plans & feature entitlements (admin-managed business logic) */}
      {rayuToken && <PlansAndFeatures token={rayuToken} />}

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


// ---------------------------------------------------------------------------
// Plans & Features management.
//
// All plan business logic (price, availability, per-feature toggles/limits,
// daily-turn cap) is stored in the backend DB and edited here at runtime —
// nothing is hardcoded. Saving PATCHes /admin/plans/:code.
// ---------------------------------------------------------------------------

interface FeatureCatalogItem {
  key: string
  label: string
  description: string
  supportsLimit: boolean
}

interface FeatureEntitlement {
  enabled: boolean
  limit?: number | null
}

interface PlanAdminView {
  id: number
  code: string
  name: string
  priceCents: number
  availability: 'active' | 'coming_soon'
  maxDailyTurns: number | null
  features: Record<string, FeatureEntitlement>
}

function PlansAndFeatures({ token }: { token: string }) {
  const [catalog, setCatalog] = useState<FeatureCatalogItem[]>([])
  const [plans, setPlans] = useState<PlanAdminView[]>([])
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [savingCode, setSavingCode] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    const res = await fetch(apiUrl('/admin/plans'), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return
    const data = (await res.json()) as {
      catalog: FeatureCatalogItem[]
      plans: PlanAdminView[]
    }
    setCatalog(data.catalog)
    setPlans(data.plans)
    setLoaded(true)
  }, [token])

  useEffect(() => {
    void reload()
  }, [reload])

  function patchPlan(code: string, patch: Partial<PlanAdminView>) {
    setPlans((prev) =>
      prev.map((p) => (p.code === code ? { ...p, ...patch } : p)),
    )
  }

  function patchFeature(
    code: string,
    key: string,
    patch: Partial<FeatureEntitlement>,
  ) {
    setPlans((prev) =>
      prev.map((p) =>
        p.code === code
          ? {
              ...p,
              features: {
                ...p.features,
                [key]: { ...p.features[key], ...patch },
              },
            }
          : p,
      ),
    )
  }

  async function save(plan: PlanAdminView) {
    setSavingCode(plan.code)
    setMsg((m) => ({ ...m, [plan.code]: '' }))
    try {
      const res = await fetch(apiUrl(`/admin/plans/${plan.code}`), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: plan.name,
          priceCents: plan.priceCents,
          availability: plan.availability,
          maxDailyTurns: plan.maxDailyTurns,
          features: plan.features,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string }
        setMsg((m) => ({
          ...m,
          [plan.code]: `Error: ${err.message ?? res.status}`,
        }))
        return
      }
      const updated = (await res.json()) as PlanAdminView
      patchPlan(plan.code, updated)
      setMsg((m) => ({ ...m, [plan.code]: 'Saved.' }))
    } catch (e) {
      setMsg((m) => ({
        ...m,
        [plan.code]: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      setSavingCode(null)
    }
  }

  if (!loaded) return null

  return (
    <div className="card" style={{ marginBottom: '2rem' }}>
      <h2 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Plans &amp; Features</h2>
      <p style={{ opacity: 0.55, marginTop: 0, fontSize: '0.9rem' }}>
        All pricing, availability, feature access and usage limits are editable
        here and stored in the database — no code or env changes needed.
      </p>

      {plans.map((plan) => (
        <div
          key={plan.code}
          style={{
            border: '1px solid var(--border)',
            borderRadius: '10px',
            padding: '1.25rem',
            marginTop: '1.25rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <strong style={{ fontSize: '1.05rem' }}>
              {plan.name}{' '}
              <span style={{ opacity: 0.5, fontWeight: 400 }}>({plan.code})</span>
            </strong>

            <label style={{ fontSize: '0.85rem', opacity: 0.7 }}>
              Price&nbsp;$
              <input
                type="number"
                min={0}
                step={1}
                value={(plan.priceCents / 100).toString()}
                onChange={(e) =>
                  patchPlan(plan.code, {
                    priceCents: Math.max(0, Math.round(Number(e.target.value) * 100)),
                  })
                }
                style={inputStyle(90)}
              />
              /mo
            </label>

            <label style={{ fontSize: '0.85rem', opacity: 0.7 }}>
              Availability&nbsp;
              <select
                value={plan.availability}
                onChange={(e) =>
                  patchPlan(plan.code, {
                    availability: e.target.value as PlanAdminView['availability'],
                  })
                }
                style={inputStyle(140)}
              >
                <option value="active">active</option>
                <option value="coming_soon">coming_soon</option>
              </select>
            </label>

            <label style={{ fontSize: '0.85rem', opacity: 0.7 }}>
              Max daily turns&nbsp;
              <input
                type="number"
                min={0}
                placeholder="∞"
                value={plan.maxDailyTurns ?? ''}
                onChange={(e) =>
                  patchPlan(plan.code, {
                    maxDailyTurns:
                      e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))),
                  })
                }
                style={inputStyle(90)}
              />
            </label>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '0.5rem',
            }}
          >
            {catalog.map((feat) => {
              const ent = plan.features[feat.key] ?? { enabled: false, limit: null }
              return (
                <div
                  key={feat.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.35rem 0',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ent.enabled}
                    onChange={(e) =>
                      patchFeature(plan.code, feat.key, { enabled: e.target.checked })
                    }
                  />
                  <span style={{ fontSize: '0.9rem' }} title={feat.description}>
                    {feat.label}
                  </span>
                  {feat.supportsLimit && (
                    <input
                      type="number"
                      min={0}
                      placeholder="∞"
                      value={ent.limit ?? ''}
                      onChange={(e) =>
                        patchFeature(plan.code, feat.key, {
                          limit:
                            e.target.value === ''
                              ? null
                              : Math.max(0, Math.round(Number(e.target.value))),
                        })
                      }
                      style={inputStyle(70)}
                      title="usage limit (blank = unlimited)"
                    />
                  )}
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              className="btn-primary"
              style={{ padding: '8px 20px' }}
              disabled={savingCode === plan.code}
              onClick={() => save(plan)}
            >
              {savingCode === plan.code ? 'Saving…' : 'Save'}
            </button>
            {msg[plan.code] && (
              <span
                style={{
                  fontSize: '0.85rem',
                  color: msg[plan.code].startsWith('Error') ? 'var(--red)' : 'inherit',
                  opacity: 0.8,
                }}
              >
                {msg[plan.code]}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function inputStyle(width: number): React.CSSProperties {
  return {
    width,
    marginLeft: 4,
    padding: '6px 8px',
    background: 'var(--bg3)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text)',
    fontFamily: 'inherit',
  }
}


// ---------------------------------------------------------------------------
// Analytics dashboard — revenue, users, activity, plan/paid-vs-free
// distribution, usage by provider, signups & active over time, top users,
// churn. All data comes from GET /admin/analytics (DB-backed).
// ---------------------------------------------------------------------------

interface AdminAnalytics {
  totals: {
    totalUsers: number
    activeUsers24h: number
    activeUsers7d: number
    activeUsers30d: number
  }
  statusBreakdown: { active: number; suspended: number; banned: number }
  planDistribution: Array<{ code: string; name: string; priceCents: number; users: number }>
  paidVsFree: { free: number; paid: number }
  revenue: { totalCents: number; paidCount: number; byMonth: Array<{ month: string; cents: number; count: number }> }
  signupsByDay: Array<{ date: string; count: number }>
  activeByDay: Array<{ date: string; count: number }>
  usageByProvider: Array<{ provider: string; count: number }>
  topUsers: Array<{ id: number; email: string | null; displayName: string | null; count: number }>
  canceledSubscriptions: number
}

const PLAN_COLORS = ['#6d7cff', '#00d4aa', '#ffbd2e', '#ff6b9d', '#9b8cff', '#52d1ff']
const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '1.25rem' }}>
      <p style={{ margin: '0 0 0.9rem', opacity: 0.55, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Kpi({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat-cell">
      <div className="stat-num">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function Analytics({ token }: { token: string }) {
  const [a, setA] = useState<AdminAnalytics | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl('/admin/analytics'), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 403) return // parent renders forbidden
        if (!res.ok) throw new Error(`Analytics failed (${res.status})`)
        setA((await res.json()) as AdminAnalytics)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [token])

  if (err) {
    return (
      <div className="card" style={{ marginBottom: '2rem', borderColor: 'var(--red)' }}>
        <p style={{ color: 'var(--red)', margin: 0 }}>{err}</p>
      </div>
    )
  }
  if (!a) return null

  const planSlices = a.planDistribution
    .filter((p) => p.users > 0)
    .map((p, i) => ({ label: p.name, value: p.users, color: PLAN_COLORS[i % PLAN_COLORS.length] }))

  return (
    <div style={{ marginBottom: '3rem' }}>
      <h2 style={{ margin: '0 0 1rem' }}>Analytics</h2>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
        <Kpi value={a.totals.totalUsers} label="Total Users" />
        <Kpi value={a.totals.activeUsers30d} label="Active (30d)" />
        <Kpi value={a.paidVsFree.paid} label="Paid Users" />
        <Kpi value={usd(a.revenue.totalCents)} label="Total Revenue" />
        <Kpi value={a.canceledSubscriptions} label="Canceled Subs" />
      </div>

      {/* Charts grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        <ChartCard title="Revenue by month">
          {a.revenue.byMonth.length ? (
            <BarChart
              data={a.revenue.byMonth.map((m) => ({ label: m.month, value: m.cents }))}
              color="#00d4aa"
              valueFormat={usd}
            />
          ) : (
            <p style={{ opacity: 0.4, fontSize: '0.9rem' }}>No paid payments yet.</p>
          )}
        </ChartCard>

        <ChartCard title="Plan distribution">
          <Donut data={planSlices} />
        </ChartCard>

        <ChartCard title="Signups (last 30 days)">
          <BarChart data={a.signupsByDay.map((d) => ({ label: d.date.slice(5), value: d.count }))} />
        </ChartCard>

        <ChartCard title="Active users (last 14 days)">
          <LineChart data={a.activeByDay.map((d) => ({ label: d.date, value: d.count }))} />
        </ChartCard>

        <ChartCard title="Paid vs Free">
          <Donut
            data={[
              { label: 'Free', value: a.paidVsFree.free, color: '#6d7cff' },
              { label: 'Paid', value: a.paidVsFree.paid, color: '#00d4aa' },
            ]}
          />
        </ChartCard>

        <ChartCard title="User status">
          <Donut
            data={[
              { label: 'Active', value: a.statusBreakdown.active, color: '#00d4aa' },
              { label: 'Suspended', value: a.statusBreakdown.suspended, color: '#ffbd2e' },
              { label: 'Banned', value: a.statusBreakdown.banned, color: '#ff6b9d' },
            ]}
          />
        </ChartCard>

        <ChartCard title="Usage by provider">
          <HBar data={a.usageByProvider.map((u) => ({ label: u.provider, value: u.count }))} />
        </ChartCard>

        <ChartCard title="Top users by usage">
          <HBar
            data={a.topUsers.map((u) => ({
              label: u.email ?? u.displayName ?? `#${u.id}`,
              value: u.count,
            }))}
            color="#9b8cff"
          />
        </ChartCard>
      </div>
    </div>
  )
}
