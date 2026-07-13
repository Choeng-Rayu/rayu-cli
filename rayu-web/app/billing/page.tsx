'use client'
export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '../../lib/config'
import { useRayuToken } from '../../lib/useRayuToken'
import { Plan, purchasablePlans } from '../../lib/plans'
import KhqrCard from '../../components/KhqrCard'

const PAID_PLAN_CODES = ['pro', 'pro_plus', 'max'] as const
type PaidPlanCode = typeof PAID_PLAN_CODES[number]

interface KhqrResponse {
  paymentId: number
  planCode: string
  amountCents: number
  currency: string
  qr: string
  md5: string
}

interface PaymentStatus {
  paymentId: number
  status: 'pending' | 'paid' | 'failed'
  planCode: string
  activated: boolean
}

interface PaymentHistoryItem {
  id: number
  planCode: string | null
  provider: string
  amountCents: number
  currency: string
  status: string
  createdAt: string
  paidAt: string | null
}

interface Entitlements {
  plan: { code: string; name: string; priceCents: number; currentPeriodEnd: string | null }
  creditAllowance: { creditsPerPeriod: number | null; topUpEnabled: boolean }
  topupBalance: number
}

// Result of POST /payments/promo/preview — the discounted price for a plan.
interface PromoPreview {
  code: string
  originalCents: number
  discountCents: number
  finalCents: number
  isFree: boolean
  currency: string
}

export default function BillingPage() {
  const { token, authError, status } = useRayuToken()
  const [plans, setPlans] = useState<Plan[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PaidPlanCode | ''>('')
  const [khqr, setKhqr] = useState<KhqrResponse | null>(null)
  const [pollStatus, setPollStatus] = useState<PaymentStatus | null>(null)
  const [history, setHistory] = useState<PaymentHistoryItem[]>([])
  const [me, setMe] = useState<Entitlements | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Promo code state.
  const [promoInput, setPromoInput] = useState('')
  const [promo, setPromo] = useState<PromoPreview | null>(null)
  const [promoBusy, setPromoBusy] = useState(false)
  const [promoError, setPromoError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load plans and payment history once token is ready
  useEffect(() => {
    if (!token) return
    void (async () => {
      const [plansRes, historyRes] = await Promise.all([
        fetch(apiUrl('/plans')),
        fetch(apiUrl('/payments/mine'), { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (plansRes.ok) {
        const data = (await plansRes.json()) as Plan[]
        setPlans(purchasablePlans(data))
      }
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { items: PaymentHistoryItem[] }
        setHistory(data.items)
      }
      const entRes = await fetch(apiUrl('/me/entitlements'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (entRes.ok) setMe((await entRes.json()) as Entitlements)
    })()
  }, [token])

  // Pre-select plan from query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const plan = params.get('plan')
    if (plan && (PAID_PLAN_CODES as readonly string[]).includes(plan)) {
      setSelectedPlan(plan as PaidPlanCode)
    }
  }, [])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  function startPolling(paymentId: number) {
    stopPolling()
    pollRef.current = setInterval(async () => {
      if (!token) return
      try {
        const res = await fetch(apiUrl(`/payments/${paymentId}/status`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const status = (await res.json()) as PaymentStatus
        setPollStatus(status)
        if (status.status === 'paid' || status.status === 'failed') {
          stopPolling()
          // Refresh history
          const histRes = await fetch(apiUrl('/payments/mine'), { headers: { Authorization: `Bearer ${token}` } })
          if (histRes.ok) {
            const data = (await histRes.json()) as { items: PaymentHistoryItem[] }
            setHistory(data.items)
          }
        }
      } catch { /* silent */ }
    }, 3000)
  }

  useEffect(() => () => stopPolling(), [])

  async function initiatePayment() {
    if (!token || !selectedPlan) return
    setLoading(true)
    setError('')
    setKhqr(null)
    setPollStatus(null)
    stopPolling()
    try {
      const res = await fetch(apiUrl('/payments/khqr'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          planCode: selectedPlan,
          // Apply a validated, non-free promo so the QR is for the discounted amount.
          ...(promo && !promo.isFree ? { promoCode: promo.code } : {}),
        }),
      })
      if (!res.ok) {
        const err = (await res.json()) as { message?: string }
        setError(err.message ?? `Error ${res.status}`)
        return
      }
      const data = (await res.json()) as KhqrResponse
      setKhqr(data)
      startPolling(data.paymentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // Validate a promo code for the selected plan and show its discounted price.
  async function applyPromo() {
    if (!token || !selectedPlan || !promoInput.trim()) return
    setPromoBusy(true)
    setPromoError('')
    setPromo(null)
    try {
      const res = await fetch(apiUrl('/payments/promo/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planCode: selectedPlan, code: promoInput.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPromoError((data as { message?: string }).message ?? `Error ${res.status}`)
        return
      }
      setPromo(data as PromoPreview)
    } catch (e) {
      setPromoError(e instanceof Error ? e.message : String(e))
    } finally {
      setPromoBusy(false)
    }
  }

  // Claim a $0 (100%-off) plan — activates immediately, no QR/payment.
  async function claimFree() {
    if (!token || !selectedPlan || !promo?.isFree) return
    setPromoBusy(true)
    setPromoError('')
    setError('')
    try {
      const res = await fetch(apiUrl('/payments/promo/claim'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planCode: selectedPlan, code: promo.code }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPromoError((data as { message?: string }).message ?? `Error ${res.status}`)
        return
      }
      // Reuse the paid-success UI.
      setPollStatus({
        paymentId: (data as { paymentId: number }).paymentId,
        status: 'paid',
        planCode: selectedPlan,
        activated: true,
      })
      const histRes = await fetch(apiUrl('/payments/mine'), { headers: { Authorization: `Bearer ${token}` } })
      if (histRes.ok) {
        setHistory(((await histRes.json()) as { items: PaymentHistoryItem[] }).items)
      }
    } catch (e) {
      setPromoError(e instanceof Error ? e.message : String(e))
    } finally {
      setPromoBusy(false)
    }
  }

  function retry() {
    setKhqr(null)
    setPollStatus(null)
    stopPolling()
  }

  if (status === 'unauthenticated') {
    return (
      <main className="container">
        <span className="section-eyebrow">BILLING</span>
        <h1 style={{ marginTop: '0.5rem' }}>Upgrade Your Plan</h1>
        <p style={{ opacity: 0.6 }}>Please sign in to upgrade your plan.</p>
      </main>
    )
  }

  if (authError) {
    return (
      <main className="container">
        <span className="section-eyebrow">BILLING</span>
        <h1 style={{ marginTop: '0.5rem' }}>Upgrade Your Plan</h1>
        <p style={{ color: 'var(--red)' }}>{authError}</p>
      </main>
    )
  }

  return (
    <main className="container">
      <div style={{ marginBottom: '3rem' }}>
        <span className="section-eyebrow">BILLING</span>
        <h1 style={{ marginTop: '0.5rem' }}>Upgrade Your Plan</h1>
        <p style={{ opacity: 0.6 }}>Pay securely via Bakong KHQR. Scan the QR code in your Bakong app.</p>
      </div>

      {me && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <p style={{ margin: '0 0 0.75rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Current plan</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{me.plan.name}</div>
              <div style={{ opacity: 0.6, fontSize: '0.85rem' }}>
                {me.plan.currentPeriodEnd
                  ? `Active until ${new Date(me.plan.currentPeriodEnd).toLocaleDateString()}`
                  : 'No active paid period'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.9rem' }}>
                Top-up balance: {me.topupBalance.toLocaleString()} credits
              </div>
              <a href="/credits" style={{ fontSize: '0.85rem', color: 'var(--green)' }}>View credits &amp; usage →</a>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '2rem' }}>
          <p style={{ color: 'var(--red)', margin: 0, fontWeight: 600 }}>{error}</p>
        </div>
      )}

      {/* Success state */}
      {pollStatus?.status === 'paid' && (
        <div className="card" style={{ borderColor: '#27c93f', background: 'rgba(39,201,63,0.05)', marginBottom: '2rem', textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>Payment Confirmed</div>
          <p style={{ opacity: 0.7, marginBottom: '1.5rem' }}>
            Your <strong>{pollStatus.planCode}</strong> plan has been activated.
          </p>
          <a href="/plans" className="btn-primary" style={{ display: 'inline-block', padding: '12px 28px' }}>
            Go to Dashboard
          </a>
        </div>
      )}

      {/* Failed state */}
      {pollStatus?.status === 'failed' && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '2rem', textAlign: 'center', padding: '2rem' }}>
          <p style={{ color: 'var(--red)', fontWeight: 600, marginBottom: '1rem' }}>Payment failed or expired.</p>
          <button className="btn-primary" onClick={retry} style={{ padding: '10px 24px' }}>Try Again</button>
        </div>
      )}

      {/* QR state */}
      {khqr && !pollStatus?.status && (
        <div style={{ maxWidth: 420, margin: '0 auto 2rem' }}>
          <KhqrCard
            merchant="CHOENG RAYU"
            amount={(khqr.amountCents / 100).toFixed(2)}
            currency={khqr.currency}
            qrValue={khqr.qr}
            onCancel={retry}
            status="pending"
          />
        </div>
      )}

      {/* QR state with pending poll */
      }
      {khqr && pollStatus?.status === 'pending' && (
        <div style={{ maxWidth: 420, margin: '0 auto 2rem' }}>
          <KhqrCard
            merchant="CHOENG RAYU"
            amount={(khqr.amountCents / 100).toFixed(2)}
            currency={khqr.currency}
            qrValue={khqr.qr}
            onCancel={retry}
            status="pending"
          />
        </div>
      )}

      {/* Plan picker — only show when no active QR */}
      {!khqr && !pollStatus && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <p style={{ margin: '0 0 1rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Select a Plan</p>
          {plans.length === 0 && !token && <p style={{ opacity: 0.4 }}>Loading plans...</p>}
          {plans.length === 0 && token && <p style={{ opacity: 0.4 }}>No paid plans are currently available.</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {plans.map((p) => (
              <button
                key={p.code}
                className={selectedPlan === p.code ? 'btn-primary' : 'btn-ghost'}
                style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', textAlign: 'left' }}
                onClick={() => { setSelectedPlan(p.code as PaidPlanCode); setPromo(null); setPromoError('') }}
              >
                <span style={{ fontWeight: 700 }}>{p.name}</span>
                <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>${(p.priceCents / 100).toFixed(0)}/mo</span>
              </button>
            ))}
          </div>
          {/* Promo / discount code */}
          <div style={{ marginBottom: '1.5rem' }}>
            <p style={{ margin: '0 0 0.5rem', opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase' }}>Promo code (optional)</p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input
                value={promoInput}
                onChange={(e) => { setPromoInput(e.target.value); setPromo(null); setPromoError('') }}
                placeholder="e.g. rayu-cli"
                style={{ flex: 1, minWidth: 160, padding: '0.6rem 0.8rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'inherit', fontSize: '0.95rem' }}
              />
              <button
                className="btn-ghost"
                disabled={!selectedPlan || !promoInput.trim() || promoBusy}
                style={{ padding: '0 1.4rem' }}
                onClick={() => void applyPromo()}
              >
                {promoBusy ? 'Checking…' : 'Apply'}
              </button>
            </div>
            {!selectedPlan && <p style={{ opacity: 0.4, fontSize: '0.8rem', marginTop: 6 }}>Select a plan first.</p>}
            {promoError && <p style={{ color: 'var(--red)', fontSize: '0.85rem', marginTop: 6 }}>{promoError}</p>}
            {promo && (
              <div style={{ marginTop: 12, fontSize: '0.9rem', maxWidth: 320 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ opacity: 0.6 }}>Original</span>
                  <span style={{ fontFamily: 'DM Mono, monospace' }}>${(promo.originalCents / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green)' }}>
                  <span>Discount ({promo.code})</span>
                  <span style={{ fontFamily: 'DM Mono, monospace' }}>−${(promo.discountCents / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                  <span>You pay</span>
                  <span style={{ fontFamily: 'DM Mono, monospace' }}>{promo.isFree ? 'FREE' : `$${(promo.finalCents / 100).toFixed(2)}`}</span>
                </div>
              </div>
            )}
          </div>

          {/* Action: claim for $0 (100%-off) or pay the (discounted) amount. */}
          {promo?.isFree ? (
            <button
              className="btn-primary"
              disabled={promoBusy}
              style={{ padding: '12px 28px' }}
              onClick={() => void claimFree()}
            >
              {promoBusy ? 'Claiming…' : 'Claim for $0 & activate →'}
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={!selectedPlan || loading}
              style={{ padding: '12px 28px' }}
              onClick={() => void initiatePayment()}
            >
              {loading
                ? 'Generating QR...'
                : promo
                  ? `Pay $${(promo.finalCents / 100).toFixed(2)} with ABA KHQR`
                  : 'Pay with ABA KHQR'}
            </button>
          )}
        </div>
      )}

      {/* Payment history */}
      {history.length > 0 && (
        <div style={{ marginTop: '3rem' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Payment History</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>{p.id}</td>
                  <td>{p.planCode ?? '—'}</td>
                  <td style={{ fontFamily: 'DM Mono, monospace' }}>${(p.amountCents / 100).toFixed(2)} {p.currency}</td>
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
        </div>
      )}
    </main>
  )
}
