import Stripe from 'stripe'
import { loadStripeConfig, type StripeConfig } from './stripe.config'

/**
 * Lazily-constructed Stripe SDK singleton.
 *
 * Lazy on purpose: the client is NEVER constructed while STRIPE_ENABLED is off,
 * so a deployment without a Stripe account needs no keys and boots exactly as it
 * did before the card rail existed. Constructing at import time would make the
 * secret key a hard boot requirement for every deployment.
 *
 * Cached because the SDK holds an HTTP agent with a connection pool; building a
 * new client per request would leak sockets under load.
 */
let cached: { client: Stripe; config: StripeConfig } | null = null

/** The SDK client paired with the config it was built from. */
export interface StripeHandle {
  client: Stripe
  config: StripeConfig
}

/** The loaded config, or null when the card rail is switched off. */
export function getStripeConfig(): StripeConfig | null {
  return getStripe()?.config ?? null
}

/**
 * The SDK client + its config, or null when the rail is disabled.
 *
 * `appInfo` identifies Rayu in Stripe's request logs, which is what makes a
 * support conversation about a specific charge tractable. `maxNetworkRetries`
 * lets the SDK retry idempotent failures itself — every call we make passes an
 * idempotency key, so a retry cannot double-charge.
 */
export function getStripe(): StripeHandle | null {
  const config = loadStripeConfig()
  if (!config) {
    // Rail turned off (possibly at runtime in tests) — drop any cached client so
    // a disabled rail can never serve a request through a stale connection.
    cached = null
    return null
  }
  if (cached && cached.config.secretKey === config.secretKey) return cached
  const client = new Stripe(config.secretKey, {
    apiVersion: config.apiVersion as Stripe.LatestApiVersion,
    appInfo: { name: 'rayu-backend' },
    maxNetworkRetries: 2,
  })
  cached = { client, config }
  return cached
}

/** Drop the cached client. Used by tests that flip STRIPE_ENABLED. */
export function resetStripeClient(): void {
  cached = null
}
