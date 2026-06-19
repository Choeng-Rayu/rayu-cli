'use client'
export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { apiUrl, gatewayUrl } from '../../lib/config'
import { useRayuToken } from '../../lib/useRayuToken'

interface Entitlements {
  plan: { code: string; name: string; priceCents: number; currentPeriodEnd: string | null }
  creditAllowance: { creditsPerPeriod: number | null; topUpEnabled: boolean }
  creditConfig: { baselineCreditsPer1M: number; tokensPerCredit: number }
  topupBalance: number
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
}

interface LedgerRow {
  id: number
  modelCode: string
  inTokens: number
  outTokens: number
  credits: number
  source: string
  createdAt: string
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

function Bar({ used, cap }: { used: number; cap: number | null }) {
  if (cap == null) return <div style={{ opacity: 0.6, fontFamily: 'DM Mono, monospace' }}>{used.toLocaleString()} used · no allowance</div>
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const danger = pct >= 90
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'DM Mono, monospace', fontSize: '0.85rem', marginBottom: 4 }}>
        <span>{used.toLocaleString()} / {cap.toLocaleString()}</span>
        <span style={{ opacity: 0.6 }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: danger ? 'var(--red)' : 'var(--green)' }} />
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { token, authError, isLoaded, isSignedIn } = useRayuToken()
  const [ent, setEnt] = useState<Entitlements | null>(null)
  const [usage, setUsage] = useState<GatewayCredits | null>(null)
  const [gatewayDown, setGatewayDown] = useState(false)
  const [history, setHistory] = useState<LedgerRow[]>([])
  const [amount, setAmount] = useState(50)
  const [khqr, setKhqr] = useState<TopupKhqr | null>(null)
  const [paid, setPaid] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadAll = useCallback(async () => {
    if (!token) return
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    const [entRes, histRes] = await Promise.all([
      fetch(apiUrl('/me/entitlements'), auth),
      fetch(apiUrl('/me/credit-history'), auth),
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
        body: JSON.stringify({ credits: amount }),
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

  if (isLoaded && !isSignedIn) {
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

  // Prefer the gateway's live figures; fall back to entitlements for the allowance.
  const planName = usage?.planName ?? ent?.plan.name ?? '—'
  const priceCents = usage?.priceCents ?? ent?.plan.priceCents ?? 0
  const periodEnd = usage?.periodEnd ?? ent?.plan.currentPeriodEnd ?? null
  const creditsPerPeriod = usage?.creditsPerPeriod ?? ent?.creditAllowance.creditsPerPeriod ?? null
  const usedCredits = usage?.usedCredits ?? 0
  const remainingCredits = usage?.remainingCredits ?? (creditsPerPeriod != null ? creditsPerPeriod - usedCredits : null)
  const tokensPerCredit = usage?.tokensPerCredit ?? ent?.creditConfig.tokensPerCredit ?? 0
  const allowanceTokens = usage?.allowanceTokens ?? (creditsPerPeriod != null ? creditsPerPeriod * tokensPerCredit : null)
  const usedTokens = usage?.usedTokens ?? usedCredits * tokensPerCredit
  const topUpEnabled = usage?.topUpEnabled ?? ent?.creditAllowance.topUpEnabled ?? false
  const topupBalance = usage?.topupBalance ?? ent?.topupBalance ?? 0

  return (
    <main className="container">
      <div style={{ marginBottom: '2rem' }}>
        <span className="section-eyebrow">DASHBOARD</span>
        <h1 style={{ marginTop: '0.5rem' }}>Your Dashboard</h1>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.5rem' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Plan + usage */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{planName}{priceCents > 0 ? ` · ${usd(priceCents)}/mo` : ''}</div>
            <div style={{ opacity: 0.6, fontSize: '0.85rem' }}>
              {periodEnd ? `Renews ${new Date(periodEnd).toLocaleDateString()}` : 'No active paid period'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: '0.85rem' }} onClick={() => void loadAll()}>Refresh</button>
            <a href="/billing" className="btn-primary" style={{ padding: '6px 16px', fontSize: '0.85rem' }}>Manage plan</a>
          </div>
        </div>

        {creditsPerPeriod == null ? (
          <p style={{ opacity: 0.6 }}>
            This plan has no hosted credit allowance. <a href="/billing" style={{ color: 'var(--green)' }}>Upgrade</a> to use Rayu‑hosted models.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem' }}>
            <div>
              <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>
                Credits{usage ? ` · resets in ${fmtReset(usage.resetSeconds)}` : ''}
              </div>
              <Bar used={usedCredits} cap={creditsPerPeriod} />
              <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: 6 }}>
                {(remainingCredits ?? 0).toLocaleString()} credits left
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>Tokens (1 credit = {tokensPerCredit.toLocaleString()})</div>
              <Bar used={usedTokens} cap={allowanceTokens} />
            </div>
          </div>
        )}
        {gatewayDown && <p style={{ opacity: 0.45, fontSize: '0.8rem', marginTop: '1rem' }}>Live usage temporarily unavailable; showing your allowance only.</p>}
      </div>

      {/* Top-up */}
      {topUpEnabled && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 0.75rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Pay-as-you-go top-up</p>
          <p style={{ fontFamily: 'DM Mono, monospace', marginBottom: '1rem' }}>Balance: {topupBalance.toLocaleString()} credits</p>
          {paid && <p style={{ color: 'var(--green)', marginBottom: '1rem' }}>Top-up confirmed — balance updated.</p>}
          {khqr ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <p style={{ opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '1rem' }}>
                Scan to pay — {khqr.credits.toLocaleString()} credits — ${(khqr.amountCents / 100).toFixed(2)} {khqr.currency}
              </p>
              <div style={{ display: 'inline-block', padding: '1.25rem', background: '#fff', borderRadius: 12, marginBottom: '1rem' }}>
                <QRCodeSVG value={khqr.qr} size={200} />
              </div>
              <p style={{ opacity: 0.4, fontSize: '0.85rem' }}>Waiting for payment confirmation…</p>
              <button className="btn-ghost" style={{ padding: '6px 16px', fontSize: '0.85rem' }} onClick={() => { setKhqr(null); stopPolling() }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="admin-select" value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 220 }}>
                <option value={50}>50 credits (5M tokens)</option>
                <option value={115}>115 credits</option>
                <option value={300}>300 credits</option>
              </select>
              <button className="btn-primary" style={{ padding: '10px 22px' }} onClick={() => void buyCredits()}>Buy with Bakong KHQR</button>
            </div>
          )}
        </div>
      )}

      {/* Usage history */}
      <div style={{ marginTop: '2rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>Usage history</h2>
        {history.length === 0 ? (
          <p style={{ opacity: 0.5 }}>No hosted usage yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Model</th><th>In</th><th>Out</th><th>Credits</th><th>Source</th></tr>
            </thead>
            <tbody>
              {history.map((r) => (
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
    </main>
  )
}
