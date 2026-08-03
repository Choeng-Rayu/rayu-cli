import { NotImplementedException } from '@nestjs/common'
import type Stripe from 'stripe'
import { StripeService } from './stripe.service'
import * as client from './stripe.client'

/**
 * The SDK is fully mocked here — these tests are about the CONTRACT this wrapper
 * presents to PaymentsService, not about Stripe's behaviour:
 *
 *  - one-time `mode: 'payment'`, never a subscription
 *  - inline `price_data` (a stored Stripe Price would drift from an
 *    admin-editable plan price)
 *  - `allow_promotion_codes: false` (Rayu's promo is already in the amount)
 *  - an idempotency key on every create, so a retry cannot mint a second
 *    payable session
 *  - raw body + configured tolerance passed straight through to signature
 *    verification
 */

interface SdkMocks {
  service: StripeService
  create: jest.Mock
  retrieve: jest.Mock
  expire: jest.Mock
  constructEvent: jest.Mock
  /** The params object passed to checkout.sessions.create. */
  params: () => Stripe.Checkout.SessionCreateParams
  /** The options (2nd arg) passed to checkout.sessions.create. */
  options: () => { idempotencyKey?: string }
}

function makeService(overrides: { url?: string | null } = {}): SdkMocks {
  const create = jest.fn(
    (
      params: Stripe.Checkout.SessionCreateParams,
      _options?: Stripe.RequestOptions,
    ) =>
      Promise.resolve({
        id: 'cs_test_123',
        url:
          overrides.url === undefined
            ? 'https://checkout.stripe.com/c/pay/cs_test_123'
            : overrides.url,
        payment_intent: 'pi_test_456',
        params,
      }) as unknown as Promise<Stripe.Checkout.Session>,
  )
  const retrieve = jest.fn(() => Promise.resolve({ id: 'cs_test_123' }))
  const expire = jest.fn(() => Promise.resolve({ id: 'cs_test_123' }))
  const constructEvent = jest.fn(() => ({ id: 'evt_1', type: 'checkout.session.completed' }))

  jest.spyOn(client, 'getStripe').mockReturnValue({
    client: {
      checkout: { sessions: { create, retrieve, expire } },
      webhooks: { constructEvent },
    } as unknown as Stripe,
    config: {
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_x',
      webhookToleranceSeconds: 120,
      successUrl: 'https://rayucode.com/billing?checkout=success',
      cancelUrl: 'https://rayucode.com/billing?checkout=canceled',
      apiVersion: '2026-07-29.dahlia',
    },
  })

  return {
    service: new StripeService(),
    create,
    retrieve,
    expire,
    constructEvent,
    params: () => create.mock.calls[0][0] as Stripe.Checkout.SessionCreateParams,
    options: () =>
      (create.mock.calls[0][1] ?? {}) as { idempotencyKey?: string },
  }
}

const INPUT = {
  amountCents: 1234,
  productName: 'Pro plan',
  successUrl: 'https://rayucode.com/ok',
  cancelUrl: 'https://rayucode.com/no',
  metadata: { paymentId: '42', kind: 'plan' },
  idempotencyKey: 'rayu-payment-42',
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('StripeService · createCheckoutSession', () => {
  it('returns the session id, hosted URL and payment intent', async () => {
    const m = makeService()
    const session = await m.service.createCheckoutSession(INPUT)
    expect(session).toEqual({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      paymentIntentId: 'pi_test_456',
    })
  })

  it('creates a ONE-TIME payment, never a subscription', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().mode).toBe('payment')
  })

  it('prices with inline price_data in USD cents, not a stored Price id', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    const item = m.params().line_items?.[0]
    expect(item?.quantity).toBe(1)
    // A stored `price` would drift from an admin-editable plan price.
    expect(item?.price).toBeUndefined()
    expect(item?.price_data?.unit_amount).toBe(1234)
    expect(item?.price_data?.currency).toBe('usd')
    expect(item?.price_data?.product_data?.name).toBe('Pro plan')
  })

  it('refuses Stripe-side promotion codes (Rayu already applied its own)', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().allow_promotion_codes).toBe(false)
  })

  it('enables adaptive pricing so buyers see local currency while Rayu settles USD', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().adaptive_pricing).toEqual({ enabled: true })
  })

  it('passes an idempotency key so a retried create cannot mint a second session', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.options().idempotencyKey).toBe('rayu-payment-42')
  })

  it('forwards metadata verbatim — it is what the webhook grants from', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().metadata).toEqual({ paymentId: '42', kind: 'plan' })
  })

  it('converts expiresAt to a unix timestamp in seconds', async () => {
    const m = makeService()
    const expiresAt = new Date('2026-08-01T12:30:00.000Z')
    await m.service.createCheckoutSession({ ...INPUT, expiresAt })
    expect(m.params().expires_at).toBe(Math.floor(expiresAt.getTime() / 1000))
  })

  it('omits expires_at entirely when not given', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().expires_at).toBeUndefined()
  })

  it('truncates client_reference_id to Stripe\u2019s 200-character cap', async () => {
    const m = makeService()
    await m.service.createCheckoutSession({
      ...INPUT,
      clientReferenceId: 'x'.repeat(500),
    })
    expect(m.params().client_reference_id).toHaveLength(200)
  })

  it('omits the optional description and email when absent', async () => {
    const m = makeService()
    await m.service.createCheckoutSession(INPUT)
    expect(m.params().line_items?.[0]?.price_data?.product_data?.description).toBeUndefined()
    expect(m.params().customer_email).toBeUndefined()
  })

  it('includes the description and email when given', async () => {
    const m = makeService()
    await m.service.createCheckoutSession({
      ...INPUT,
      productDescription: 'RAYU20 applied — $5.00 off',
      customerEmail: 'buyer@example.com',
    })
    expect(m.params().line_items?.[0]?.price_data?.product_data?.description).toBe(
      'RAYU20 applied — $5.00 off',
    )
    expect(m.params().customer_email).toBe('buyer@example.com')
  })

  it('fails loudly when Stripe returns a session with no hosted URL', async () => {
    const m = makeService({ url: null })
    // Better to fail here than to persist a payment row that can never be paid.
    await expect(m.service.createCheckoutSession(INPUT)).rejects.toThrow('has no URL')
  })
})

describe('StripeService · webhook verification', () => {
  it('passes the RAW body, signature, secret and configured tolerance through', () => {
    const m = makeService()
    const raw = Buffer.from('{"id":"evt_1"}')
    m.service.constructWebhookEvent(raw, 't=1,v1=abc')
    expect(m.constructEvent).toHaveBeenCalledWith(raw, 't=1,v1=abc', 'whsec_x', 120)
  })

  it('propagates a signature failure rather than swallowing it', () => {
    const m = makeService()
    m.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature')
    })
    expect(() =>
      m.service.constructWebhookEvent(Buffer.from('{}'), 'bad'),
    ).toThrow('No signatures found')
  })
})

describe('StripeService · session lifecycle passthrough', () => {
  it('retrieves a session by id', async () => {
    const m = makeService()
    await m.service.retrieveSession('cs_test_123')
    expect(m.retrieve).toHaveBeenCalledWith('cs_test_123')
  })

  it('expires a session by id', async () => {
    const m = makeService()
    await m.service.expireSession('cs_test_123')
    expect(m.expire).toHaveBeenCalledWith('cs_test_123')
  })

  it('exposes the configured success and cancel URLs', () => {
    const m = makeService()
    expect(m.service.successUrl).toBe('https://rayucode.com/billing?checkout=success')
    expect(m.service.cancelUrl).toBe('https://rayucode.com/billing?checkout=canceled')
  })
})

describe('StripeService · rail disabled', () => {
  it('answers 501 for every SDK operation when the rail is off', async () => {
    jest.spyOn(client, 'getStripe').mockReturnValue(null)
    const service = new StripeService()
    await expect(service.createCheckoutSession(INPUT)).rejects.toThrow(
      NotImplementedException,
    )
    expect(() => service.constructWebhookEvent(Buffer.from('{}'), 'sig')).toThrow(
      NotImplementedException,
    )
    await expect(service.retrieveSession('cs_1')).rejects.toThrow(NotImplementedException)
  })

  it('reports enabled from the env flag', () => {
    const saved = process.env.STRIPE_ENABLED
    try {
      delete process.env.STRIPE_ENABLED
      expect(new StripeService().enabled).toBe(false)
      process.env.STRIPE_ENABLED = 'true'
      expect(new StripeService().enabled).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.STRIPE_ENABLED
      else process.env.STRIPE_ENABLED = saved
    }
  })
})
