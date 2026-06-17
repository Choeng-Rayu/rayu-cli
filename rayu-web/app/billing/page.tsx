'use client'
export const dynamic = 'force-dynamic'

import { useAuth } from '@clerk/nextjs'
import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { apiUrl } from '../../lib/config'
import { Plan, sortPlans } from '../../lib/plans'

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

function useRayuToken() {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [authError, setAuthError] = useState('')

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
        setToken(data.accessToken)
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [isLoaded, isSignedIn, getToken])

  return { token, authError, isLoaded, isSignedIn }
}

export default function BillingPage() {
  const { token, authError, isLoaded, isSignedIn } = useRayuToken()
  const [plans, setPlans] = useState<Plan[]>([])
  const [selectedPlan, setSelectedPlan] = useState<PaidPlanCode | ''>('')
  const [khqr, setKhqr] = useState<KhqrResponse | null>(null)
  const [pollStatus, setPollStatus] = useState<PaymentStatus | null>(null)
  const [history, setHistory] = useState<PaymentHistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
        setPlans(sortPlans(data).filter((p) => p.availability === 'active' && p.priceCents > 0))
      }
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { items: PaymentHistoryItem[] }
        setHistory(data.items)
      }
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
        body: JSON.stringify({ planCode: selectedPlan }),
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

  function retry() {
    setKhqr(null)
    setPollStatus(null)
    stopPolling()
  }

  if (isLoaded && !isSignedIn) {
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
        <div className="card" style={{ marginBottom: '2rem', textAlign: 'center', padding: '2rem' }}>
          <p style={{ opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Scan to pay — {khqr.planCode} — ${(khqr.amountCents / 100).toFixed(2)} {khqr.currency}
          </p>
          <div style={{ display: 'inline-block', padding: '1.5rem', background: '#fff', borderRadius: '12px', marginBottom: '1.5rem' }}>
            <QRCodeSVG value={khqr.qr} size={220} />
          </div>
          <p style={{ opacity: 0.4, fontSize: '0.85rem', marginBottom: '1rem' }}>Waiting for payment confirmation...</p>
          <button className="btn-ghost" style={{ padding: '8px 20px', fontSize: '0.85rem' }} onClick={retry}>Cancel</button>
        </div>
      )}

      {/* QR state with pending poll */}
      {khqr && pollStatus?.status === 'pending' && (
        <div className="card" style={{ marginBottom: '2rem', textAlign: 'center', padding: '2rem' }}>
          <p style={{ opacity: 0.5, fontSize: '0.8rem', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Scan to pay — {khqr.planCode} — ${(khqr.amountCents / 100).toFixed(2)} {khqr.currency}
          </p>
          <div style={{ display: 'inline-block', padding: '1.5rem', background: '#fff', borderRadius: '12px', marginBottom: '1.5rem' }}>
            <QRCodeSVG value={khqr.qr} size={220} />
          </div>
          <p style={{ opacity: 0.4, fontSize: '0.85rem', marginBottom: '1rem' }}>Waiting for payment confirmation...</p>
          <button className="btn-ghost" style={{ padding: '8px 20px', fontSize: '0.85rem' }} onClick={retry}>Cancel</button>
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
                onClick={() => setSelectedPlan(p.code as PaidPlanCode)}
              >
                <span style={{ fontWeight: 700 }}>{p.name}</span>
                <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>${(p.priceCents / 100).toFixed(0)}/mo</span>
              </button>
            ))}
          </div>
          <button
            className="btn-primary"
            disabled={!selectedPlan || loading}
            style={{ padding: '12px 28px' }}
            onClick={() => void initiatePayment()}
          >
            {loading ? 'Generating QR...' : 'Pay with Bakong KHQR'}
          </button>
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
