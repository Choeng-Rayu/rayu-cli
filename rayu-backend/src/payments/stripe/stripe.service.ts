import { Injectable, NotImplementedException } from '@nestjs/common'
import type Stripe from 'stripe'
import { getStripe, type StripeHandle } from './stripe.client'
import { isStripeEnabled } from './stripe.config'

/**
 * Thin wrapper around the Stripe SDK — the card rail's equivalent of
 * BakongService and AbaService.
 *
 * DELIBERATELY has no business logic and no database access. It sits beside the
 * other two rail providers so PaymentsService owns every pricing and grant rule
 * for all three rails in one place, and so the dependency graph stays one-way
 * (PaymentsModule -> StripeService). Putting checkout logic here instead would
 * require this service to know about plans, promos and credit math, and would
 * make it and PaymentsService mutually dependent.
 */

/** What a created Checkout Session gives back to the payment row. */
export interface StripeCheckoutSession {
  id: string
  /** Hosted Checkout page to send the buyer to. */
  url: string
  paymentIntentId: string | null
}

/** The details a checkout needs, in Rayu's terms rather than Stripe's. */
export interface CreateCheckoutInput {
  /** Charge amount in USD cents — already priced by PaymentsService. */
  amountCents: number
  /** Line-item title the buyer sees on the hosted page, e.g. "Pro plan". */
  productName: string
  /** Optional second line, e.g. how a promo code changed the price. */
  productDescription?: string
  successUrl: string
  cancelUrl: string
  /** Absolute expiry for the session; aligned with the payment row's expiresAt. */
  expiresAt?: Date
  /** Everything the webhook needs to grant without re-deriving it. */
  metadata: Record<string, string>
  /**
   * Reconciliation handle shown in the Stripe dashboard. Stripe caps this at 200
   * characters.
   */
  clientReferenceId?: string
  customerEmail?: string
  /**
   * Stripe idempotency key. Derived from the purchase intent so a retried create
   * (our own retry, or the SDK's) returns the SAME session instead of minting a
   * second one the buyer could also pay.
   */
  idempotencyKey: string
}

/** Stripe's cap on client_reference_id. */
const CLIENT_REFERENCE_ID_MAX = 200

@Injectable()
export class StripeService {
  /** True when this deployment has the card rail switched on. */
  get enabled(): boolean {
    return isStripeEnabled()
  }

  /**
   * The SDK client, or a 501 when the rail is off. Callers that can produce a
   * better message (e.g. "use ABA or Bakong KHQR") check `enabled` first.
   */
  private require(): StripeHandle {
    const stripe = getStripe()
    if (!stripe) {
      throw new NotImplementedException(
        'Card (Stripe) payments are not enabled on this server.',
      )
    }
    return stripe
  }

  /** The configured success URL, so callers do not each read the env. */
  get successUrl(): string {
    return this.require().config.successUrl
  }

  /** The configured cancel URL. */
  get cancelUrl(): string {
    return this.require().config.cancelUrl
  }

  /**
   * Create a hosted Checkout Session for a one-time payment.
   *
   * `mode: 'payment'` (not 'subscription') because that is what the rest of this
   * system models: an ABA/Bakong purchase is one-shot and nothing auto-renews, so
   * a Stripe subscription would introduce a lifecycle no other rail has.
   *
   * `price_data` is inline rather than a stored Stripe Price on purpose: plan
   * prices and the credits-per-dollar rate are both admin-editable at runtime, so
   * a stored Price would drift from what this server would charge.
   *
   * `allow_promotion_codes: false` because Rayu's own PromoService has ALREADY
   * been applied to `amountCents`. Letting Stripe collect a second code would
   * discount an already-discounted total and diverge from the PromoRedemption we
   * recorded.
   */
  async createCheckoutSession(
    input: CreateCheckoutInput,
  ): Promise<StripeCheckoutSession> {
    const { client } = this.require()
    const session = await client.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: input.amountCents,
              product_data: {
                name: input.productName,
                ...(input.productDescription
                  ? { description: input.productDescription }
                  : {}),
              },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // International buyers see their local currency while Rayu still settles
        // and records the payment in USD (payments.currency is USD everywhere).
        adaptive_pricing: { enabled: true },
        allow_promotion_codes: false,
        metadata: input.metadata,
        ...(input.clientReferenceId
          ? {
              client_reference_id: input.clientReferenceId.slice(
                0,
                CLIENT_REFERENCE_ID_MAX,
              ),
            }
          : {}),
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        ...(input.expiresAt
          ? { expires_at: Math.floor(input.expiresAt.getTime() / 1000) }
          : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    )
    if (!session.url) {
      // A hosted session without a URL is unusable; fail loudly rather than
      // handing the caller a payment row that can never be paid.
      throw new Error(`Stripe Checkout Session ${session.id} has no URL`)
    }
    return {
      id: session.id,
      url: session.url,
      paymentIntentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
    }
  }

  /** Read a session back (used to reconcile a return from the success URL). */
  async retrieveSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    const { client } = this.require()
    return client.checkout.sessions.retrieve(sessionId)
  }

  /**
   * Expire an open session so an abandoned checkout cannot be paid after Rayu has
   * already given up on it. Best-effort: a session Stripe has already expired (or
   * that was completed) throws, and the caller treats that as done.
   */
  async expireSession(sessionId: string): Promise<void> {
    const { client } = this.require()
    await client.checkout.sessions.expire(sessionId)
  }

  /**
   * Verify a webhook's signature against the RAW request body and return the
   * parsed event.
   *
   * The raw Buffer is mandatory — any re-serialization (which a JSON body parser
   * performs) changes the bytes and invalidates the signature. Throws
   * Stripe.errors.StripeSignatureVerificationError on a bad signature or a
   * timestamp outside the configured tolerance, which the controller answers 400.
   */
  constructWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    const { client, config } = this.require()
    return client.webhooks.constructEvent(
      rawBody,
      signature,
      config.webhookSecret,
      config.webhookToleranceSeconds,
    )
  }
}
