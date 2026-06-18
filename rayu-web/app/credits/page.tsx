'use client'
export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { apiUrl, gatewayUrl } from '../../lib/config'
import { useRayuToken } from '../../lib/useRayuToken'

interface Entitlements {
  plan: { code: string; name: string; currentPeriodEnd: string | null }
  creditAllowance: { creditsPerWeek: number | null; creditsPer5h: number | null; topUpEnabled: boolean }
  topupBalance: number
}

interface GatewayCredits {
  plan: string
  creditsPerWeek: number | null
  creditsPer5h: number | null
  used5h: number
  usedWeek: number
  remaining5h: number | null
  remainingWeek: number | null
  reset5hSeconds: number
  resetWeekSeconds: number
  topupBalance: number
  topUpEnabled: boolean
}

interface LedgerRow {
  id: number
  modelCode: string
  inTokens: number
  outTokens: number
  credits: number
  realCostCents: number
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
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function UsageBar({ used, cap }: { used: number; cap: number | null }) {
  if (cap == null) {
    return <div style={{ opacity: 0.6, fontFamily: 'DM Mono, monospace' }}>{used.toLocaleString()} used · unlimited</div>
  }
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

export default function CreditsPage() {
  const { token, authError, isLoaded, isSignedIn } = useRayuToken()
  const [ent, setEnt] = useState<Entitlements | null>(null)
  const [usage, setUsage] = useState<GatewayCredits | null>(null)
  const [gatewayDown, setGatewayDown] = useState(false)
  const [history, setHistory] = useState<LedgerRow[]>([])
  const [amount, setAmount] = useState(5000)
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
      } else {
        setGatewayDown(true)
      }
    } catch {
      setGatewayDown(true)
    }
  }, [token])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  useEffect(() => () => stopPolling(), [])

  async function buyCredits() {
    if (!token) return
    setError('')
    setKhqr(null)
    setPaid(false)
    stopPolling()
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
        const sres = await fetch(apiUrl(`/payments/${data.paymentId}/status`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!sres.ok) return
        const s = (await sres.json()) as { status: string }
        if (s.status === 'paid') {
          stopPolling()
          setPaid(true)
          setKhqr(null)
          void loadAll()
        }
      }, 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (isLoaded && !isSignedIn) {
    return (
      <main className="container">
        <span className="section-eyebrow">CREDITS</span>
        <h1 style={{ marginTop: '0.5rem' }}>Credits &amp; Usage</h1>
        <p style={{ opacity: 0.6 }}>Please sign in to view your credits.</p>
      </main>
    )
  }
  if (authError) {
    return (
      <main className="container">
        <span className="section-eyebrow">CREDITS</span>
        <h1 style={{ marginTop: '0.5rem' }}>Credits &amp; Usage</h1>
        <p style={{ color: 'var(--red)' }}>{authError}</p>
      </main>
    )
  }

  const allowance = ent?.creditAllowance
  const topUpEnabled = allowance?.topUpEnabled ?? false
  const topupBalance = usage?.topupBalance ?? ent?.topupBalance ?? 0

  return (
    <main className="container">
      <div style={{ marginBottom: '2.5rem' }}>
        <span className="section-eyebrow">CREDITS</span>
        <h1 style={{ marginTop: '0.5rem' }}>Credits &amp; Usage</h1>
        <p style={{ opacity: 0.6 }}>
          {ent ? (
            <>Plan <strong>{ent.plan.name}</strong>{ent.plan.currentPeriodEnd ? ` · active until ${new Date(ent.plan.currentPeriodEnd).toLocaleDateString()}` : ''}</>
          ) : (
            'Loading…'
          )}
        </p>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.5rem' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <p style={{ margin: 0, opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Hosted credit allowance</p>
          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={() => void loadAll()}>Refresh</button>
        </div>
        {allowance && allowance.creditsPerWeek == null && allowance.creditsPer5h == null ? (
          <p style={{ opacity: 0.6 }}>
            Your plan has no hosted credit allowance. <a href="/billing" style={{ color: 'var(--green)' }}>Upgrade a plan</a> to use Rayu-hosted models.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem' }}>
            <div>
              <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>This week{usage ? ` · resets in ${fmtReset(usage.resetWeekSeconds)}` : ''}</div>
              <UsageBar used={usage?.usedWeek ?? 0} cap={allowance?.creditsPerWeek ?? null} />
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', opacity: 0.6, marginBottom: 6 }}>This 5h window{usage ? ` · resets in ${fmtReset(usage.reset5hSeconds)}` : ''}</div>
              <UsageBar used={usage?.used5h ?? 0} cap={allowance?.creditsPer5h ?? null} />
            </div>
          </div>
        )}
        {gatewayDown && (
          <p style={{ opacity: 0.45, fontSize: '0.8rem', marginTop: '1rem' }}>Live usage is temporarily unavailable; showing your allowance only.</p>
        )}
      </div>

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
              <select className="admin-select" value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ width: 200 }}>
                <option value={5000}>5,000 credits</option>
                <option value={20000}>20,000 credits</option>
                <option value={50000}>50,000 credits</option>
                <option value={100000}>100,000 credits</option>
              </select>
              <button className="btn-primary" style={{ padding: '10px 22px' }} onClick={() => void buyCredits()}>Buy with Bakong KHQR</button>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '2rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>Usage history</h2>
        {history.length === 0 ? (
          <p style={{ opacity: 0.5 }}>No hosted usage yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Model</th>
                <th>In</th>
                <th>Out</th>
                <th>Credits</th>
                <th>Source</th>
              </tr>
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
