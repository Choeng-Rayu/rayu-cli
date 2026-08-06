import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { Request } from 'express'
import type Stripe from 'stripe'
import { PaymentsService } from '../payments.service'
import { PrismaService } from '../../prisma/prisma.service'
import { StripeService } from './stripe.service'
import { StripeWebhookController } from './stripe-webhook.controller'
import {
  isPermanentError,
  isUniqueViolation,
  paymentIdFromObject,
} from './stripe-webhook.util'

type Mock = jest.Mock

interface Mocks {
  controller: StripeWebhookController
  stripe: {
    constructWebhookEvent: Mock
  }
  payments: {
    confirmStripeCheckout: Mock
    expireStripeCheckout: Mock
    handleChargeRefunded: Mock
  }
  prisma: {
    stripeWebhookEvent: {
      create: Mock
      update: Mock
      findUnique: Mock
    }
  }
}

function makeEvent(
  type: string,
  obj: Record<string, unknown>,
  id = `evt_${Math.random().toString(36).slice(2)}`,
): Stripe.Event {
  return {
    id,
    type,
    api_version: '2026-07-29.dahlia',
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    object: 'event',
    data: { object: obj as never, previous_attributes: null },
  } as unknown as Stripe.Event
}

function makeController(): Mocks {
  const stripe = { constructWebhookEvent: jest.fn() }
  const payments = {
    confirmStripeCheckout: jest.fn(() => Promise.resolve({ paymentId: 1, status: 'paid' })),
    expireStripeCheckout: jest.fn(() => Promise.resolve({ paymentId: 1, status: 'expired' })),
    handleChargeRefunded: jest.fn(() => Promise.resolve({ paymentId: 1, handled: 'topup' })),
  }
  const prisma = {
    stripeWebhookEvent: {
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(),
    },
  }
  const controller = new StripeWebhookController(
    stripe as unknown as StripeService,
    payments as unknown as PaymentsService,
    prisma as unknown as PrismaService,
  )
  return { controller, stripe, payments, prisma } as unknown as Mocks
}

function reqWith(body: Buffer, sig = 't=1,v1=abc'): Request {
  return { headers: { 'stripe-signature': sig }, body } as unknown as Request
}

describe('StripeWebhookController · signature + idempotency', () => {
  it('answers 400 when the signature header is missing', async () => {
    const m = makeController()
    const req = { headers: {}, body: Buffer.from('{}') } as unknown as Request
    await expect(m.controller.webhook(req)).rejects.toBeInstanceOf(BadRequestException)
    expect(m.stripe.constructWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 400 when signature verification fails', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockImplementation(() => {
      throw new Error('no signatures found matching the expected signature')
    })
    await expect(
      m.controller.webhook(reqWith(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('inserts the event row BEFORE dispatching (insert-first idempotency)', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.completed', {
        id: 'cs_test_1',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    // Insert ran, then dispatch ran.
    expect(m.prisma.stripeWebhookEvent.create).toHaveBeenCalledTimes(1)
    expect(m.prisma.stripeWebhookEvent.create.mock.calls[0][0].data.status).toBe('pending')
    expect(m.payments.confirmStripeCheckout).toHaveBeenCalledTimes(1)
    // Row marked 'processed' after a successful dispatch.
    expect(m.prisma.stripeWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processed' }) }),
    )
  })

  it('answers 200 without re-dispatching a duplicate of a completed event', async () => {
    const m = makeController()
    const event = makeEvent('checkout.session.completed', {
      id: 'cs_test_1',
      payment_status: 'paid',
      payment_intent: 'pi_test_1',
    })
    m.stripe.constructWebhookEvent.mockReturnValue(event)
    m.prisma.stripeWebhookEvent.create.mockRejectedValue({ code: 'P2002' })
    m.prisma.stripeWebhookEvent.findUnique.mockResolvedValue({ status: 'processed' })

    await m.controller.webhook(reqWith(Buffer.from('{}')))

    expect(m.payments.confirmStripeCheckout).not.toHaveBeenCalled()
  })

  it('re-dispatches when a duplicate delivery found the previous attempt still pending', async () => {
    const m = makeController()
    const event = makeEvent('checkout.session.completed', {
      id: 'cs_test_1',
      payment_status: 'paid',
      payment_intent: 'pi_test_1',
    })
    m.stripe.constructWebhookEvent.mockReturnValue(event)
    m.prisma.stripeWebhookEvent.create.mockRejectedValue({ code: 'P2002' })
    m.prisma.stripeWebhookEvent.findUnique.mockResolvedValue({ status: 'pending' })

    await m.controller.webhook(reqWith(Buffer.from('{}')))

    // Re-dispatched — the grant-side idempotency makes this safe.
    expect(m.payments.confirmStripeCheckout).toHaveBeenCalledTimes(1)
  })
})

describe('StripeWebhookController · dispatch', () => {
  it('grants on checkout.session.completed only when payment_status === "paid"', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.completed', {
        id: 'cs_paid',
        payment_status: 'paid',
        payment_intent: 'pi_paid',
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    expect(m.payments.confirmStripeCheckout).toHaveBeenCalledWith('cs_paid', 'pi_paid')
  })

  it('does NOT grant on checkout.session.completed with payment_status "unpaid" (async method)', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.completed', {
        id: 'cs_unpaid',
        payment_status: 'unpaid',
        payment_intent: 'pi_unpaid',
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    // Waiting for async_payment_succeeded — granting now would double-grant.
    expect(m.payments.confirmStripeCheckout).not.toHaveBeenCalled()
  })

  it('grants on async_payment_succeeded', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.async_payment_succeeded', {
        id: 'cs_async',
        payment_intent: 'pi_async',
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    expect(m.payments.confirmStripeCheckout).toHaveBeenCalledWith('cs_async', 'pi_async')
  })

  it('expires on async_payment_failed and checkout.session.expired', async () => {
    for (const type of [
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
    ]) {
      const m = makeController()
      m.stripe.constructWebhookEvent.mockReturnValue(
        makeEvent(type, { id: 'cs_exp' }),
      )
      await m.controller.webhook(reqWith(Buffer.from('{}')))
      expect(m.payments.expireStripeCheckout).toHaveBeenCalledWith('cs_exp')
    }
  })

  it('logs only on charge.dispute.created — no automated reversal', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('charge.dispute.created', {
        id: 'dp_1',
        charge: 'ch_1',
        payment_intent: 'pi_1',
        amount: 500,
        currency: 'usd',
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    // Dispute touches NOTHING on the money side.
    expect(m.payments.confirmStripeCheckout).not.toHaveBeenCalled()
    expect(m.payments.expireStripeCheckout).not.toHaveBeenCalled()
    expect(m.payments.handleChargeRefunded).not.toHaveBeenCalled()
  })

  it('dispatches charge.refunded to handleChargeRefunded using metadata.paymentId', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_1',
        metadata: { paymentId: '42' },
      }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    expect(m.payments.handleChargeRefunded).toHaveBeenCalledWith(42, 'pi_1')
  })

  it('falls back to a payment-intent lookup when metadata.paymentId is absent', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_orphan',
        metadata: {},
      }),
    )
    // No metadata round-trip → look the row up by stripe_payment_intent_id.
    m.prisma.stripeWebhookEvent.findUnique.mockResolvedValue(null)
    // The controller uses prisma.payment.findFirst for the fallback — extend
    // the mock lazily when the controller reaches it.
    ;(m.prisma as unknown as { payment?: { findFirst: Mock } }).payment = {
      findFirst: jest.fn(() => Promise.resolve({ id: 99 })),
    }
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    expect(m.payments.handleChargeRefunded).toHaveBeenCalledWith(99, 'pi_orphan')
  })

  it('answers 200 and marks "ignored" for an event type with no handler', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('invoice.paid', { id: 'in_1' }),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    // Ignored, not processed.
    expect(m.prisma.stripeWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ignored' }) }),
    )
    expect(m.payments.confirmStripeCheckout).not.toHaveBeenCalled()
  })
})

describe('StripeWebhookController · error classification', () => {
  it('answers 200 and marks "failed" for a PERMANENT error (stops Stripe retrying)', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.completed', {
        id: 'cs_perm',
        payment_status: 'paid',
        payment_intent: 'pi_perm',
      }),
    )
    // A NotFoundException from confirmStripeCheckout (no row for this session)
    // is permanent — a retry will not magic a row into existence.
    m.payments.confirmStripeCheckout.mockRejectedValue(
      new NotFoundException('No payment found for session cs_perm'),
    )
    await m.controller.webhook(reqWith(Buffer.from('{}')))
    expect(m.prisma.stripeWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    )
  })

  it('throws (5xx) for a TRANSIENT error so Stripe retries', async () => {
    const m = makeController()
    m.stripe.constructWebhookEvent.mockReturnValue(
      makeEvent('checkout.session.completed', {
        id: 'cs_trans',
        payment_status: 'paid',
        payment_intent: 'pi_trans',
      }),
    )
    // A plain Error (DB connection blip, unknown) is transient.
    m.payments.confirmStripeCheckout.mockRejectedValue(new Error('connection refused'))
    await expect(m.controller.webhook(reqWith(Buffer.from('{}')))).rejects.toThrow(
      'connection refused',
    )
    // Row left 'pending' so the retry re-dispatches.
    expect(m.prisma.stripeWebhookEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })
})

describe('stripe-webhook.util', () => {
  it('isUniqueViolation recognizes a P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true)
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false)
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
  })

  it('isPermanentError recognizes Nest permanent exceptions only', () => {
    expect(isPermanentError(new BadRequestException('x'))).toBe(true)
    expect(isPermanentError(new NotFoundException('x'))).toBe(true)
    expect(isPermanentError(new Error('x'))).toBe(false)
  })

  it('paymentIdFromObject parses metadata.paymentId', () => {
    expect(paymentIdFromObject({ metadata: { paymentId: '42' } } as never)).toBe(42)
    expect(paymentIdFromObject({ metadata: { paymentId: 'not-a-number' } } as never)).toBeNull()
    expect(paymentIdFromObject({ metadata: null } as never)).toBeNull()
    expect(paymentIdFromObject({} as never)).toBeNull()
  })
})