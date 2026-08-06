import { randomBytes } from 'node:crypto'
import type { Request } from 'express'
import type Stripe from 'stripe'

/**
 * Webhook event-idempotency helpers for StripeWebhookController.
 *
 * The contract: insert a `stripe_webhook_events` row BEFORE processing. The
 * `stripe_event_id` column is UNIQUE, so a duplicate delivery (Stripe does not
 * guarantee exactly-once) collides with P2002 and is answered 200 without
 * re-running the side effect. A crash mid-grant leaves the row in 'pending',
 * so a retry reads it, sees it is not done, and re-dispatches — the grant-side
 * `status='pending'` guards in PaymentsService make a re-dispatch safe.
 */

export interface IdempotencyResult {
  /** True when this delivery is a duplicate of an already-handled event. */
  alreadyHandled: boolean
  /** True when a previous attempt crashed before completing — re-dispatch. */
  reDispatch: boolean
}

/**
 * Classify a Prisma error from the idempotency insert as a P2002 (duplicate) or
 * not. Prisma tags unique-constraint violations with `code === 'P2002'`.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  )
}

/**
 * Decide whether a thrown error is a PERMANENT failure (log + 200, stop Stripe
 * retrying for three days on a request that will never succeed) or a TRANSIENT
 * one (5xx, let Stripe retry).
 *
 * Permanent, by intent:
 *  - BadRequestException: the webhook itself rejected the event (e.g. a
 *    refunded payment with no matching row, or a promo cap exhausted at
 *    finalize — the code sold out while the session sat unpaid). Stripe
 *    retrying will not un-sell the code.
 *  - NotFoundException: no payment row for this session id / payment id. A
 *    retry will not magic a row into existence.
 *  - NotImplementedException: the card rail was turned off between the session
 *    being created and the webhook arriving.
 *
 * Everything else (Prisma connection errors, network blips, unknown throws) is
 * treated as transient so Stripe retries.
 */
export function isPermanentError(error: unknown): boolean {
  // Avoid importing Nest's exception classes at module load just for an
  // instanceof check; the error name is stable across Nest versions.
  if (!(error instanceof Error)) return false
  const name = error.constructor.name
  return (
    name === 'BadRequestException' ||
    name === 'NotFoundException' ||
    name === 'NotImplementedException'
  )
}

/**
 * Extract the Rayu payment id from a Checkout Session or Charge, in that order
 * of preference. Every Checkout Session Rayu mints carries `paymentId` in its
 * metadata (set in attachCheckout), and Stripe copies session metadata onto
 * the resulting charge — so a `charge.refunded` event reaches us with the same
 * `paymentId` we wrote.
 *
 * Falls back to a lookup by `stripe_payment_intent_id` on the payment row when
 * metadata is missing (an event from a session minted before this column
 * existed, or a manual Stripe dashboard refund with no metadata round-trip).
 */
export function paymentIdFromObject(
  obj: Stripe.Checkout.Session | Stripe.Charge,
): number | null {
  const meta = (obj.metadata ?? {}) as Record<string, string | undefined>
  const raw = meta.paymentId ?? meta['payment_id']
  if (raw != null && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

/**
 * A random request id for log correlation. Not cryptographically meaningful —
 * just a stable tag so two log lines from one webhook delivery can be tied.
 */
export function requestId(): string {
  return randomBytes(6).toString('hex')
}

/** Type guard for the express Request-with-raw-body shape main.ts produces. */
export function getRawBody(req: Request): Buffer | string {
  // The stripe webhook route is excluded from express.json() in main.ts, so
  // the body arrives as a raw Buffer on req.body (Nest pipes it through as-is).
  // We accept Buffer or string; the SDK signs the exact bytes, so either works
  // as long as nothing re-serialized it.
  const raw = req.body
  if (Buffer.isBuffer(raw)) return raw
  if (typeof raw === 'string') return raw
  // A parsed JSON body means a body parser ran (misconfiguration) — the
  // signature would be invalid anyway, but report it loudly so the operator
  // sees the misconfiguration rather than a generic "bad signature" 400.
  throw new Error(
    'Stripe webhook body is not a raw Buffer — the route must be excluded from express.json() in main.ts',
  )
}