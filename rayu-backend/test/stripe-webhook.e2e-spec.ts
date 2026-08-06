import request from 'supertest'
import type Stripe from 'stripe'
import { createTestApp, type TestContext } from './test-app'
import { StripeService } from '../src/payments/stripe/stripe.service'
import { STRIPE_API_VERSION } from '../src/payments/stripe/stripe.config'
import { PrismaService } from '../src/prisma/prisma.service'

// Stripe must be ON for the webhook path to do anything other than 501.
process.env.STRIPE_ENABLED = 'true'
process.env.STRIPE_SECRET_KEY = 'sk_test_e2e'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e'
process.env.STRIPE_SUCCESS_URL = 'http://localhost:3000/billing'
process.env.STRIPE_CANCEL_URL = 'http://localhost:3000/billing'
process.env.STRIPE_API_VERSION = STRIPE_API_VERSION

const SESSION_ID = 'cs_test_e2e_session'
const PAYMENT_INTENT_ID = 'pi_test_e2e_intent'

function makeEvent(
  type: string,
  obj: Record<string, unknown>,
  id = `evt_${Math.random().toString(36).slice(2)}`,
): Stripe.Event {
  return {
    id,
    type,
    api_version: STRIPE_API_VERSION,
    created: 0,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    object: 'event',
    data: { object: obj as never, previous_attributes: null },
  } as unknown as Stripe.Event
}

describe('Stripe webhook (e2e)', () => {
  let ctx: TestContext
  let prisma: PrismaService
  let nextEvent: Stripe.Event | null = null

  beforeAll(async () => {
    // The StripeService mock bypasses signature verification entirely —
    // constructWebhookEvent returns whatever `nextEvent` is set to, so the test
    // controls the event body directly. createCheckoutSession returns a fixed
    // hosted URL so the create-topup path can complete.
    const stripeMock: Partial<StripeService> = {
      get enabled() {
        return true
      },
      createCheckoutSession: async () => ({
        id: SESSION_ID,
        url: 'https://checkout.stripe.com/c/pay/cs_test_e2e',
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
      retrieveSession: async () => ({}) as Stripe.Checkout.Session,
      expireSession: async () => {},
      constructWebhookEvent: () => {
        if (!nextEvent) throw new Error('no event queued')
        return nextEvent
      },
    }
    Object.defineProperty(stripeMock, 'successUrl', { get: () => 'http://localhost:3000/billing' })
    Object.defineProperty(stripeMock, 'cancelUrl', { get: () => 'http://localhost:3000/billing' })

    ctx = await createTestApp(
      [{ token: StripeService, useValue: stripeMock }],
      { rawPrefixes: ['/api/payments/stripe/webhook'] },
    )
    prisma = ctx.prisma
    // app.e2e-spec runs first (serial) and may leave creditsPerDollar at 0 from
    // its "guarded when rate is 0" test. Restore a payable rate so the card
    // top-up path can price the purchase. AppSettings is a singleton row.
    await prisma.appSettings.updateMany({ data: { creditsPerDollar: 5, minTopupCents: 100 } })
  })

  afterAll(async () => {
    await ctx.app.close()
  })

  /**
   * Mint a Rayu JWT for a fresh test user via the same two-step CLI bridge the
   * real CLI uses: /cli/exchange (Bearer = Google ID token) -> one-time code ->
   * /cli/token -> { accessToken }. The OAuth verifier is mocked by createTestApp
   * to return whatever setOAuthUser configured.
   */
  async function mintToken(email: string): Promise<{ token: string; userId: number }> {
    ctx.setOAuthUser({
      provider: 'google',
      providerAccountId: `google_${email}`,
      email,
      displayName: 'Stripe E2E',
      avatarUrl: null,
      emailVerified: true,
    })
    const exchange = await request(ctx.app.getHttpServer())
      .post('/api/cli/exchange')
      .set('Authorization', 'Bearer fake-google-id-token')
      .send({ state: 'state-stripe-e2e' })
    expect(exchange.status).toBe(201)
    const code = exchange.body.code as string

    const tokenRes = await request(ctx.app.getHttpServer())
      .post('/api/cli/token')
      .send({ code })
    expect(tokenRes.status).toBe(201)
    const accessToken = tokenRes.body.accessToken as string

    const me = await request(ctx.app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(me.status).toBe(200)
    return { token: accessToken, userId: me.body.user.id as number }
  }

  it('create → completion → grant + event row → replay → no double grant', async () => {
    const email = `stripe-e2e-${Date.now()}@example.com`
    const { token: rayuToken, userId } = await mintToken(email)

    // 1. Create a pending top-up on the card rail.
    const createRes = await request(ctx.app.getHttpServer())
      .post('/api/payments/topup')
      .set('Authorization', `Bearer ${rayuToken}`)
      .send({ credits: 25, method: 'stripe' })
    expect(createRes.status).toBe(201)
    expect(createRes.body.method).toBe('stripe')
    expect(createRes.body.checkoutUrl).toContain('checkout.stripe.com')
    const paymentId = createRes.body.paymentId as number

    // The pending rows exist before any webhook lands.
    const pendingTopup = await prisma.creditTopup.findFirst({
      where: { paymentId },
    })
    expect(pendingTopup).not.toBeNull()
    expect(pendingTopup!.status).toBe('pending')

    // 2. Dispatch checkout.session.completed. The payment row is still
    //    'pending' so this is what grants.
    nextEvent = makeEvent('checkout.session.completed', {
      id: SESSION_ID,
      payment_status: 'paid',
      payment_intent: PAYMENT_INTENT_ID,
      metadata: { paymentId: String(paymentId) },
    })
    const sig = 't=1,v1=fake'
    const body = JSON.stringify(nextEvent as unknown as object)
    const firstRes = await request(ctx.app.getHttpServer())
      .post('/api/payments/stripe/webhook')
      .set('stripe-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body)
    expect(firstRes.status).toBe(201)

    // The grant landed: the top-up row flipped to 'paid', the payment to 'paid',
    // and a stripe_webhook_events row exists marked 'processed'.
    const grantedTopup = await prisma.creditTopup.findFirst({
      where: { paymentId },
    })
    expect(grantedTopup!.status).toBe('paid')
    const grantedPayment = await prisma.payment.findUnique({ where: { id: paymentId } })
    expect(grantedPayment!.status).toBe('paid')
    const eventRow = await prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: (nextEvent as unknown as { id: string }).id },
    })
    expect(eventRow).not.toBeNull()
    expect(eventRow!.status).toBe('processed')

    // 3. Replay the SAME event id. The idempotency insert collides (P2002), the
    //    existing row is 'processed', and the dispatch is skipped — no second
    //    grant.
    const replayBody = JSON.stringify(nextEvent as unknown as object)
    const replayRes = await request(ctx.app.getHttpServer())
      .post('/api/payments/stripe/webhook')
      .set('stripe-signature', sig)
      .set('Content-Type', 'application/json')
      .send(replayBody)
    expect(replayRes.status).toBe(201)

    // Still exactly one paid top-up — the replay did not double-grant.
    const topups = await prisma.creditTopup.findMany({ where: { paymentId } })
    expect(topups).toHaveLength(1)
    expect(topups[0].status).toBe('paid')
    // Still exactly one processed event row.
    const eventRows = await prisma.stripeWebhookEvent.findMany({
      where: { stripeEventId: (nextEvent as unknown as { id: string }).id },
    })
    expect(eventRows).toHaveLength(1)

    // Clean up this test's rows so the shared test DB stays stable.
    await prisma.stripeWebhookEvent.deleteMany({ where: {} }).catch(() => {})
    await prisma.creditTopup.deleteMany({ where: { userId } }).catch(() => {})
    await prisma.payment.deleteMany({ where: { userId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  })
})