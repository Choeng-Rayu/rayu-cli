'use client'
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import KhqrCard from '../../../../components/KhqrCard'
import { apiUrl } from '../../../../lib/config'
import {
  allocatedCredits,
  allowanceSplit,
  billingStatusLabel,
  bucketUsedPct,
  creditExpiryLabel,
  equalSplit,
  isOverAllocated,
  isTeamBillable,
  joinLinkLabel,
  poolUsedPct,
  purchaseWarning,
  teamAllowance,
  type TeamDetail,
  type TeamTopupCheckout,
  type TeamTopupQuote,
} from '../../../../lib/team'
import { useRayuToken } from '../../../../lib/useRayuToken'
import { payWithCard, useStripeEnabled, useStripeReturnPoll } from '../../../../lib/stripeCheckout'

interface PlanRow {
  code: string
  name: string
  priceCents: number
  availability: string
  isTeamPlan?: boolean
  limits: { creditsPerPeriod?: number | null } | null
}

interface TeamKhqr {
  paymentId: number
  amountCents: number
  currency: string
  qr: string
  md5: string
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function memberLabel(m: TeamDetail['members'][number]): string {
  return m.displayName || m.email || `User ${m.userId}`
}

/**
 * Team detail: roster, invites, per-member quotas, the shared credit pool, and
 * team checkout.
 *
 * Every mutating action is admin-only server-side (OrgAdminGuard checks the
 * database, not the JWT claim), so this page hides those controls for a plain
 * member purely as UX — it is not the security boundary.
 */
export default function TeamDetailPage() {
  const routeParams = useParams<{ slug: string }>()
  const slug = routeParams.slug
  const { token, authError, status } = useRayuToken()
  const [team, setTeam] = useState<TeamDetail | null>(null)
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteUrl, setInviteUrl] = useState('')
  // Which way the admin is inviting right now. Email is first because it is the
  // stricter of the two (the link produces requests someone has to review).
  const [inviteMode, setInviteMode] = useState<'email' | 'link'>('email')
  const [linkCopied, setLinkCopied] = useState(false)
  const [quotaDraft, setQuotaDraft] = useState<Record<number, string>>({})
  const [khqr, setKhqr] = useState<TeamKhqr | null>(null)
  // Card rail availability + return-poll for a Stripe Checkout in flight.
  const stripeEnabled = useStripeEnabled(status === 'authenticated' ? token : null)
  const stripeReturn = useStripeReturnPoll(status === 'authenticated' ? token : null)
  // Buying credits: the amount the admin typed, the live quote for it, and who it
  // is for ('' = the shared pool).
  const [creditAmount, setCreditAmount] = useState('')
  const [creditTarget, setCreditTarget] = useState('')
  const [quote, setQuote] = useState<TeamTopupQuote | null>(null)
  const [creditKhqr, setCreditKhqr] = useState<TeamTopupCheckout | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const authHeaders = useCallback(
    (json = false): HeadersInit => ({
      Authorization: `Bearer ${token ?? ''}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }),
    [token],
  )

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [teamRes, plansRes] = await Promise.all([
        fetch(apiUrl(`/organizations/${slug}`), { headers: authHeaders() }),
        fetch(apiUrl('/plans')),
      ])
      if (!teamRes.ok) {
        setError(
          teamRes.status === 403
            ? 'You are not a member of this team.'
            : teamRes.status === 404
              ? 'Team not found.'
              : `Could not load the team (${teamRes.status})`,
        )
        return
      }
      setError('')
      setTeam((await teamRes.json()) as TeamDetail)
      if (plansRes.ok) setPlans((await plansRes.json()) as PlanRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [token, slug, authHeaders])

  useEffect(() => {
    void load()
  }, [load])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])
  useEffect(() => () => stopPolling(), [stopPolling])

  /**
   * Price the purchase from the SERVER on every change, debounced.
   *
   * The rate, the minimum and the expiry all live in the admin's settings and in
   * the team's period — so the page never computes a price itself. It asks, and
   * shows exactly what the purchase will cost and when the credits lapse.
   */
  const isAdminViewer = team?.viewer.role === 'admin'
  useEffect(() => {
    if (!token || !isAdminViewer) return
    const credits = Number(creditAmount)
    const query = Number.isFinite(credits) && credits > 0 ? `?credits=${Math.trunc(credits)}` : ''
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(apiUrl(`/payments/team/${slug}/topup/quote${query}`), {
            headers: authHeaders(),
          })
          if (!res.ok) {
            setQuote(null)
            return
          }
          setQuote((await res.json()) as TeamTopupQuote)
        } catch {
          // A failed quote must not break the page; the card just stays quiet
          // rather than showing a price nobody confirmed.
          setQuote(null)
        }
      })()
    }, 350)
    return () => clearTimeout(timer)
  }, [token, isAdminViewer, slug, creditAmount, authHeaders])

  /** Buy credits: same KHQR + polling flow as the team plan purchase. */
  async function buyCredits() {
    if (!token || !quote?.enabled) return
    setError('')
    setNotice('')
    stopPolling()
    const credits = Math.trunc(Number(creditAmount) || quote.credits)
    try {
      const res = await fetch(apiUrl(`/payments/team/${slug}/topup`), {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          credits,
          ...(creditTarget ? { targetUserId: Number(creditTarget) } : {}),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const msg = data.message
        setError(
          (Array.isArray(msg) ? msg.join(', ') : (msg as string)) ??
            `Could not start the purchase (${res.status})`,
        )
        return
      }
      const checkout = data as unknown as TeamTopupCheckout
      setCreditKhqr(checkout)
      pollRef.current = setInterval(() => {
        void (async () => {
          const sres = await fetch(apiUrl(`/payments/${checkout.paymentId}/status`), {
            headers: authHeaders(),
          })
          if (!sres.ok) return
          const s = (await sres.json()) as { status: string }
          if (s.status === 'paid') {
            stopPolling()
            setCreditKhqr(null)
            setCreditAmount('')
            setNotice(
              `Payment confirmed — ${checkout.credits.toLocaleString()} credits added to the team.`,
            )
            await load()
          } else if (s.status === 'expired' || s.status === 'canceled') {
            stopPolling()
            setCreditKhqr(null)
            setError('That QR expired before it was paid. Start the purchase again.')
          }
        })()
      }, 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function act(
    path: string,
    init: RequestInit,
    okMessage: string,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch(apiUrl(path), {
        ...init,
        headers: authHeaders(init.body != null),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const msg = data.message
        setError(
          (Array.isArray(msg) ? msg.join(', ') : (msg as string)) ??
            `Request failed (${res.status})`,
        )
        return null
      }
      setNotice(okMessage)
      await load()
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function invite() {
    const data = await act(
      `/organizations/${slug}/invite`,
      { method: 'POST', body: JSON.stringify({ email: inviteEmail.trim() }) },
      `Invite created for ${inviteEmail.trim()}`,
    )
    if (data?.acceptUrl) {
      // No mailer is wired into the backend yet, so the admin copies the link.
      setInviteUrl(String(data.acceptUrl))
      setInviteEmail('')
    }
  }

  /**
   * Create or regenerate the shareable join link. Regenerating is deliberately
   * the same call: replacing the token is the only way to stop a link that has
   * already been shared, so the button says so rather than hiding it.
   */
  async function createJoinLink() {
    setLinkCopied(false)
    await act(
      `/organizations/${slug}/join-link`,
      { method: 'POST', body: JSON.stringify({}) },
      team?.joinLink
        ? 'New join link created — the previous one no longer works'
        : 'Join link created — anyone who opens it can ask to join',
    )
  }

  async function copyJoinLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2500)
    } catch {
      // Clipboard access can be denied (insecure origin, permission); the URL is
      // on screen and selectable, so this is not worth an error banner.
      setLinkCopied(false)
    }
  }

  async function buyTeamPlan(planCode: string) {
    if (!token) return
    setError('')
    setNotice('')
    stopPolling()
    try {
      const res = await fetch(apiUrl('/payments/team-khqr'), {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ slug, planCode }),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const msg = data.message
        setError((Array.isArray(msg) ? msg.join(', ') : (msg as string)) ?? `Checkout failed (${res.status})`)
        return
      }
      const payment = data as unknown as TeamKhqr
      setKhqr(payment)
      pollRef.current = setInterval(() => {
        void (async () => {
          const sres = await fetch(apiUrl(`/payments/${payment.paymentId}/status`), {
            headers: authHeaders(),
          })
          if (!sres.ok) return
          const s = (await sres.json()) as { status: string }
          if (s.status === 'paid') {
            stopPolling()
            setKhqr(null)
            setNotice('Payment confirmed — the team credit pool has been funded.')
            await load()
          } else if (s.status === 'expired' || s.status === 'canceled') {
            stopPolling()
            setKhqr(null)
            setError('That QR expired before it was paid. Start the purchase again.')
          }
        })()
      }, 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Card rail: POST /payments/team/:slug/topup with method:'stripe' and
  // redirect to the hosted Checkout page. useStripeReturnPoll resumes polling
  // on return — a redirect is not proof of payment.
  async function buyCreditsCard() {
    if (!token || !quote?.enabled) return
    setError(''); setNotice(''); stopPolling()
    const credits = Math.trunc(Number(creditAmount) || quote.credits)
    try {
      await payWithCard(
        `/payments/team/${slug}/topup`,
        { credits, ...(creditTarget ? { targetUserId: Number(creditTarget) } : {}) },
        token,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Card rail for team plan checkout: POST /payments/team-khqr with
  // method:'stripe' and redirect to the hosted Checkout page.
  async function buyTeamPlanCard(planCode: string) {
    if (!token) return
    setError(''); setNotice(''); stopPolling()
    try {
      await payWithCard('/payments/team-khqr', { slug, planCode }, token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // When a Stripe Checkout completes (return-poll flips to paid), reload so the
  // team's pool / subscription reflects the grant. Runs once per paid flip.
  useEffect(() => {
    if (stripeReturn.status === 'paid') void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripeReturn.status])

  if (status === 'unauthenticated') {
    return (
      <main className="container">
        <span className="section-eyebrow">TEAM</span>
        <h1 style={{ marginTop: '0.5rem' }}>Team</h1>
        <p style={{ opacity: 0.6 }}>Please sign in to view this team.</p>
      </main>
    )
  }

  const isAdmin = team?.viewer.role === 'admin'
  const pool = team?.creditPool ?? null
  const split = allowanceSplit(pool)
  const activeMembers = (team?.members ?? []).filter((m) => m.status === 'active')
  const teamPlans = plans.filter(
    (p) => p.isTeamPlan && p.availability === 'active' && p.priceCents > 0,
  )
  const pct = poolUsedPct(pool)

  return (
    <main className="container">
      <div style={{ marginBottom: '1.25rem' }}>
        <Link href="/dashboard/team" style={{ fontSize: '0.8rem', opacity: 0.6 }}>
          ← All teams
        </Link>
        <h1 style={{ marginTop: '0.6rem', marginBottom: '0.3rem' }}>{team?.name ?? slug}</h1>
        <p style={{ opacity: 0.55, margin: 0, fontSize: '0.85rem' }}>
          /{slug}
          {team?.ssoDomain ? ` · auto-join ${team.ssoDomain}` : ' · invite only'}
          {team ? ` · ${billingStatusLabel(team)}` : ''}
        </p>
      </div>

      {(error || authError) && (
        <div className="card" style={{ borderColor: 'var(--red)', background: 'rgba(255,51,102,0.05)', marginBottom: '1.25rem' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error || authError}</p>
        </div>
      )}
      {notice && (
        <div className="card" style={{ borderColor: 'var(--green)', background: 'var(--green-glow)', marginBottom: '1.25rem' }}>
          <p style={{ color: 'var(--green)', margin: 0 }}>{notice}</p>
        </div>
      )}

      {!team ? (
        <p style={{ opacity: 0.5 }}>Loading…</p>
      ) : (
        <>
          {/* CREDIT POOL */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>Shared credit pool</span>
              <span style={{ fontSize: '0.78rem', opacity: 0.5 }}>
                {team.plan ? `${team.plan.name} · ${usd(team.plan.priceCents)}/mo` : 'no plan yet'}
              </span>
            </div>
            <div style={{ marginTop: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'DM Mono, monospace', fontSize: '0.85rem', marginBottom: 4 }}>
                <span>
                  {(pool?.usedCredits ?? 0).toLocaleString()} / {teamAllowance(pool).toLocaleString()} credits used
                </span>
                <span style={{ opacity: 0.6 }}>{pct.toFixed(0)}%</span>
              </div>
              <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: pct >= 90 ? 'var(--red)' : pct >= 75 ? '#f5a623' : 'var(--green)',
                    transition: 'width .3s ease',
                  }}
                />
              </div>
              <div style={{ fontSize: '0.78rem', opacity: 0.55, marginTop: 8 }}>
                {split.total.toLocaleString()} credits left for the whole team
                {pool?.periodEnd ? ` · renews ${new Date(pool.periodEnd).toLocaleDateString()}` : ''}
                {' · '}
                {allocatedCredits(team.members).toLocaleString()} allocated across {activeMembers.length}{' '}
                member{activeMembers.length === 1 ? '' : 's'}
              </div>
              {/* The two tiers are named separately because they behave
                  differently: the plan's allowance renews, purchased credits do
                  not — they expire with this period. */}
              {(pool?.extraCredits ?? 0) > 0 && (
                <div style={{ fontSize: '0.78rem', opacity: 0.7, marginTop: 6 }}>
                  {split.plan.toLocaleString()} from the {team.plan?.name ?? 'team'} plan ·{' '}
                  <strong>{split.purchased.toLocaleString()} purchased</strong>
                  {pool?.periodEnd
                    ? ` (${creditExpiryLabel(pool.periodEnd, null)}, not carried over)`
                    : ''}
                </div>
              )}
              {isOverAllocated(team.members, pool) && (
                <div style={{ fontSize: '0.78rem', color: '#f5a623', marginTop: 6 }}>
                  Member quotas add up to more than the pool holds. That is allowed — the pool is the
                  real limit — but the last people to spend may find it empty.
                </div>
              )}
              {!isTeamBillable(team) && (
                <div style={{ fontSize: '0.8rem', color: 'var(--red)', marginTop: 8 }}>
                  {billingStatusLabel(team)}
                </div>
              )}
            </div>
          </div>

          {/* CHECKOUT (admin only) */}
          {isAdmin && (
            <div className="card" style={{ marginBottom: '1.25rem' }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>
                {team.subscription ? 'Renew or change the team plan' : 'Buy a team plan'}
              </span>
              {khqr ? (
                <div style={{ marginTop: '1rem' }}>
                  <KhqrCard
                    merchant="CHOENG RAYU"
                    amount={(khqr.amountCents / 100).toFixed(2)}
                    currency={khqr.currency}
                    qrValue={khqr.qr}
                    status="pending"
                    onCancel={() => {
                      stopPolling()
                      setKhqr(null)
                    }}
                  />
                  <p style={{ textAlign: 'center', opacity: 0.55, fontSize: '0.78rem' }}>
                    Waiting for payment… the pool is funded automatically once it lands.
                  </p>
                </div>
              ) : teamPlans.length === 0 ? (
                <p style={{ opacity: 0.55, fontSize: '0.85rem', marginBottom: 0 }}>
                  No team plans are on sale right now. Ask support to enable one for your account.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.9rem' }}>
                  {teamPlans.map((p) => (
                    <div
                      key={p.code}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.6rem 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div style={{ opacity: 0.5, fontSize: '0.78rem' }}>
                          {(p.limits?.creditsPerPeriod ?? 0).toLocaleString()} credits per month, shared by
                          every member
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <button
                          className="btn-primary"
                          style={{ padding: '8px 18px', whiteSpace: 'nowrap' }}
                          disabled={busy}
                          onClick={() => void buyTeamPlan(p.code)}
                        >
                          {usd(p.priceCents)}/mo · KHQR
                        </button>
                        {stripeEnabled && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '8px 18px', whiteSpace: 'nowrap' }}
                            disabled={busy}
                            onClick={() => void buyTeamPlanCard(p.code)}
                          >
                            {usd(p.priceCents)}/mo · card
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stripe Checkout return — confirming a card payment that just
              redirected away and back. A redirect is not proof of payment. */}
          {stripeReturn.pendingPaymentId != null && stripeReturn.status !== 'paid' && (
            <div className="card" style={{ marginBottom: '1.25rem', textAlign: 'center', padding: '1.25rem' }}>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>
                {stripeReturn.status === 'expired' || stripeReturn.status === 'canceled'
                  ? 'Card payment was not completed.'
                  : 'Confirming your card payment…'}
              </p>
              <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>
                {stripeReturn.status === 'expired' || stripeReturn.status === 'canceled'
                  ? 'The checkout expired or was canceled. Start the purchase again.'
                  : 'Waiting for Stripe to confirm the charge — this usually takes a few seconds.'}
              </p>
            </div>
          )}

          {/* BUY CREDITS (admin only) — pay-as-you-go on top of the plan */}
          {isAdmin && (
            <div className="card" style={{ marginBottom: '1.25rem' }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>
                Buy credits
              </span>
              <p style={{ opacity: 0.55, fontSize: '0.82rem', marginTop: 6 }}>
                Top up the shared pool without changing the plan. Credits go in immediately once
                paid, are spent only after the plan&apos;s monthly allowance runs out, and last until
                the current period ends.
              </p>

              {creditKhqr ? (
                <div style={{ marginTop: '1rem' }}>
                  <KhqrCard
                    merchant="CHOENG RAYU"
                    amount={(creditKhqr.amountCents / 100).toFixed(2)}
                    currency={creditKhqr.currency}
                    qrValue={creditKhqr.qr}
                    status="pending"
                    onCancel={() => {
                      stopPolling()
                      setCreditKhqr(null)
                    }}
                  />
                  <p style={{ textAlign: 'center', opacity: 0.55, fontSize: '0.78rem' }}>
                    Waiting for payment… {creditKhqr.credits.toLocaleString()} credits are added
                    automatically once it lands.
                  </p>
                </div>
              ) : quote && !quote.enabled ? (
                // Every blocked case has its own actionable sentence from the
                // backend (no plan, lapsed period, top-up disabled, rate unset), so
                // the admin is never left guessing which knob to turn.
                <p style={{ opacity: 0.7, fontSize: '0.85rem', marginBottom: 0 }}>
                  {quote.message ?? 'Credit purchases are not available for this team right now.'}
                </p>
              ) : (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.6rem',
                      flexWrap: 'wrap',
                      alignItems: 'flex-end',
                      marginTop: '0.9rem',
                    }}
                  >
                    <label style={{ fontSize: '0.78rem', opacity: 0.6 }}>
                      Credits
                      <input
                        className="admin-input"
                        style={{ display: 'block', width: 160, marginTop: 4 }}
                        type="number"
                        min={quote?.minCredits ?? 1}
                        step={1}
                        placeholder={String(quote?.minCredits ?? 100)}
                        value={creditAmount}
                        onChange={(e) => setCreditAmount(e.target.value)}
                      />
                    </label>
                    <label style={{ fontSize: '0.78rem', opacity: 0.6 }}>
                      For
                      <select
                        className="admin-input"
                        style={{ display: 'block', minWidth: 200, marginTop: 4 }}
                        value={creditTarget}
                        onChange={(e) => setCreditTarget(e.target.value)}
                      >
                        <option value="">The whole team (shared pool)</option>
                        {activeMembers.map((m) => (
                          <option key={m.userId} value={String(m.userId)}>
                            {memberLabel(m)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn-primary"
                      style={{ padding: '9px 20px' }}
                      disabled={busy || !quote?.enabled}
                      onClick={() => void buyCredits()}
                    >
                      {quote?.enabled
                        ? `${usd(quote.amountCents)} · Pay with KHQR`
                        : 'Buy credits'}
                    </button>
                    {stripeEnabled && (
                      <button
                        className="btn-ghost"
                        style={{ padding: '9px 20px' }}
                        disabled={busy || !quote?.enabled}
                        onClick={() => void buyCreditsCard()}
                      >
                        {quote?.enabled ? `${usd(quote.amountCents)} · Pay with card` : 'Buy with card'}
                      </button>
                    )}
                  </div>

                  {quote?.enabled && (
                    <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 8 }}>
                      {quote.credits.toLocaleString()} credits ·{' '}
                      {quote.rateCreditsPerDollar.toLocaleString()} credits per $1 · minimum{' '}
                      {quote.minCredits.toLocaleString()}
                      {quote.expiresAt
                        ? ` · ${creditExpiryLabel(quote.expiresAt, quote.daysLeft)}`
                        : ''}
                    </div>
                  )}
                  {!quote?.meetsMinimum && creditAmount !== '' && quote?.enabled && (
                    <div style={{ fontSize: '0.78rem', color: '#f5a623', marginTop: 6 }}>
                      Raised to the {quote.minCredits.toLocaleString()}-credit minimum (
                      {usd(quote.minTopupCents)}).
                    </div>
                  )}
                  {/* Shown BEFORE the pay button does anything: buying two days
                      before renewal buys two days. */}
                  {purchaseWarning(quote) && (
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: '#f5a623',
                        marginTop: 8,
                        borderLeft: '2px solid #f5a623',
                        paddingLeft: 8,
                      }}
                    >
                      {purchaseWarning(quote)}
                    </div>
                  )}
                  {creditTarget && (
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, marginTop: 6 }}>
                      Their personal quota goes up by this amount, and so does the shared pool —
                      the pool is the team&apos;s real limit, so both have to move.
                    </div>
                  )}
                </>
              )}

              {team.creditPurchases.length > 0 && (
                <table style={{ marginTop: '1.25rem' }}>
                  <thead>
                    <tr>
                      <th>Purchase</th>
                      <th>For</th>
                      <th>Paid</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.creditPurchases.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                          {p.credits.toLocaleString()} credits
                          <div style={{ opacity: 0.45, fontSize: '0.72rem' }}>
                            {new Date(p.createdAt).toLocaleDateString()}
                          </div>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>{p.targetName ?? 'Shared pool'}</td>
                        <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                          {usd(p.amountCents)}
                        </td>
                        <td>
                          <span
                            className="badge"
                            style={{
                              color:
                                p.status === 'paid'
                                  ? 'var(--green)'
                                  : p.status === 'pending'
                                    ? '#f5a623'
                                    : 'var(--red)',
                            }}
                          >
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* MEMBERS */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>
                Members ({activeMembers.length})
              </span>
              {isAdmin && pool && pool.totalCredits > 0 && (
                <span style={{ fontSize: '0.75rem', opacity: 0.45 }}>
                  equal split would be {equalSplit(pool, activeMembers.length).toLocaleString()} credits each
                </span>
              )}
            </div>
            <table style={{ marginTop: '0.9rem' }}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Quota</th>
                  <th>Left</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {activeMembers.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{memberLabel(m)}</div>
                      {m.email && <div style={{ opacity: 0.45, fontSize: '0.75rem' }}>{m.email}</div>}
                    </td>
                    <td>
                      <span className="badge">{m.role}</span>
                    </td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>
                      {isAdmin ? (
                        <input
                          className="admin-input"
                          style={{ width: 110 }}
                          type="number"
                          min={0}
                          value={quotaDraft[m.userId] ?? String(m.bucketQuota)}
                          onChange={(e) =>
                            setQuotaDraft((d) => ({ ...d, [m.userId]: e.target.value }))
                          }
                        />
                      ) : (
                        m.bucketQuota.toLocaleString()
                      )}
                    </td>
                    <td style={{ fontFamily: 'DM Mono, monospace' }}>
                      {m.bucketCredits.toLocaleString()}
                      <span style={{ opacity: 0.4, fontSize: '0.72rem' }}>
                        {' '}
                        ({bucketUsedPct(m).toFixed(0)}% used)
                      </span>
                    </td>
                    {isAdmin && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="btn-ghost"
                          style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                          disabled={busy || (quotaDraft[m.userId] ?? String(m.bucketQuota)) === String(m.bucketQuota)}
                          onClick={() =>
                            void act(
                              `/organizations/${slug}/members/${m.userId}/quota`,
                              {
                                method: 'PATCH',
                                body: JSON.stringify({
                                  bucketQuota: Math.max(0, Number(quotaDraft[m.userId] ?? m.bucketQuota)),
                                }),
                              },
                              `Quota updated for ${memberLabel(m)}`,
                            )
                          }
                        >
                          Save
                        </button>
                        {m.userId !== team.adminId && (
                          <button
                            className="btn-ghost"
                            style={{ padding: '4px 10px', fontSize: '0.78rem', color: 'var(--red)' }}
                            disabled={busy}
                            onClick={() =>
                              void act(
                                `/organizations/${slug}/members/${m.userId}`,
                                { method: 'DELETE' },
                                `${memberLabel(m)} removed from the team`,
                              )
                            }
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!isAdmin && team.viewer.userId !== team.adminId && (
              <button
                className="btn-ghost"
                style={{ padding: '6px 14px', fontSize: '0.82rem', marginTop: '1rem' }}
                disabled={busy}
                onClick={() => void act(`/organizations/${slug}/leave`, { method: 'POST' }, 'You left the team')}
              >
                Leave this team
              </button>
            )}
          </div>

          {/* JOIN REQUESTS (admin only) — the approval queue for link joiners */}
          {isAdmin && team.joinRequests.length > 0 && (
            <div
              className="card"
              style={{ marginBottom: '1.25rem', borderColor: 'var(--purple, #7c3aed)' }}
            >
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>
                Requests to join ({team.joinRequests.length})
              </span>
              <p style={{ opacity: 0.55, fontSize: '0.82rem', marginTop: 6 }}>
                These people opened your join link. They are not members and cannot spend a
                single credit until you approve them.
              </p>
              <table style={{ marginTop: '0.9rem' }}>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Asked</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {team.joinRequests.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                          {r.displayName || r.email || `User ${r.userId}`}
                        </div>
                        {r.email && (
                          <div style={{ opacity: 0.45, fontSize: '0.75rem' }}>{r.email}</div>
                        )}
                        {r.message && (
                          <div style={{ opacity: 0.7, fontSize: '0.78rem', marginTop: 4 }}>
                            “{r.message}”
                          </div>
                        )}
                      </td>
                      <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="btn-primary"
                          style={{ padding: '4px 12px', fontSize: '0.78rem' }}
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `/organizations/${slug}/join-requests/${r.id}/approve`,
                              { method: 'POST' },
                              `${r.displayName || r.email || 'They'} joined the team`,
                            )
                          }
                        >
                          Approve
                        </button>
                        <button
                          className="btn-ghost"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.78rem',
                            color: 'var(--red)',
                            marginLeft: 6,
                          }}
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `/organizations/${slug}/join-requests/${r.id}/reject`,
                              { method: 'POST' },
                              'Request rejected',
                            )
                          }
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* INVITES (admin only) */}
          {isAdmin && (
            <div className="card">
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '0.95rem' }}>Invite people</span>
              <p style={{ opacity: 0.55, fontSize: '0.82rem', marginTop: 6 }}>
                {team.ssoDomain
                  ? `Anyone signing in with a ${team.ssoDomain} Google Workspace account joins automatically — invites are only needed for people outside that domain.`
                  : 'Invites are how people join this team.'}
              </p>

              {/* Two ways in, with the difference stated up front: an email invite
                  is a seat waiting for one address; a link is a queue you review. */}
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.9rem' }}>
                {(
                  [
                    ['email', 'By email'],
                    ['link', 'Shareable link'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    className={inviteMode === mode ? 'btn-primary' : 'btn-ghost'}
                    style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                    onClick={() => setInviteMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {inviteMode === 'email' ? (
                <>
                  <p style={{ opacity: 0.5, fontSize: '0.78rem', marginTop: '0.8rem' }}>
                    The link is valid for 7 days and only works for the address it was issued
                    to, so the invitee joins the moment they open it — no approval needed.
                  </p>
                  <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                    <input
                      className="admin-input"
                      style={{ flex: 1, minWidth: 240 }}
                      type="email"
                      placeholder="teammate@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                    <button
                      className="btn-primary"
                      style={{ padding: '9px 20px' }}
                      disabled={busy || !inviteEmail.includes('@')}
                      onClick={() => void invite()}
                    >
                      Send invite
                    </button>
                  </div>
                  {inviteUrl && (
                    <div style={{ marginTop: '0.9rem', fontSize: '0.8rem' }}>
                      <div style={{ opacity: 0.6, marginBottom: 4 }}>
                        Email delivery isn&apos;t configured yet — copy this link to your teammate:
                      </div>
                      <code
                        style={{
                          display: 'block',
                          background: 'var(--bg3)',
                          padding: '8px 10px',
                          borderRadius: 6,
                          wordBreak: 'break-all',
                        }}
                      >
                        {inviteUrl}
                      </code>
                    </div>
                  )}
                  {team.invites.length > 0 && (
                    <table style={{ marginTop: '1rem' }}>
                      <thead>
                        <tr>
                          <th>Pending invite</th>
                          <th>Expires</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {team.invites.map((i) => (
                          <tr key={i.id}>
                            <td>{i.email}</td>
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.8rem' }}>
                              {new Date(i.expiresAt).toLocaleDateString()}
                            </td>
                            <td>
                              <button
                                className="btn-ghost"
                                style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    `/organizations/${slug}/invite/${i.id}`,
                                    { method: 'DELETE' },
                                    `Invite for ${i.email} revoked`,
                                  )
                                }
                              >
                                Revoke
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <>
                  <p style={{ opacity: 0.5, fontSize: '0.78rem', marginTop: '0.8rem' }}>
                    Share this link anywhere — a group chat, a doc, a message. Anyone who opens
                    it can <strong>ask</strong> to join, and you decide: nobody gets a seat, or
                    spends any of the team&apos;s credits, until you approve them.
                  </p>
                  {team.joinLink && team.joinLink.state === 'active' ? (
                    <>
                      <code
                        style={{
                          display: 'block',
                          background: 'var(--bg3)',
                          padding: '8px 10px',
                          borderRadius: 6,
                          wordBreak: 'break-all',
                          fontSize: '0.8rem',
                          marginTop: '0.6rem',
                        }}
                      >
                        {team.joinLink.url}
                      </code>
                      <div style={{ fontSize: '0.75rem', opacity: 0.55, marginTop: 6 }}>
                        {joinLinkLabel(team.joinLink)}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
                        <button
                          className="btn-primary"
                          style={{ padding: '8px 18px', fontSize: '0.82rem' }}
                          onClick={() => void copyJoinLink(team.joinLink!.url)}
                        >
                          {linkCopied ? 'Copied' : 'Copy link'}
                        </button>
                        <button
                          className="btn-ghost"
                          style={{ padding: '8px 16px', fontSize: '0.82rem' }}
                          disabled={busy}
                          onClick={() => void createJoinLink()}
                        >
                          Regenerate
                        </button>
                        <button
                          className="btn-ghost"
                          style={{ padding: '8px 16px', fontSize: '0.82rem', color: 'var(--red)' }}
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `/organizations/${slug}/join-link`,
                              { method: 'DELETE' },
                              'Join link turned off',
                            )
                          }
                        >
                          Turn off
                        </button>
                      </div>
                      <div style={{ fontSize: '0.72rem', opacity: 0.4, marginTop: 8 }}>
                        Regenerating issues a new URL and stops the old one working — that is how
                        you take back a link that spread too far.
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '0.78rem', opacity: 0.55, marginTop: '0.6rem' }}>
                        {joinLinkLabel(team.joinLink)}
                      </div>
                      <button
                        className="btn-primary"
                        style={{ padding: '9px 20px', marginTop: '0.7rem' }}
                        disabled={busy}
                        onClick={() => void createJoinLink()}
                      >
                        Create join link
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </main>
  )
}
