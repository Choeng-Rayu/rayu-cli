// Pay-as-you-go credit top-up client for the CLI.
//
// PRICING IS NEVER COMPUTED HERE. Every price the user sees comes from a quote
// response: the gateway's GET /v1/credits/topup/quote (preferred — the CLI
// already holds a gateway connection for AI calls, so this needs no second
// service round trip) with the backend's GET /api/payments/topup/quote as the
// fallback. The rate lives in the admin's AppSettings, so it can change at any
// time; there is deliberately no default, no constant, and no cached rate in
// this file. `enabled: false` means the admin has switched top-up off.
//
// The BACKEND is authoritative on price at purchase time — it re-reads the rate
// with no cache when creating the payment — so the create response's amountCents
// is what the user actually pays and is what the UI must display once a purchase
// exists. The gateway quote can be up to RAYU_CONFIG_REFRESH (default 30s) stale.
//
// Nothing here throws: a signed-out user or an unreachable server yields null so
// the command can render a clear message instead of a stack trace.
import {
  getRayuApiBaseUrl,
  getRayuGatewayBaseUrl,
  getValidRayuAccessToken,
} from './rayuSession.js'

/** Rails a top-up can be paid on, as accepted by POST /api/payments/topup. */
export type TopupMethod = 'aba' | 'bakong' | 'stripe'

/** Live quote — the shape both the gateway and the backend return. */
export interface TopupQuote {
  /** False when the admin has not enabled top-up (rate 0): hide the flow. */
  enabled: boolean
  /** The credit amount this quote prices. */
  credits: number
  /** What those credits cost, in cents. */
  amountCents: number
  currency: string
  /** Cheapest payable purchase at the current rate — clamp user input to this. */
  minCredits: number
  /** Largest purchase the server will accept. */
  maxCredits: number
  /** The live rate the server used. Displayed, never assumed. */
  rateCreditsPerDollar: number
  /** The live dollar floor the server used, in cents. */
  minTopupCents: number
  /** False when the requested amount was raised to minCredits. */
  meetsMinimum: boolean
  /** Whether the user's PLAN can spend top-up credits (gateway only). */
  topUpEnabled?: boolean
}

/** A created (pending) top-up purchase on the KHQR or Stripe rails. */
export interface TopupPurchase {
  paymentId: number
  credits: number
  amountCents: number
  currency: string
  method: TopupMethod
  /**
   * KHQR payload to render as a QR code. Present only for the KHQR rails
   * (aba / bakong); absent for the Stripe rail, which produces a hosted
   * Checkout URL instead.
   */
  qr?: string
  /** KHQR md5 checksum. Present only for the KHQR rails. */
  md5?: string
  /**
   * Hosted Stripe Checkout URL. Present only for the Stripe rail; absent for
   * the KHQR rails. The CLI opens this in the user's browser and prints it as
   * a fallback for headless / SSH sessions.
   */
  checkoutUrl?: string
  expiresAt: string | null
  /** True when an equivalent pending purchase was reused instead of a new one minted. */
  reused: boolean
}

/** Poll result for a pending purchase. */
export interface TopupPaymentStatus {
  paymentId: number
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'refunded'
  activated: boolean
  kind?: 'topup'
  credits?: number
  expiresAt?: string | null
}

/** An error the server explained (e.g. below the minimum, rail unavailable). */
export interface TopupError {
  status: number
  message: string
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getValidRayuAccessToken()
  if (!token) return null
  return { Authorization: `Bearer ${token}` }
}

/** Pull the server's explanation out of a Nest error body, else a generic one. */
async function readError(res: Response): Promise<TopupError> {
  let message = `Request failed (${res.status})`
  try {
    const body = (await res.json()) as { message?: string | string[] }
    if (Array.isArray(body.message) && body.message.length > 0) {
      message = body.message.join('; ')
    } else if (typeof body.message === 'string' && body.message) {
      message = body.message
    }
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return { status: res.status, message }
}

/**
 * Fetch a live price quote. Tries the gateway first (no backend round trip, per
 * the app_settings design note) and falls back to the backend when the gateway
 * is unreachable or predates the endpoint. Returns null when signed out or when
 * neither service can be reached — the caller shows "couldn't load pricing"
 * rather than inventing a price.
 */
export async function fetchTopupQuote(
  credits?: number,
): Promise<TopupQuote | null> {
  const headers = await authHeaders()
  if (!headers) return null
  const qs =
    credits != null && Number.isFinite(credits) && credits > 0
      ? `?credits=${Math.trunc(credits)}`
      : ''
  const urls = [
    `${getRayuGatewayBaseUrl()}/v1/credits/topup/quote${qs}`,
    `${getRayuApiBaseUrl()}/payments/topup/quote${qs}`,
  ]
  for (const url of urls) {
    try {
      const res = await (globalThis.fetch as typeof fetch)(url, { headers })
      if (!res.ok) continue
      return (await res.json()) as TopupQuote
    } catch {
      // Try the next source.
    }
  }
  return null
}

/**
 * Create a pending top-up on the chosen rail. Returns the purchase, or a
 * TopupError carrying the server's own explanation (below the minimum, top-up
 * disabled, card rail unavailable) so the UI never has to guess the reason.
 */
export async function createTopupPurchase(
  credits: number,
  method: TopupMethod,
): Promise<TopupPurchase | TopupError | null> {
  const headers = await authHeaders()
  if (!headers) return null
  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/payments/topup`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits, method }),
      },
    )
    if (!res.ok) return await readError(res)
    return (await res.json()) as TopupPurchase
  } catch {
    return null
  }
}

/** Poll a purchase. Null on a transient failure so polling can simply retry. */
export async function fetchTopupPaymentStatus(
  paymentId: number,
): Promise<TopupPaymentStatus | null> {
  const headers = await authHeaders()
  if (!headers) return null
  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/payments/${paymentId}/status`,
      { headers },
    )
    if (!res.ok) return null
    return (await res.json()) as TopupPaymentStatus
  } catch {
    return null
  }
}

/** Abandon a pending purchase so it is not reused on the next attempt. */
export async function cancelTopupPurchase(paymentId: number): Promise<boolean> {
  const headers = await authHeaders()
  if (!headers) return false
  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/payments/${paymentId}/cancel`,
      { method: 'POST', headers },
    )
    return res.ok
  } catch {
    return false
  }
}

/** True when a create call came back as an explained server error. */
export function isTopupError(
  v: TopupPurchase | TopupError | null,
): v is TopupError {
  return v != null && 'status' in v && typeof (v as TopupError).status === 'number'
}

// --- Pure display/clamp helpers (unit-tested without a server) --------------

/** Cents as a dollar string, e.g. 500 -> "$5.00". */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Clamp a user-entered credit amount into what the server will accept, using the
 * bounds from the QUOTE (never local constants). A non-numeric or below-floor
 * entry becomes minCredits, so the UI can only ever submit a payable amount.
 */
export function clampTopupCredits(
  requested: number | string,
  quote: Pick<TopupQuote, 'minCredits' | 'maxCredits'>,
): number {
  const n =
    typeof requested === 'number' ? requested : Number.parseInt(requested.trim(), 10)
  if (!Number.isFinite(n)) return quote.minCredits
  const whole = Math.trunc(n)
  if (whole < quote.minCredits) return quote.minCredits
  if (whole > quote.maxCredits) return quote.maxCredits
  return whole
}

/**
 * Price a credit amount for PREVIEW using the quote's own rate, so the picker can
 * label options without a request per keystroke. Mirrors the server's round-up so
 * the preview never undercuts the real charge; the authoritative number is still
 * the one the create response returns.
 */
export function previewAmountCents(credits: number, quote: TopupQuote): number {
  if (!quote.enabled || quote.rateCreditsPerDollar <= 0) return 0
  return Math.ceil((credits / quote.rateCreditsPerDollar) * 100)
}

/**
 * Suggested purchase amounts, derived entirely from the live quote: the minimum
 * and small multiples of it. Deliberately NOT a hardcoded "$5 / $10 / $20" list —
 * those would be wrong the moment the admin changed the rate or the floor.
 */
export function suggestedTopupAmounts(quote: TopupQuote): number[] {
  if (!quote.enabled || quote.minCredits <= 0) return []
  const out: number[] = []
  for (const multiple of [1, 2, 5, 10, 20]) {
    const credits = quote.minCredits * multiple
    if (credits <= quote.maxCredits && !out.includes(credits)) out.push(credits)
  }
  return out
}

/**
 * The rate line shown above the picker, phrased in the units the admin set:
 * "$1.00 = 1,000 credits · minimum $1.00 (1,000 credits)".
 */
export function formatTopupRate(quote: TopupQuote): string {
  if (!quote.enabled) return 'Credit top-up is not enabled on this server.'
  return (
    `$1.00 = ${quote.rateCreditsPerDollar.toLocaleString()} credits · ` +
    `minimum ${formatUsd(quote.minTopupCents)} (${quote.minCredits.toLocaleString()} credits)`
  )
}
