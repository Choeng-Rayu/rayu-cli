'use client'
export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { apiUrl, gatewayUrl } from '../../lib/config'
import { useRayuToken } from '../../lib/useRayuToken'
import { HBar, LineChart } from '../../components/Charts'
import KhqrCard from '../../components/KhqrCard'
import {
  aggregateByModel,
  avgCreditsPerRequest,
  busiestDay,
  dailyCreditSeries,
  isPremiumPlan,
  type LedgerRow,
  pct,
  periodProgress,
  projectPeriodUsage,
  providerBreakdown,
  totals,
} from '../../lib/dashboard'

interface AllowedModel {
  code: string
  label: string
  provider: string
  creditMultiplier: number
}

interface Entitlements {
  plan: { code: string; name: string; priceCents: number; currentPeriodEnd: string | null }
  creditAllowance: { creditsPerPeriod: number | null; topUpEnabled: boolean }
  creditConfig: { baselineCreditsPer1M: number; tokensPerCredit: number }
  maxDailyTurns: number | null
  topupBalance: number
  allowedModels?: AllowedModel[]
}

interface GatewayCredits {
  plan: string
  planName: string
  priceCents: number
  creditsPerPeriod: number | null
  usedCredits: number
  remainingCredits: number | null
  tokensPerCredit: number
  allowanceTokens: number | null
  usedTokens: number | null
  remainingTokens: number | null
  resetSeconds: number
  periodEnd: string | null
  topupBalance: number
  topUpEnabled: boolean
  /** Credits one dollar buys (0 = top-up unavailable) — set by the admin. */
  creditsPerDollar: number
  /** Smallest purchase, in cents. */
  minTopupCents: number
  maxDailyTurns: number | null
  turnsUsedToday: number
  turnsRemaining: number | null
  turnsResetSeconds: number
}

interface TopupKhqr {
  paymentId: number
  credits: number
  amountCents: number
  currency: string
  qr: string
  md5: string
}

function fmtReset(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return n.toLocaleString()
}

function Bar({ used, cap }: { used: number; cap: number | null }) {
  if (cap == null) {
    return <div style={{ opacity: 0.6, fontFamily: 'DM Mono, monospace' }}>{used.toLocaleString()} used · no allowance</div>
  }
  const p = pct(used, cap)
  const danger = p >= 90
  const warn = p >= 75
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'DM Mono, monospace', fontSize: '0.85rem', marginBottom: 4 }}>
        <span>{used.toLocaleString()} / {cap.toLocaleString()}</span>
        <span style={{ opacity: 0.6 }}>{p.toFixed(0)}%</span>
      </div>
      <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${p}%`, height: '100%', background: danger ? 'var(--red)' : warn ? '#f5a623' : 'var(--green)', transition: 'width .3s ease' }} />
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className="card" style={{ padding: '1.1rem 1.25rem' }}>
      <div style={{ fontSize: '0.72rem', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '1.7rem', fontWeight: 700, lineHeight: 1.1, color: accent ? 'var(--green)' : 'var(--text)' }}>{value}</div>
      {sub != null && <div style={{ fontSize: '0.78rem', opacity: 0.55, marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.9rem' }}>
      <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem', letterSpacing: '0.04em' }}>{children}</span>
      {hint && <span style={{ fontSize: '0.72rem', opacity: 0.4 }}>{hint}</span>}
    </div>
  )
}

function DefRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', padding: '0.45rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.85rem' }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontFamily: 'DM Mono, monospace' }}>{value}</span>
    </div>
  )
}

export default function DashboardPage() {
  const { token, authError, status } = useRayuToken()
  const [ent, setEnt] = useState<Entitlements | null>(null)
  const [usage, setUsage] = useState<GatewayCredits | null>(null)
  const [gatewayDown, setGatewayDown] = useState(false)
  const [history, setHistory] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  // Top-up is priced in DOLLARS here (the rate and minimum are the admin's, read
  // from the gateway) and converted to credits when the QR is requested. The
  // previous fixed credit options were hardcoded against one particular rate and
  // silently became wrong the moment the admin changed it.
  const [dollars, setDollars] = useState(1)
  const [khqr, setKhqr] = useState<TopupKhqr | null>(null)
  const [paid, setPaid] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadAll = useCallback(async () => {
    if (!token) return
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    const [entRes, histRes] = await Promise.all([
      fetch(apiUrl('/me/entitlements'), auth),
      fetch(apiUrl('/me/credit-history?limit=200'), auth),
    ])
    if (entRes.ok) setEnt((await entRes.json()) as Entitlements)
    if (histRes.ok) setHistory((await histRes.json()) as LedgerRow[])
    try {
      const cr = await fetch(gatewayUrl('/v1/credits'), auth)
      if (cr.ok) {
        setUsage((await cr.json()) as GatewayCredits)
        setGatewayDown(false)
      } else setGatewayDown(true)
    } catch {
      setGatewayDown(true)
    }
    setLoading(false)
  }, [token])

  useEffect(() => { void loadAll() }, [loadAll])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }
  useEffect(() => () => stopPolling(), [])

  async function buyCredits() {
    if (!token) return
    setError(''); setKhqr(null); setPaid(false); stopPolling()
    try {
      const res = await fetch(apiUrl('/payments/topup-khqr'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ credits: topupCredits }),
      })
      if (!res.ok) {
        const e = (await res.json()) as { message?: string }
        setError(e.message ?? `Error ${res.status}`)
        return
      }
      const data = (await res.json()) as TopupKhqr
      setKhqr(data)
      pollRef.current = setInterval(async () => {
        const sres = await fetch(apiUrl(`/payments/${data.paymentId}/status`), { headers: { Authorization: `Bearer ${token}` } })
        if (!sres.ok) return
        const s = (await sres.json()) as { status: string }
        if (s.status === 'paid') { stopPolling(); setPaid(true); setKhqr(null); void loadAll() }
      }, 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (status === 'unauthenticated') {
    return (
      <main className="container">
        <span className="section-eyebrow">DASHBOARD</span>
        <h1 style={{ marginTop: '0.5rem' }}>Your Dashboard</h1>
        <p style={{ opacity: 0.6 }}>Please sign in to view your usage.</p>
      </main>
    )
  }
  if (authError) {
    return (
      <main className="container">
        <span className="section-eyebrow">DASHBOARD</span>
        <h1 style={{ marginTop: '0.5rem' }}>Your Dashboard</h1>
        <p style={{ color: 'var(--red)' }}>{authError}</p>
      </main>
    )
  }

  // Prefer the gateway's live (period-accurate) figures; fall back to entitlements.
  const planCode = usage?.plan ?? ent?.plan.code
  const planName = usage?.planName ?? ent?.plan.name ?? '—'
  const priceCents = usage?.priceCents ?? ent?.plan.priceCents ?? 0
  const periodEnd = usage?.periodEnd ?? ent?.plan.currentPeriodEnd ?? null
  const creditsPerPeriod = usage?.creditsPerPeriod ?? ent?.creditAllowance.creditsPerPeriod ?? null
  const usedCredits = usage?.usedCredits ?? 0
  const remainingCredits = usage?.remainingCredits ?? (creditsPerPeriod != null ? Math.max(0, creditsPerPeriod - usedCredits) : null)
  const tokensPerCredit = usage?.tokensPerCredit ?? ent?.creditConfig.tokensPerCredit ?? 0
  const allowanceTokens = usage?.allowanceTokens ?? (creditsPerPeriod != null ? creditsPerPeriod * tokensPerCredit : null)
  const usedTokens = usage?.usedTokens ?? usedCredits * tokensPerCredit
  const remainingTokens = usage?.remainingTokens ?? (allowanceTokens != null ? Math.max(0, allowanceTokens - usedTokens) : null)
  const topUpEnabled = usage?.topUpEnabled ?? ent?.creditAllowance.topUpEnabled ?? false
  const topupBalance = usage?.topupBalance ?? ent?.topupBalance ?? 0
  const creditsPerDollar = usage?.creditsPerDollar ?? 0
  const minTopupCents = usage?.minTopupCents ?? 100
  const minDollars = Math.max(0.01, minTopupCents / 100)
  const topupCredits = Math.floor(dollars * creditsPerDollar)
  const maxDailyTurns = usage?.maxDailyTurns ?? ent?.maxDailyTurns ?? null
  const turnsUsedToday = usage?.turnsUsedToday ?? 0
  const turnsRemaining = usage?.turnsRemaining ?? (maxDailyTurns != null ? Math.max(0, maxDailyTurns - turnsUsedToday) : null)

  const premium = isPremiumPlan(creditsPerPeriod, planCode)
  const period = periodProgress(periodEnd)
  const projection = projectPeriodUsage(usedCredits, period?.fractionElapsed ?? 0, creditsPerPeriod)
  const allowedModels = ent?.allowedModels ?? []
  const resetLabel = usage ? fmtReset(usage.resetSeconds) : period ? `${period.daysLeft}d` : '—'
  const cappedTurns = maxDailyTurns != null && maxDailyTurns > 0

  // History-derived analytics (recent activity; window = last up-to-200 events).
  const hist = history
  const hasUsage = usedCredits > 0 || hist.length > 0
  const series = dailyCreditSeries(hist, 14)
  const tot = totals(hist)
  const avgCr = avgCreditsPerRequest(hist)
  const byModel = aggregateByModel(hist)
  const codeToProvider: Record<string, string> = Object.fromEntries(allowedModels.map((m) => [m.code, m.provider]))
  const byProvider = providerBreakdown(hist, codeToProvider)
  const busiest = busiestDay(series)
  const lastActiveAt = hist[0]?.createdAt ?? null

  const GRID2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' } as const

  return (
    <main className="container">
      <div style={{ marginBottom: '1.5rem' }}>
        <span className="section-eyebrow">DASHBOARD</span>
        <h1 style={{ marginTop: '0.5rem', marginBottom: 0 }}>Your Dashboard</h1>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.5rem' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}
      {paid && (
        <div className="card" style={{ borderColor: 'var(--green)', background: 'var(--green-glow)', marginBottom: '1.5rem' }}>
          <p style={{ color: 'var(--green)', margin: 0 }}>Top-up confirmed — your balance has been updated.</p>
        </div>
      )}

      {/* PLAN HERO */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '1.5rem', fontWeight: 700 }}>{planName}</span>
              {premium && (
                <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.6rem', letterSpacing: '0.14em', padding: '4px 9px', borderRadius: 5, color: 'var(--green)', border: '1px solid var(--border-bright)', background: 'var(--green-glow)' }}>
                  PREMIUM
                </span>
              )}
              {priceCents > 0 && <span style={{ opacity: 0.5, fontSize: '0.9rem' }}>{usd(priceCents)}/mo</span>}
            </div>
            <div style={{ opacity: 0.6, fontSize: '0.85rem', marginTop: 6 }}>
              {periodEnd
                ? `Renews ${new Date(periodEnd).toLocaleDateString()}${period ? ` · ${period.daysLeft} day${period.daysLeft === 1 ? '' : 's'} left` : ''}`
                : premium ? 'Active hosted plan' : 'No active paid period'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: '0.85rem' }} onClick={() => void loadAll()}>Refresh</button>
            <a href="/billing" className="btn-primary" style={{ padding: '6px 16px', fontSize: '0.85rem' }}>{premium ? 'Manage plan' : 'Upgrade'}</a>
          </div>
        </div>
        {premium && period && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, period.fractionElapsed * 100)}%`, height: '100%', background: 'var(--green-dim)' }} />
            </div>
            <div style={{ fontSize: '0.72rem', opacity: 0.45, marginTop: 5 }}>Day {period.daysElapsed} of {period.periodDays} in this billing period</div>
          </div>
        )}
      </div>

      {loading && !ent && !usage && <p style={{ opacity: 0.5 }}>Loading your usage…</p>}

      {premium ? (
        <>
          {/* AT-A-GLANCE STAT CARDS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <StatCard accent label="Credits left" value={(remainingCredits ?? 0).toLocaleString()} sub={`of ${(creditsPerPeriod ?? 0).toLocaleString()} · resets in ${resetLabel}`} />
            <StatCard label="Used this period" value={usedCredits.toLocaleString()} sub={`${remainingTokens != null ? compact(remainingTokens) : '—'} tokens left`} />
            <StatCard label="Requests (recent)" value={tot.requests.toLocaleString()} sub={`avg ${avgCr.toFixed(2)} cr / request`} />
            {topUpEnabled ? (
              <StatCard label="Top-up balance" value={topupBalance.toLocaleString()} sub="pay-as-you-go credits" />
            ) : cappedTurns ? (
              <StatCard label="Turns left today" value={(turnsRemaining ?? 0).toLocaleString()} sub={`of ${maxDailyTurns}`} />
            ) : (
              <StatCard label="Models available" value={allowedModels.length || '—'} sub="on your plan" />
            )}
          </div>

          {/* DAILY USAGE TREND */}
          {hasUsage && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <SectionTitle hint="last 14 days">Daily credit usage</SectionTitle>
              <LineChart data={series} />
              <div style={{ fontSize: '0.78rem', opacity: 0.5, marginTop: '0.5rem' }}>
                {tot.credits.toLocaleString()} credits across {tot.requests.toLocaleString()} requests in recent activity
                {busiest ? ` · busiest day ${busiest.label.slice(5)} (${busiest.value.toLocaleString()} cr)` : ''}
              </div>
            </div>
          )}

          {/* USAGE BARS + INSIGHTS */}
          <div style={GRID2}>
            <div className="card">
              <SectionTitle>Credit usage</SectionTitle>
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>Credits{usage ? ` · resets in ${fmtReset(usage.resetSeconds)}` : ''}</div>
                <Bar used={usedCredits} cap={creditsPerPeriod} />
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: 6 }}>{(remainingCredits ?? 0).toLocaleString()} credits left</div>
              </div>
              <div>
                <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>Tokens (1 credit = {compact(tokensPerCredit)})</div>
                <Bar used={usedTokens} cap={allowanceTokens} />
              </div>
              {projection && (
                <p style={{ fontSize: '0.82rem', marginTop: '1rem', marginBottom: 0, color: projection.willExceed ? 'var(--red)' : 'inherit', opacity: projection.willExceed ? 1 : 0.6 }}>
                  At your current pace you&apos;ll use about <strong>{projection.projectedCredits.toLocaleString()}</strong> credits by renewal
                  {projection.willExceed ? ` — above your ${(creditsPerPeriod ?? 0).toLocaleString()}-credit allowance. Consider a top-up.` : ' — within your allowance.'}
                </p>
              )}
              {cappedTurns && (
                <div style={{ marginTop: '1.25rem' }}>
                  <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>Daily turns{usage ? ` · resets in ${fmtReset(usage.turnsResetSeconds)}` : ''}</div>
                  <Bar used={turnsUsedToday} cap={maxDailyTurns} />
                </div>
              )}
              {gatewayDown && <p style={{ opacity: 0.45, fontSize: '0.8rem', marginTop: '1rem', marginBottom: 0 }}>Live usage temporarily unavailable; showing your allowance only.</p>}
            </div>

            <div className="card">
              <SectionTitle hint="recent">At a glance</SectionTitle>
              <DefRow label="Tokens in" value={compact(tot.inTokens)} />
              <DefRow label="Tokens out" value={compact(tot.outTokens)} />
              <DefRow label="Avg credits / request" value={avgCr.toFixed(2)} />
              <DefRow label="Busiest day" value={busiest ? `${busiest.label.slice(5)} · ${busiest.value.toLocaleString()} cr` : '—'} />
              <DefRow label="Last activity" value={lastActiveAt ? new Date(lastActiveAt).toLocaleString() : '—'} />
              <div style={{ marginTop: '0.9rem' }}>
                <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: 8 }}>Token split (recent)</div>
                <HBar
                  data={[{ label: 'Input', value: tot.inTokens }, { label: 'Output', value: tot.outTokens }]}
                  valueFormat={(n) => compact(n)}
                />
              </div>
            </div>
          </div>

          {/* BREAKDOWNS BY MODEL + PROVIDER */}
          {hasUsage && (
            <div style={GRID2}>
              <div className="card">
                <SectionTitle hint="recent">Credits by model</SectionTitle>
                <HBar
                  data={byModel.slice(0, 8).map((m) => ({ label: m.modelCode, value: m.credits }))}
                  valueFormat={(n) => `${n.toLocaleString()} cr`}
                />
              </div>
              <div className="card">
                <SectionTitle hint="recent">Credits by provider</SectionTitle>
                <HBar
                  data={byProvider.map((p) => ({ label: p.label, value: p.value }))}
                  color="var(--green-dim)"
                  valueFormat={(n) => `${n.toLocaleString()} cr`}
                />
              </div>
            </div>
          )}

          {/* GET STARTED (no usage yet) */}
          {!hasUsage && (
            <div className="card" style={{ marginBottom: '1.5rem', borderColor: 'var(--border-bright)' }}>
              <SectionTitle>Get started with {planName}</SectionTitle>
              <p style={{ opacity: 0.6, fontSize: '0.88rem', marginTop: 0 }}>You haven&apos;t used any credits yet. Connect the CLI to start using Rayu-hosted models — no API key needed.</p>
              <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', lineHeight: 2, fontSize: '0.9rem' }}>
                <li>Install / update the CLI: <code style={{ background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4 }}>npm i -g @rayu-dev/rayu-cli</code></li>
                <li>Start with hosted access: <code style={{ background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4 }}>Type: rayu</code>, then <code style={{ background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4 }}>/login</code></li>
                <li>Pick a hosted model with <code style={{ background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4 }}>/model</code> and start chatting</li>
              </ol>
            </div>
          )}

          {/* MODELS ON PLAN */}
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <SectionTitle>Models on your plan</SectionTitle>
            {allowedModels.length === 0 ? (
              <p style={{ opacity: 0.5, fontSize: '0.88rem', margin: 0 }}>Your plan&apos;s hosted models will appear here.</p>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.5rem 1.5rem' }}>
                  {allowedModels.map((m) => (
                    <div key={m.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{m.label}</div>
                        <div style={{ opacity: 0.45, fontSize: '0.75rem' }}>{m.provider}</div>
                      </div>
                      <span className="badge" style={{ fontFamily: 'DM Mono, monospace' }}>{m.creditMultiplier}× credits</span>
                    </div>
                  ))}
                </div>
                <p style={{ opacity: 0.45, fontSize: '0.76rem', marginTop: '0.75rem', marginBottom: 0 }}>
                  1 credit ≈ {compact(tokensPerCredit)} tokens at 1×. Cheaper models spend credits more slowly.
                </p>
              </>
            )}
          </div>

          {/* TOP-UP */}
          {topUpEnabled && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <SectionTitle>Pay-as-you-go top-up</SectionTitle>
              <p style={{ fontFamily: 'DM Mono, monospace', marginTop: 0, marginBottom: '1rem' }}>Balance: {topupBalance.toLocaleString()} credits</p>
              {khqr ? (
                <div style={{ maxWidth: 400, margin: '0 auto' }}>
                  <KhqrCard
                    merchant="CHOENG RAYU"
                    amount={(khqr.amountCents / 100).toFixed(2)}
                    currency={khqr.currency}
                    qrValue={khqr.qr}
                    onCancel={() => { setKhqr(null); stopPolling() }}
                    status="pending"
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>Amount ($)</span>
                    <input
                      type="number"
                      className="admin-input"
                      style={{ width: 110 }}
                      min={minDollars}
                      step={1}
                      value={dollars}
                      onChange={(e) => setDollars(Math.max(minDollars, Number(e.target.value)))}
                    />
                  </label>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.85rem', opacity: 0.75 }}>
                    = {topupCredits.toLocaleString()} credits
                    {tokensPerCredit > 0 && ` (≈ ${compact(topupCredits * tokensPerCredit)} tokens)`}
                  </span>
                  <button
                    className="btn-primary"
                    style={{ padding: '10px 22px' }}
                    disabled={creditsPerDollar <= 0 || topupCredits <= 0}
                    onClick={() => void buyCredits()}
                  >
                    Buy with Bakong KHQR
                  </button>
                  <span style={{ opacity: 0.45, fontSize: '0.76rem', width: '100%' }}>
                    {creditsPerDollar > 0
                      ? `$1 = ${creditsPerDollar.toLocaleString()} credits · minimum $${minDollars.toFixed(2)}`
                      : 'Top-ups are currently unavailable.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* USAGE HISTORY */}
          <div>
            <SectionTitle hint={hist.length ? `${hist.length} recent` : undefined}>Usage history</SectionTitle>
            {hist.length === 0 ? (
              <p style={{ opacity: 0.5 }}>No hosted usage yet.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Date</th><th>Model</th><th>In</th><th>Out</th><th>Credits</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {hist.slice(0, 50).map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>{new Date(r.createdAt).toLocaleString()}</td>
                      <td>{r.modelCode}</td>
                      <td style={{ fontFamily: 'DM Mono, monospace' }}>{r.inTokens.toLocaleString()}</td>
                      <td style={{ fontFamily: 'DM Mono, monospace' }}>{r.outTokens.toLocaleString()}</td>
                      <td style={{ fontFamily: 'DM Mono, monospace' }}>{r.credits.toLocaleString()}</td>
                      <td><span className="badge">{r.source}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        /* FREE / non-hosted plan — upgrade prompt */
        <div className="card" style={{ borderColor: 'var(--border-bright)' }}>
          <SectionTitle>Unlock Rayu-hosted models</SectionTitle>
          <p style={{ opacity: 0.7, marginTop: 0 }}>
            Your current plan has no hosted credit allowance. Upgrade to a premium plan to use Rayu-hosted
            models with a monthly credit allowance — no API key required.
          </p>
          <ul style={{ opacity: 0.7, fontSize: '0.9rem', lineHeight: 1.9, margin: '0.5rem 0 1.25rem', paddingLeft: '1.2rem' }}>
            <li>A monthly credit allowance for hosted models</li>
            <li>Pay-as-you-go top-ups when you need more</li>
            <li>Daily usage trends, per-model and per-provider breakdowns</li>
          </ul>
          <a href="/billing" className="btn-primary" style={{ display: 'inline-block', padding: '10px 22px' }}>View plans</a>
        </div>
      )}
    </main>
  )
}
