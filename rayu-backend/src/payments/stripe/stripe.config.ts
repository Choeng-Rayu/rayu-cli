/**
 * Stripe configuration — env only, never the database.
 *
 * The card rail is a THIRD rail alongside ABA and Bakong KHQR, and it is
 * env-gated rather than assumed: a deployment with no Stripe account must keep
 * working exactly as before, which is why every value here is read lazily and
 * validated ONLY when STRIPE_ENABLED is truthy. Importing this module has no
 * side effects and needs no Stripe keys.
 *
 * SECURITY: nothing in this file ever puts a secret into a message, a log line,
 * or an exception. Validation reports the NAME of the missing variable and
 * nothing about its value, because these errors surface in boot logs that get
 * pasted into issues.
 */

/** Pinned Stripe API version. Never `null` (which means "account default" and
 * would silently change the wire format under us when Stripe rolls a version). */
export const STRIPE_API_VERSION = '2026-07-29.dahlia'

/** Stripe's own default replay tolerance for webhook signatures, in seconds. */
const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300

export interface StripeConfig {
  secretKey: string
  webhookSecret: string
  /** Seconds of clock skew allowed when verifying a webhook signature. */
  webhookToleranceSeconds: number
  /** Where Stripe returns the buyer after a completed Checkout Session. */
  successUrl: string
  /** Where Stripe returns the buyer if they abandon Checkout. */
  cancelUrl: string
  apiVersion: string
}

/**
 * Whether the card (Stripe) rail is switched on for this deployment.
 *
 * Env-gated rather than inferred from the presence of a key: an operator may
 * have keys configured for a staging clone and still want the rail off, and the
 * rail must announce itself as unavailable (501) instead of silently degrading
 * to a KHQR the caller did not ask for.
 */
export function isStripeEnabled(): boolean {
  const v = (process.env.STRIPE_ENABLED ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** Read a required variable, naming it (never its value) when absent. */
function required(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value) {
    throw new Error(
      `${name} is required when STRIPE_ENABLED is set. Set it or turn STRIPE_ENABLED off to disable the card rail.`,
    )
  }
  return value
}

/**
 * Parse the webhook tolerance. Deliberately refuses 0: Stripe's docs call that
 * out as a common mistake because it disables the recency check entirely, which
 * is the only thing standing between a captured payload and a replay attack.
 */
function parseTolerance(): number {
  const raw = (process.env.STRIPE_WEBHOOK_TOLERANCE ?? '').trim()
  if (raw === '') return DEFAULT_WEBHOOK_TOLERANCE_SECONDS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      'STRIPE_WEBHOOK_TOLERANCE must be a positive number of seconds (0 would disable webhook replay protection).',
    )
  }
  return parsed
}

/**
 * Load and validate the Stripe configuration. Throws when the rail is enabled
 * but a variable is missing, so a misconfigured deployment fails at the first
 * checkout attempt with a named variable rather than at Stripe's API with an
 * opaque auth error.
 *
 * Returns null when the rail is disabled — callers treat that as "unavailable"
 * and answer 501.
 */
export function loadStripeConfig(): StripeConfig | null {
  if (!isStripeEnabled()) return null
  return {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    webhookToleranceSeconds: parseTolerance(),
    successUrl: required('STRIPE_SUCCESS_URL'),
    cancelUrl: required('STRIPE_CANCEL_URL'),
    apiVersion: (process.env.STRIPE_API_VERSION ?? '').trim() || STRIPE_API_VERSION,
  }
}
