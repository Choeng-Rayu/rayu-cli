'use client'

import { useEffect, useState } from 'react'
import { apiUrl } from './config'

/**
 * Shared Stripe Checkout helpers for the three pay-by-card surfaces
 * (billing, dashboard top-up, team dashboard). Keeps the redirect + return-
 * poll contract in ONE place so the three pages do not each re-implement it.
 *
 * FLOW
 *  1. payWithCard POSTs to a payments endpoint with `method: 'stripe'`. The
 *     backend mints a hosted Checkout Session and returns `{ checkoutUrl,
 *     paymentId }`.
 *  2. The paymentId is stashed in sessionStorage and the browser is redirected
 *     to the hosted Checkout page.
 *  3. Stripe returns the buyer to STRIPE_SUCCESS_URL (a deployment-wide env).
 *     That URL SHOULD land back on this site; on mount, useStripeReturnPoll
 *     checks sessionStorage for a stashed paymentId and polls its status until
 *     paid / expired / canceled, then clears the stash.
 *
 * A redirect is NOT proof of payment — the buyer can close the hosted page
 * before the charge lands, or the success URL can fire before the webhook
 * settles. Polling the status endpoint (which itself polls Bakong / waits for
 * the Stripe webhook to flip the row) is what confirms the grant.
 */

const PENDING_KEY = 'rayu_stripe_pending_payment'

interface StripeCreateResponse {
  paymentId: number
  checkoutUrl?: string
  // The KHQR fields are absent for stripe; included only so the type matches the
  // discriminated union the backend returns without forcing a narrow cast here.
  method?: string
}

/** Create a Stripe Checkout session and redirect the browser to it. */
export async function payWithCard(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): Promise<void> {
  const res = await fetch(apiUrl(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, method: 'stripe' }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(err.message ?? `Error ${res.status}`)
  }
  const data = (await res.json()) as StripeCreateResponse
  if (!data.checkoutUrl) {
    throw new Error('The server did not return a Checkout URL.')
  }
  // Stash the paymentId so useStripeReturnPoll can resume polling on return.
  try {
    sessionStorage.setItem(PENDING_KEY, String(data.paymentId))
  } catch {
    // sessionStorage may be unavailable (private mode); the redirect still
    // works, the return-poll just cannot resume — the user can refresh the
    // dashboard to see the paid state once the webhook lands.
  }
  window.location.href = data.checkoutUrl
}

/**
 * On mount, if a Stripe Checkout was in flight (we redirected away and came
 * back), poll its payment status until resolved. Returns the polling state so
 * the page can render a "Confirming your card payment…" panel.
 */
export function useStripeReturnPoll(
  token: string | null,
  pollIntervalMs = 3000,
): {
  pendingPaymentId: number | null
  status: 'pending' | 'paid' | 'expired' | 'canceled' | null
} {
  const [pendingPaymentId, setPendingPaymentId] = useState<number | null>(null)
  const [status, setStatus] = useState<
    'pending' | 'paid' | 'expired' | 'canceled' | null
  >(null)

  useEffect(() => {
    if (!token) return
    let stored: string | null = null
    try {
      stored = sessionStorage.getItem(PENDING_KEY)
    } catch {
      stored = null
    }
    if (!stored) return
    const paymentId = Number.parseInt(stored, 10)
    if (!Number.isFinite(paymentId) || paymentId <= 0) return
    setPendingPaymentId(paymentId)
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(apiUrl(`/payments/${paymentId}/status`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = (await res.json()) as { status: string; activated: boolean }
        if (!alive) return
        if (data.status === 'paid') {
          setStatus('paid')
          clearPending()
          return
        }
        if (data.status === 'expired' || data.status === 'canceled') {
          setStatus(data.status as 'expired' | 'canceled')
          clearPending()
          return
        }
        setStatus('pending')
      } catch {
        // Transient — keep polling.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), pollIntervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return { pendingPaymentId, status }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // ignore
  }
}

/**
 * Fetch the card-rail availability once. Used to hide the "Pay with card"
 * button on deployments where STRIPE_ENABLED is off. Returns null while
 * loading and false on a fetch failure (fail closed: a button that 501s is
 * worse than a missing button).
 */
export function useStripeEnabled(token: string | null): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    if (!token) return
    let alive = true
    void (async () => {
      try {
        const res = await fetch(apiUrl('/payments/stripe/enabled'), {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!alive || !res.ok) return
        const data = (await res.json()) as { enabled: boolean }
        if (alive) setEnabled(data.enabled)
      } catch {
        if (alive) setEnabled(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [token])
  return enabled
}