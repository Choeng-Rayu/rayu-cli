import { BadRequestException, Controller, Post, Req, Logger } from '@nestjs/common'
import type { Request } from 'express'
import type Stripe from 'stripe'
import { PaymentsService } from '../payments.service'
import { StripeService } from './stripe.service'
import {
  getRawBody,
  isPermanentError,
  isUniqueViolation,
  paymentIdFromObject,
  requestId,
} from './stripe-webhook.util'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Public, unauthenticated Stripe webhook endpoint.
 *
 * SECURITY: this is a network-exposed endpoint with NO RayuAuthGuard — by
 * design, because Stripe signs the request body and that signature IS the
 * authentication. The verification happens in StripeService.constructWebhookEvent:
 * a bad signature throws and we answer 400. Stripe's recommended IP allowlist
 * is the deployment-level second control (configured in Caddy / the firewall,
 * not the application); this controller does not enforce it because a valid
 * signature already proves the request came from Stripe, and an IP rule is a
 * defense-in-depth that does not belong in application code.
 *
 * Why a separate controller (not on PaymentsController): PaymentsController
 * has a class-level RayuAuthGuard, which would reject Stripe's signed POSTs.
 * Splitting also lets us read the raw Buffer via @Req() so the global
 * ValidationPipe (which rejects bodies with no matching DTO) has no DTO to
 * reject — the body is consumed by signature verification, not by a DTO.
 *
 * STATUS CONTRACT (Stripe retries for up to three days on non-2xx):
 *  - 400: bad signature or timestamp outside tolerance. Stripe retries these
 *    on a clock-skew, but a genuinely bad signature is not going to validate
 *    on a retry, so 400 (rather than 5xx) keeps the logs honest.
 *  - 200: the event was inserted (idempotent), AND either dispatched
 *    successfully, OR failed PERMANENTLY (we log + mark the row 'failed' so a
 *    retry is a no-op). Stopping retries on a permanent failure is the whole
 *    point of the 'failed' status — without it Stripe would hammer a
 *    cap-exhausted promo finalize for three days.
 *  - 5xx: a transient error (DB connection, network) — Stripe retries.
 */
@Controller('payments/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name)

  constructor(
    private readonly stripe: StripeService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('webhook')
  async webhook(@Req() req: Request): Promise<{ received: true }> {
    const sig = req.headers['stripe-signature']
    if (typeof sig !== 'string' || sig.length === 0) {
      throw new BadRequestException('missing stripe-signature header')
    }

    let event: Stripe.Event
    try {
      event = this.stripe.constructWebhookEvent(getRawBody(req), sig)
    } catch (err) {
      // Stripe.errors.StripeSignatureVerificationError or a tolerance breach.
      // 400 (not 5xx) — a retry will not fix a bad signature.
      this.logger.warn(
        `stripe webhook signature verification failed: ${(err as Error).message}`,
      )
      throw new BadRequestException('Invalid Stripe webhook signature')
    }

    // Insert the idempotency row BEFORE dispatching. A duplicate delivery
    // (concurrent or a Stripe retry) collides on stripe_event_id's UNIQUE
    // constraint and we answer 200 without re-running the side effect. A
    // crash mid-dispatch leaves the row 'pending', so the retry re-dispatches;
    // the grant-side status='pending' guards make that safe.
    let inserted = true
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          // 'pending' (not the schema default 'processed') so a retry can tell
          // a crashed attempt apart from a completed one.
          status: 'pending',
          payload: event as unknown as object,
        },
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        inserted = false
      } else {
        throw err
      }
    }

    if (!inserted) {
      // Duplicate delivery. If the original attempt finished, the row is
      // 'processed'/'failed' and we are done. If it crashed, the row is still
      // 'pending' and we re-dispatch (grant-side idempotency makes this safe).
      const existing = await this.prisma.stripeWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { status: true },
      })
      if (existing && (existing.status === 'processed' || existing.status === 'failed')) {
        return { received: true }
      }
      this.logger.warn(
        `stripe webhook re-dispatching ${event.id} (${event.type}) — previous attempt left it 'pending'`,
      )
    }

    const rid = requestId()
    try {
      await this.dispatch(event, rid)
      await this.prisma.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { status: 'processed', processedAt: new Date() },
      })
    } catch (err) {
      if (isPermanentError(err)) {
        // Log + mark 'failed' + answer 200. Stripe would otherwise retry a
        // request that will never succeed (e.g. a promo cap exhausted at
        // finalize) for three days, minting a log entry per retry.
        this.logger.error(
          `stripe webhook ${event.id} (${event.type}) permanently failed [${rid}]: ${(err as Error).message}`,
          (err as Error).stack,
        )
        await this.prisma.stripeWebhookEvent
          .update({
            where: { stripeEventId: event.id },
            data: {
              status: 'failed',
              error: `${(err as Error).name}: ${(err as Error).message}`,
              processedAt: new Date(),
            },
          })
          .catch((markErr) => {
            // Never let a failure to MARK the row fail the request — a
            // double-failure here would 5xx and retry the (permanent) dispatch.
            this.logger.error(
              `stripe webhook ${event.id}: failed to mark 'failed' — ${markErr}`,
            )
          })
        return { received: true }
      }
      // Transient: 5xx so Stripe retries. Leave the row 'pending' so the retry
      // re-dispatches (the retry will hit the duplicate-insert branch above and
      // re-dispatch because the row is still 'pending').
      this.logger.error(
        `stripe webhook ${event.id} (${event.type}) transient error [${rid}]: ${(err as Error).message}`,
        (err as Error).stack,
      )
      throw err
    }

    return { received: true }
  }

  /**
   * Route one event to its handler. Each handler is idempotent (or is guarded
   * by the idempotency row above it), so an out-of-order or replayed event is
   * safe. Stripe does not guarantee ordering — see PaymentsService
   * .handleChargeRefunded for the order-independence argument on refunds.
   */
  private async dispatch(event: Stripe.Event, rid: string): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        // Only grant when the money actually moved. A card payment that needs
        // a delay (some async methods) arrives here with payment_status
        // 'unpaid' and a SEPARATE async_payment_succeeded event later —
        // granting now would double-grant.
        if (session.payment_status !== 'paid') {
          this.logger.log(
            `stripe ${event.type} [${rid}] session ${session.id} payment_status=${session.payment_status} — waiting for async confirmation`,
          )
          return
        }
        const ref =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id ?? null
        await this.payments.confirmStripeCheckout(session.id, ref)
        return
      }

      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session
        const ref =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id ?? null
        await this.payments.confirmStripeCheckout(session.id, ref)
        return
      }

      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session
        await this.payments.expireStripeCheckout(session.id)
        return
      }

      case 'charge.dispute.created': {
        // Log only — a dispute is a support action, not an automated reversal.
        // The payment stays 'paid' (the credits were already granted) and a
        // human decides whether to submit evidence or accept the chargeback.
        const dispute = event.data.object as Stripe.Dispute
        const chargeId = dispute.charge as string
        const piId = dispute.payment_intent as string | null
        this.logger.warn(
          `stripe charge.dispute.created [${rid}] charge=${chargeId} paymentIntent=${piId ?? 'n/a'} amount=${dispute.amount}${dispute.currency} — logged only, no automated action`,
        )
        return
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        let paymentId = paymentIdFromObject(charge)
        if (paymentId == null) {
          // Fall back to a lookup by payment_intent id when metadata is absent
          // (a manual Stripe-dashboard refund with no metadata round-trip).
          const piId =
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : charge.payment_intent?.id ?? null
          if (piId) {
            const row = await this.prisma.payment.findFirst({
              where: { stripePaymentIntentId: piId },
              select: { id: true },
            })
            paymentId = row?.id ?? null
          }
        }
        if (paymentId == null) {
          // No matching row. Treat as permanent (200) — a refund for a payment
          // Rayu never recorded is support's to investigate, not a retry target.
          this.logger.warn(
            `stripe charge.refunded [${rid}] charge=${charge.id} — no Rayu payment row, ignoring`,
          )
          return
        }
        const ref =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null
        await this.payments.handleChargeRefunded(paymentId, ref)
        return
      }

      default: {
        // An event type Rayu does not act on. Mark 'ignored' rather than
        // 'processed' so the table distinguishes "handled" from "not our
        // problem" — useful for support when an event type was expected but
        // the dispatch silently did nothing.
        await this.prisma.stripeWebhookEvent
          .update({
            where: { stripeEventId: event.id },
            data: { status: 'ignored', processedAt: new Date() },
          })
          .catch(() => {
            // Best-effort — the dispatch itself was a no-op.
          })
        this.logger.log(`stripe event ${event.type} [${rid}] — no handler, ignored`)
      }
    }
  }
}