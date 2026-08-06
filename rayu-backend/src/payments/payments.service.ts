import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common'
import { Prisma, type Payment, type Plan } from '@prisma/client'
import type { PlanCode } from '../common/enums'
import { OrganizationsService } from '../organizations/organizations.service'
import { PrismaService } from '../prisma/prisma.service'
import { PromoService } from '../promo/promo.service'
import { AppSettingsService } from '../settings/app-settings.service'
import { UsersService } from '../users/users.service'
import { AbaService } from './aba.service'
import { BakongService } from './bakong.service'
import { isStripeEnabled } from './stripe/stripe.config'
import { StripeService } from './stripe/stripe.service'
import {
  amountCentsFor,
  effectiveMinCents,
  isTopupEnabled,
  minCreditsFor,
  quoteTopup,
  type TopupPricingSettings,
  type TopupQuote,
} from './topup-pricing'

export type PaymentMethod = 'aba' | 'bakong'

/**
 * Rails a purchase can be paid on. A superset of PaymentMethod: 'stripe' is
 * accepted by the API surface (so clients and DTOs are stable across the
 * KHQR → Checkout migration) but currently answers 501 unless STRIPE_ENABLED
 * is set. Shared by top-up, plan checkout and team checkout so there is one
 * name for "the rails a caller may select".
 */
export type CheckoutMethod = PaymentMethod | 'stripe'

/**
 * Back-compat alias — the original name when only the top-up path accepted
 * 'stripe'. Kept so existing imports keep type-checking; new code uses
 * CheckoutMethod.
 * @deprecated use CheckoutMethod
 */
export type TopupMethod = CheckoutMethod

/**
 * The result of a plan checkout (POST /payments/khqr and the renew path).
 * Discriminated on `method` so callers narrow to the rail-specific fields the
 * same way they do for top-ups: the KHQR rails return `qr`/`md5`, Stripe
 * returns `checkoutUrl`. Mirrors TopupPaymentResult on purpose — the dashboards
 * render both with the same component.
 */
export type PlanCheckoutResult =
  | {
      paymentId: number
      planCode: PlanCode
      amountCents: number
      originalCents: number
      discountCents: number
      currency: string
      method: 'aba' | 'bakong'
      qr: string
      md5: string
      expiresAt: Date | null
      reused: boolean
    }
  | {
      paymentId: number
      planCode: PlanCode
      amountCents: number
      originalCents: number
      discountCents: number
      currency: string
      method: 'stripe'
      checkoutUrl: string
      expiresAt: Date | null
      reused: boolean
    }

/**
 * Result of a TEAM plan checkout (POST /payments/team-khqr). Same shape as
 * PlanCheckoutResult plus the team identity (organizationId, slug). The grant
 * path keys off `organizationId` on the payment row, so a Stripe team plan
 * purchase activates through the SAME activatePaid branch as a KHQR one — no
 * webhook-side branching on the rail.
 */
export type TeamCheckoutResult =
  | {
      paymentId: number
      organizationId: number
      slug: string
      planCode: PlanCode
      amountCents: number
      originalCents: number
      discountCents: number
      currency: string
      method: 'aba' | 'bakong'
      qr: string
      md5: string
      expiresAt: Date | null
      reused: boolean
    }
  | {
      paymentId: number
      organizationId: number
      slug: string
      planCode: PlanCode
      amountCents: number
      originalCents: number
      discountCents: number
      currency: string
      method: 'stripe'
      checkoutUrl: string
      expiresAt: Date | null
      reused: boolean
    }

/**
 * Result of a TEAM credit purchase (POST /payments/team/:slug/topup). Same
 * shape as TeamCheckoutResult but carries `credits` + `targetUserId` +
 * `creditsExpireAt` (the pool-period expiry the buyer needs to see before
 * paying). Discriminated on `method` the same way as every other checkout.
 */
export type TeamTopupResult =
  | {
      paymentId: number
      topupId: number
      organizationId: number
      slug: string
      credits: number
      targetUserId: number | null
      amountCents: number
      currency: string
      method: 'aba' | 'bakong'
      qr: string
      md5: string
      expiresAt: Date | null
      creditsExpireAt: Date | null
      reused: boolean
    }
  | {
      paymentId: number
      topupId: number
      organizationId: number
      slug: string
      credits: number
      targetUserId: number | null
      amountCents: number
      currency: string
      method: 'stripe'
      checkoutUrl: string
      expiresAt: Date | null
      creditsExpireAt: Date | null
      reused: boolean
    }

/**
 * The result of `createTopupPayment` — a discriminated union on `method` so
 * callers can narrow to the rail-specific fields (Stripe's `checkoutUrl` vs the
 * KHQR rails' `qr`/`md5`) with a plain `if (r.method === 'stripe')`. Declared
 * explicitly (rather than left to inference) so the public contract is stable
 * when an internal helper's return shape changes, and so the controller and
 * `renewPayment` return a documented type instead of an inferred union that
 * leaks implementation details.
 */
export type TopupPaymentResult =
  | {
      paymentId: number
      credits: number
      amountCents: number
      currency: string
      method: 'aba' | 'bakong'
      qr: string
      md5: string
      expiresAt: Date | null
      reused: boolean
    }
  | {
      paymentId: number
      credits: number
      amountCents: number
      currency: string
      method: 'stripe'
      checkoutUrl: string
      expiresAt: Date | null
      reused: boolean
    }

/**
 * Whether the card (Stripe) rail is switched on for this deployment. The
 * implementation lives with the rest of the Stripe configuration
 * (payments/stripe/stripe.config.ts); it is re-exported here because this module
 * was the original home of the flag and callers (and tests) import it from here.
 */
export { isStripeEnabled }

/**
 * Ledger `source` for a clawback row written when a paid top-up is refunded.
 * Deliberately NOT 'topup': the top-up balance readers (backend
 * UsersService.getTopupBalance and the gateway's store.TopupBalance) compute
 * `SUM(credit_topups WHERE status='paid') - SUM(credit_ledger WHERE
 * source='topup')`, i.e. source='topup' rows are CONSUMPTION written by the
 * gateway. The clawback itself is applied by flipping the topup row out of
 * 'paid' (see refundTopup); this row exists purely as an audit trail and must
 * not be double-counted as consumption.
 */
const REFUND_LEDGER_SOURCE = 'refund'

/**
 * KHQR / pending-payment lifetime. After this the QR is treated as expired and
 * the payment row is transitioned to 'expired'; the user must generate a fresh
 * QR (POST /payments/:id/renew or a new create call).
 */
const KHQR_TTL_MINUTES = 30
const KHQR_TTL_MS = KHQR_TTL_MINUTES * 60 * 1000
/**
 * How long the hosted Stripe Checkout page stays payable.
 *
 * Longer than KHQR_TTL_MS on purpose. Stripe refuses an `expires_at` less than 30
 * minutes out, which is EXACTLY our QR lifetime, so asking for `now + 30min`
 * would sit on the boundary and be rejected by however long the request takes to
 * reach Stripe. The payment row still expires on the shared 30-minute clock (so
 * every rail counts down identically in the CLI and dashboard); the few extra
 * minutes only mean Stripe's page may still be payable just after Rayu has given
 * up on it. That gap is safe because a completion for an expired row is REVIVED
 * rather than dropped (see confirmStripeCheckout) — if Stripe took the money we
 * grant the credits, which is the only honest outcome.
 */
const STRIPE_SESSION_TTL_MS = 35 * 60 * 1000
/**
 * Extra window (beyond expiry) during which an out-of-band ABA credit alert is
 * still matched to a pending payment — covers the lag between the customer
 * actually paying (before the deadline) and ABA's Telegram alert posting.
 */
const ABA_MATCH_GRACE_MS = 10 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How close to the period end a team credit purchase is flagged as "expiring
 * soon". Purchased credits are zeroed when the pool renews, so buying three days
 * before that is buying three days — the buyer is told before they pay, not
 * after.
 */
const TOPUP_EXPIRY_WARNING_DAYS = 3

/** Read a plan's limits JSON without pulling PlansService into this service. */
function planLimits(plan: Plan): { topUpEnabled?: boolean; creditsPerPeriod?: number | null } {
  return (plan.limits ?? {}) as { topUpEnabled?: boolean; creditsPerPeriod?: number | null }
}

@Injectable()
export class PaymentsService {
  /**
   * Money paths log what they did. Team credit grants in particular need a trail
   * that survives the request: a grant that lands while a team plan is lapsed, or
   * one whose target member left, is something support has to be able to explain.
   */
  private readonly logger = new Logger(PaymentsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly bakong: BakongService,
    private readonly aba: AbaService,
    private readonly settings: AppSettingsService,
    private readonly users: UsersService,
    private readonly promo: PromoService,
    /**
     * Team billing hook. @Optional so this service can still be constructed with
     * only its individual-billing dependencies (unit tests do exactly that);
     * Nest always injects it in the running app. The org code paths below assert
     * its presence rather than silently skipping a grant.
     */
    @Optional()
    private readonly orgs?: OrganizationsService,
    /**
     * Card rail. @Optional for the same reason as `orgs` — and declared LAST so
     * the existing unit tests, which construct this service with only its six
     * required dependencies, keep working unchanged. Every card path asserts its
     * presence via requireStripe() rather than degrading to a KHQR.
     */
    @Optional()
    private readonly stripe?: StripeService,
  ) {}

  /**
   * The card rail, or the 501 that tells the caller to use a KHQR instead.
   *
   * Two distinct refusals, because they mean different things to a user: the rail
   * being switched off for this deployment is a configuration answer ("use ABA or
   * Bakong"), whereas a missing provider is a wiring bug. Neither ever silently
   * falls back to a QR the caller did not ask for.
   */
  private requireStripe(): StripeService {
    if (!isStripeEnabled()) {
      throw new NotImplementedException(
        'Card (Stripe) top-up is not enabled on this server — use ABA or Bakong KHQR.',
      )
    }
    if (!this.stripe) {
      throw new NotImplementedException(
        'Card (Stripe) payments are not available on this server.',
      )
    }
    return this.stripe
  }

  /** The card rail's availability — env-gated, exposed for the web clients. */
  isStripeRailEnabled(): boolean {
    return isStripeEnabled()
  }

  /** A plan is credit-based when it grants a per-period credit allowance. */
  private isCreditPlan(plan: Plan): boolean {
    const limits = (plan.limits ?? {}) as { creditsPerPeriod?: number | null }
    return (
      typeof limits.creditsPerPeriod === 'number' && limits.creditsPerPeriod > 0
    )
  }

  /**
   * Compute how many credits from a prior paid period should be carried over to
   * a new paid plan activation. Unused credits from an active (non-expired)
   * credit plan are converted into a permanent top-up credit. Expired periods
   * and non-credit plans yield 0.
   */
  private async computeCarryoverCredits(
    userId: number,
    previousSub: { id: number; startedAt: Date; currentPeriodEnd: Date | null; plan: Plan } | null,
  ): Promise<number> {
    if (!previousSub) return 0
    // An already-expired period has no remaining allowance to carry forward.
    if (previousSub.currentPeriodEnd && previousSub.currentPeriodEnd.getTime() <= Date.now()) {
      return 0
    }
    const limits = (previousSub.plan.limits ?? {}) as { creditsPerPeriod?: number | null }
    const allowance =
      typeof limits.creditsPerPeriod === 'number' ? limits.creditsPerPeriod : null
    if (!allowance || allowance <= 0) return 0

    const consumed = await this.prisma.creditLedger.aggregate({
      _sum: { credits: true },
      where: {
        userId,
        source: 'plan',
        createdAt: { gte: previousSub.startedAt },
      },
    })
    const used = consumed._sum.credits ?? 0
    return Math.max(0, allowance - used)
  }

  /**
   * Shared subscription switch for paid plan activations: cancels all active
   * subscriptions, creates a new one with the given period end, and carries over
   * any unused credits from the previous active period as a permanent top-up.
   * Returns the number of credits carried over.
   */
  private async switchSubscriptionWithCarryover(
    userId: number,
    planId: number,
    currentPeriodEnd: Date,
  ): Promise<number> {
    const previousSubs = await this.prisma.subscription.findMany({
      where: { userId, status: 'active' },
      include: { plan: true },
      orderBy: { startedAt: 'desc' },
      take: 1,
    })
    const previousSub = previousSubs[0] ?? null
    const carryoverCredits = await this.computeCarryoverCredits(userId, previousSub)

    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.subscription.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'canceled' },
      }),
      this.prisma.subscription.create({
        data: { userId, planId, status: 'active', currentPeriodEnd },
      }),
    ]
    if (carryoverCredits > 0) {
      ops.push(
        this.prisma.creditTopup.create({
          data: {
            userId,
            credits: carryoverCredits,
            amountCents: 0,
            status: 'paid',
          },
        }),
      )
    }
    await this.prisma.$transaction(ops)
    return carryoverCredits
  }

  async createKhqr(
    userId: number,
    planCode: PlanCode,
    method: CheckoutMethod = 'aba',
    promoCode?: string,
  ): Promise<PlanCheckoutResult> {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }

    // Block a duplicate purchase of a non-credit (feature-unlock) plan the user
    // already actively holds. getActiveSubscription resolves the EFFECTIVE plan
    // (an expired period auto-falls back to Free), so a same-code match here
    // means the subscription is active AND not expired. Credit plans
    // (creditsPerPeriod > 0) are exempt — re-buying renews their period/credits.
    if (!this.isCreditPlan(plan)) {
      const { plan: current } = await this.users.getActiveSubscription(userId)
      if (current.code === plan.code) {
        throw new BadRequestException(
          `You're already on the ${plan.name} plan. It unlocks all features and has no credits to add, so there's nothing to purchase again until it expires.`,
        )
      }
    }

    // Optional promo code. A code that drops the price to $0 must go through the
    // free-claim path (no QR to pay), so reject it here with guidance to claim.
    const quote = promoCode
      ? await this.promo.validateForPurchase(
          promoCode,
          planCode,
          userId,
          plan.priceCents,
        )
      : null
    if (quote?.isFree) {
      throw new BadRequestException(
        'This promo code makes the plan free — claim it instead of paying.',
      )
    }
    const amountCents = quote ? quote.finalCents : plan.priceCents
    const discountCents = quote ? quote.discountCents : 0
    const promoCodeId = quote ? quote.promo.id : null

    // Fail before writing anything when the card rail is off, so a refused card
    // purchase never leaves a pending row or a reserved promo slot behind.
    if (method === 'stripe') {
      this.requireStripe()
      return this.createPlanStripeRow(userId, plan, planCode, amountCents, discountCents, promoCodeId, quote)
    }
    return this.createPlanKhqrRow(userId, plan, planCode, method, amountCents, discountCents, promoCodeId, quote)
  }

  /**
   * KHQR rail for plan checkout: mint (or reuse) the QR and the pending row.
   * Shared with the Stripe branch only through the eligibility + promo checks
   * that ran in createKhqr before this was called — past that point the two
   * rails write different columns (khqr/md5 vs stripeCheckout*) and produce
   * different response shapes, but the SAME pending `payments` row the grant
   * path (activatePaid) consumes.
   */
  private async createPlanKhqrRow(
    userId: number,
    plan: Plan,
    planCode: PlanCode,
    method: PaymentMethod,
    amountCents: number,
    discountCents: number,
    promoCodeId: number | null,
    quote: { promo: { id: number }; originalCents: number; discountCents: number; finalCents: number } | null,
  ): Promise<PlanCheckoutResult> {
    // Reuse a still-valid pending QR for the SAME intent (plan + provider +
    // promo/amount) so refreshing checkout keeps the same QR until it is paid,
    // canceled, or expires (30 min).
    const reusable = await this.prisma.payment.findFirst({
      where: {
        userId,
        planId: plan.id,
        provider: method,
        status: 'pending',
        amountCents,
        promoCodeId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable?.khqr && reusable.md5) {
      return {
        paymentId: reusable.id,
        planCode,
        amountCents: reusable.amountCents,
        originalCents: plan.priceCents,
        discountCents: reusable.discountCents,
        currency: reusable.currency,
        method,
        qr: reusable.khqr,
        md5: reusable.md5,
        expiresAt: reusable.expiresAt,
        reused: true,
      }
    }

    const billNumber = `RAYU-${userId}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(method, amountCents / 100, billNumber)

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        provider,
        amountCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        promoCodeId,
        discountCents,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })

    // Reserve the promo slot (pending) linked to this payment; finalized on pay.
    if (quote) {
      await this.promo.recordPendingRedemption({
        promoCodeId: quote.promo.id,
        userId,
        planCode,
        originalCents: quote.originalCents,
        discountCents: quote.discountCents,
        finalCents: quote.finalCents,
        paymentId: payment.id,
      })
    }

    return {
      paymentId: payment.id,
      planCode,
      amountCents,
      originalCents: plan.priceCents,
      discountCents,
      currency: 'USD',
      method,
      qr,
      md5,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /**
   * Card rail for plan checkout: mint (or reuse) a hosted Checkout Session and
   * the pending row.
   *
   * Same shape as createPlanKhqrRow on purpose — same pending `payments` row the
   * grant path (activatePaid) consumes, same reuse-on-refresh rule, same
   * 30-minute deadline — so the grant path cannot tell the rails apart. The only
   * difference in the response is `checkoutUrl` where the KHQR rails return
   * `qr`/`md5`.
   *
   * `unit_amount` is the promo-discounted finalCents (or plan.priceCents), so a
   * paid plan with a 50%-off code charges half on the card. The promo slot is
   * reserved pending here and finalized in activatePaid; the
   * finalizeRedemption re-check of the cap is caught in the webhook as a
   * PERMANENT error (log + 200) because Stripe would otherwise retry a
   * cap-exhausted purchase for three days.
   */
  private async createPlanStripeRow(
    userId: number,
    plan: Plan,
    planCode: PlanCode,
    amountCents: number,
    discountCents: number,
    promoCodeId: number | null,
    quote: { promo: { id: number }; originalCents: number; discountCents: number; finalCents: number } | null,
  ): Promise<PlanCheckoutResult> {
    // Reuse a still-valid pending Checkout Session for the same intent (plan +
    // promo/amount), mirroring the KHQR branch. Requires a stored URL: a row
    // whose session creation failed has none and must not be handed back.
    const reusable = await this.prisma.payment.findFirst({
      where: {
        userId,
        planId: plan.id,
        provider: 'stripe',
        status: 'pending',
        amountCents,
        promoCodeId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable?.stripeCheckoutUrl) {
      return {
        paymentId: reusable.id,
        planCode,
        amountCents: reusable.amountCents,
        originalCents: plan.priceCents,
        discountCents: reusable.discountCents,
        currency: reusable.currency,
        method: 'stripe',
        checkoutUrl: reusable.stripeCheckoutUrl,
        expiresAt: reusable.expiresAt,
        reused: true,
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        provider: 'stripe',
        amountCents,
        currency: 'USD',
        status: 'pending',
        promoCodeId,
        discountCents,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })

    // Reserve the promo slot (pending) linked to this payment; finalized on pay.
    if (quote) {
      await this.promo.recordPendingRedemption({
        promoCodeId: quote.promo.id,
        userId,
        planCode,
        originalCents: quote.originalCents,
        discountCents: quote.discountCents,
        finalCents: quote.finalCents,
        paymentId: payment.id,
      })
    }

    const { checkoutUrl } = await this.attachCheckout(payment, {
      productName: plan.name,
      productDescription: quote
        ? `Promo code applied: ${quote.discountCents > 0 ? `−$${(quote.discountCents / 100).toFixed(2)}` : 'free'}`
        : undefined,
      metadata: {
        kind: 'plan',
        planCode,
        userId: String(userId),
        ...(promoCodeId != null ? { promoCodeId: String(promoCodeId) } : {}),
      },
      customerEmail: await this.billingEmail(userId),
    })

    return {
      paymentId: payment.id,
      planCode,
      amountCents,
      originalCents: plan.priceCents,
      discountCents,
      currency: 'USD',
      method: 'stripe',
      checkoutUrl,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /**
   * Team checkout: one KHQR that buys an ORG-owned subscription.
   *
   * The row is still `userId = the paying admin` (that is who owes the money and
   * whose payment history shows it) PLUS `organizationId`, and it is that second
   * column that makes activatePaid seed the team's shared credit pool instead of
   * switching the payer's personal subscription. Individual checkout is
   * completely untouched by this method.
   *
   * Promo codes are not accepted here: a redemption is per-USER (see
   * PromoRedemption), so applying one to a team purchase would silently burn the
   * admin's personal one-per-code slot on an org's behalf. Refusing is honest and
   * reversible; v2 can add org-scoped redemptions.
   */
  async createTeamKhqr(
    adminUserId: number,
    slug: string,
    planCode: PlanCode,
    method: CheckoutMethod = 'aba',
  ): Promise<TeamCheckoutResult> {
    const orgs = this.requireOrgs()
    const org = await orgs.requireAdmin(slug, adminUserId)

    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }
    if (!plan.isTeamPlan) {
      throw new BadRequestException(
        `${plan.name} is an individual plan. Pick a team plan for "${org.name}" — a personal plan cannot be shared with members.`,
      )
    }

    // Fail before writing anything when the card rail is off, so a refused
    // card purchase never leaves a pending team row behind. Promo codes are
    // refused for the same reason as the KHQR branch (per-USER redemption).
    if (method === 'stripe') {
      this.requireStripe()
      return this.createTeamPlanStripeRow(adminUserId, org, plan, planCode)
    }
    return this.createTeamPlanKhqrRow(adminUserId, org, plan, planCode, method)
  }

  /** KHQR rail for team plan checkout. */
  private async createTeamPlanKhqrRow(
    adminUserId: number,
    org: { id: number; slug: string; name: string },
    plan: Plan,
    planCode: PlanCode,
    method: PaymentMethod,
  ): Promise<TeamCheckoutResult> {
    // Reuse a still-valid pending team QR for the same intent, mirroring the
    // individual path so refreshing checkout doesn't mint a second QR.
    const reusable = await this.prisma.payment.findFirst({
      where: {
        organizationId: org.id,
        planId: plan.id,
        provider: method,
        status: 'pending',
        amountCents: plan.priceCents,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable?.khqr && reusable.md5) {
      return {
        paymentId: reusable.id,
        organizationId: org.id,
        slug: org.slug,
        planCode,
        amountCents: reusable.amountCents,
        originalCents: plan.priceCents,
        discountCents: reusable.discountCents,
        currency: reusable.currency,
        method,
        qr: reusable.khqr,
        md5: reusable.md5,
        expiresAt: reusable.expiresAt,
        reused: true,
      }
    }

    const billNumber = `RAYU-ORG${org.id}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(
      method,
      plan.priceCents / 100,
      billNumber,
    )
    const payment = await this.prisma.payment.create({
      data: {
        userId: adminUserId,
        organizationId: org.id,
        planId: plan.id,
        provider,
        amountCents: plan.priceCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    return {
      paymentId: payment.id,
      organizationId: org.id,
      slug: org.slug,
      planCode,
      amountCents: plan.priceCents,
      originalCents: plan.priceCents,
      discountCents: 0,
      currency: 'USD',
      method,
      qr,
      md5,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /**
   * Card rail for team plan checkout. Same pending `payments` row the grant
   * path consumes — `organizationId` on the row is what makes activatePaid seed
   * the team pool, so the webhook needs no rail branching. Promo codes are
   * refused for the same per-USER redemption reason as the KHQR branch.
   */
  private async createTeamPlanStripeRow(
    adminUserId: number,
    org: { id: number; slug: string; name: string },
    plan: Plan,
    planCode: PlanCode,
  ): Promise<TeamCheckoutResult> {
    const reusable = await this.prisma.payment.findFirst({
      where: {
        organizationId: org.id,
        planId: plan.id,
        provider: 'stripe',
        status: 'pending',
        amountCents: plan.priceCents,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable?.stripeCheckoutUrl) {
      return {
        paymentId: reusable.id,
        organizationId: org.id,
        slug: org.slug,
        planCode,
        amountCents: reusable.amountCents,
        originalCents: plan.priceCents,
        discountCents: reusable.discountCents,
        currency: reusable.currency,
        method: 'stripe',
        checkoutUrl: reusable.stripeCheckoutUrl,
        expiresAt: reusable.expiresAt,
        reused: true,
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId: adminUserId,
        organizationId: org.id,
        planId: plan.id,
        provider: 'stripe',
        amountCents: plan.priceCents,
        currency: 'USD',
        status: 'pending',
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    const { checkoutUrl } = await this.attachCheckout(payment, {
      productName: `${plan.name} (team)`,
      metadata: {
        kind: 'team_plan',
        planCode,
        organizationId: String(org.id),
        userId: String(adminUserId),
      },
      customerEmail: await this.billingEmail(adminUserId),
    })
    return {
      paymentId: payment.id,
      organizationId: org.id,
      slug: org.slug,
      planCode,
      amountCents: plan.priceCents,
      originalCents: plan.priceCents,
      discountCents: 0,
      currency: 'USD',
      method: 'stripe',
      checkoutUrl,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /** Team billing is unavailable if the org service was not injected. */
  private requireOrgs(): OrganizationsService {
    if (!this.orgs) {
      throw new BadRequestException('Team billing is not available on this server')
    }
    return this.orgs
  }

  /**
   * Why this team may not buy pay-as-you-go credits right now — or null when it
   * may. ONE helper shared by the quote and the create path, so the price a
   * dashboard shows and the purchase it then attempts can never disagree about
   * eligibility.
   *
   * Team credits are an ADD-ON to a team plan, not an alternative to one: the
   * plan is what grants model access and daily turns (the gateway resolves both
   * from the ORG's plan), so credits without a plan would be money for something
   * unusable. Individuals work the same way — `free` has no topUpEnabled.
   */
  private teamTopupBlocker(
    sub: { status: string; currentPeriodEnd: Date | null; plan: Plan } | null,
    settings: TopupPricingSettings,
    orgName: string,
  ): { reason: string; message: string } | null {
    if (!isTopupEnabled(settings)) {
      return {
        reason: 'rate_disabled',
        message:
          'Credit purchases are turned off right now. Ask support to set a credits-per-dollar rate.',
      }
    }
    if (!sub) {
      return {
        reason: 'no_team_plan',
        message: `"${orgName}" has no team plan yet. Buy a team plan first — credits top up the plan's shared pool, and the plan is what gives members model access.`,
      }
    }
    if (sub.status !== 'active') {
      return {
        reason: `plan_${sub.status}`,
        message:
          sub.status === 'past_due'
            ? 'This team plan is past due. Renew it before buying more credits.'
            : 'This team plan is canceled. Buy or renew a team plan before buying credits.',
      }
    }
    if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= Date.now()) {
      return {
        reason: 'period_ended',
        message:
          'This team period has ended. Renew the team plan first — credits bought now would expire with the period they are bought into.',
      }
    }
    // Per-plan kill switch, identical in meaning to the individual plans'
    // topUpEnabled: an admin can sell a team plan with a fixed allowance and no
    // pay-as-you-go on top.
    const limits = planLimits(sub.plan)
    if (!limits.topUpEnabled) {
      return {
        reason: 'plan_topup_disabled',
        message: `The ${sub.plan.name} plan does not allow buying extra credits. Enable "top-up" on that plan, or upgrade to one that has it.`,
      }
    }
    return null
  }

  /**
   * Price a TEAM credit purchase without creating anything.
   *
   * Shares `quoteTopup` with the individual path, so a team pays the same
   * admin-configured rate per credit — there is no second rate to keep in sync.
   * What it adds is the part that is specific to a team: whether this team is
   * allowed to buy at all, and WHEN the credits stop being spendable.
   *
   * The expiry is not decoration. Purchased credits live in the pool's current
   * period and are zeroed at renewal, so a purchase made two days before the
   * period ends is worth two days. The caller gets `expiresAt`, `daysLeft` and
   * `expiresSoon` precisely so a buyer sees that BEFORE they pay.
   */
  async getTeamTopupQuote(adminUserId: number, slug: string, credits?: number) {
    const orgs = this.requireOrgs()
    const org = await orgs.requireAdmin(slug, adminUserId)
    const [settings, sub, pool] = await Promise.all([
      this.settings.get(),
      this.prisma.organizationSubscription.findUnique({
        where: { organizationId: org.id },
        include: { plan: true },
      }),
      this.prisma.creditPool.findUnique({ where: { organizationId: org.id } }),
    ])

    const base = quoteTopup(settings, credits)
    const blocker = this.teamTopupBlocker(sub, settings, org.name)
    // The credits expire with the POOL's period; fall back to the subscription's
    // period end when the pool row predates one being set.
    const expiresAt = pool?.periodEnd ?? sub?.currentPeriodEnd ?? null
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS))
      : null

    return {
      ...base,
      // The shared math says "is top-up on at all"; this says "may THIS team buy".
      enabled: base.enabled && !blocker,
      reason: blocker?.reason ?? null,
      message: blocker?.message ?? null,
      slug: org.slug,
      planCode: sub?.plan.code ?? null,
      planName: sub?.plan.name ?? null,
      expiresAt,
      daysLeft,
      // A purchase with days left in the period is a worse deal than it looks.
      expiresSoon: daysLeft != null && daysLeft <= TOPUP_EXPIRY_WARNING_DAYS,
      pool: {
        totalCredits: pool?.totalCredits ?? 0,
        usedCredits: pool?.usedCredits ?? 0,
        extraCredits: pool?.extraCredits ?? 0,
      },
    }
  }

  /**
   * Buy pay-as-you-go credits FOR A TEAM: one KHQR that, once paid, raises the
   * team's shared pool for the current period.
   *
   * Shape mirrors createTeamKhqr on purpose — `userId` is the paying admin (they
   * owe the money and it shows in their payment history) and `organizationId` is
   * what makes activatePaid grant to the team instead of to them. The difference
   * is the linked `organization_credit_topups` row, which is what tells
   * activatePaid this is a CREDIT purchase rather than a plan purchase.
   *
   * Eligibility comes from the same `teamTopupBlocker` the quote uses, so a
   * dashboard can never show a payable price for a purchase this would refuse.
   * Promo codes are not accepted, for the same reason team plan checkout refuses
   * them: a redemption is per-USER, so applying one here would burn the admin's
   * personal one-per-code slot on the team's behalf.
   */
  async createTeamTopup(
    adminUserId: number,
    slug: string,
    credits: number,
    method: CheckoutMethod = 'aba',
    targetUserId?: number | null,
  ): Promise<TeamTopupResult> {
    const orgs = this.requireOrgs()
    const org = await orgs.requireAdmin(slug, adminUserId)
    const [settings, sub, pool] = await Promise.all([
      this.settings.get(),
      this.prisma.organizationSubscription.findUnique({
        where: { organizationId: org.id },
        include: { plan: true },
      }),
      this.prisma.creditPool.findUnique({ where: { organizationId: org.id } }),
    ])

    const blocker = this.teamTopupBlocker(sub, settings, org.name)
    if (blocker) throw new BadRequestException(blocker.message)

    // Same shared math as every other rail, so the team is charged exactly what
    // the quote showed at this rate.
    const amountCents = amountCentsFor(credits, settings)
    const minCents = effectiveMinCents(settings)
    if (amountCents < minCents) {
      const minCredits = minCreditsFor(settings)
      throw new BadRequestException(
        `Minimum top-up is $${(minCents / 100).toFixed(2)} (${minCredits.toLocaleString()} credits)`,
      )
    }

    // A named target must be a member NOW. Checked here (not only at grant time)
    // so the admin is told before paying; the grant path degrades to a pool-only
    // grant if they leave in between, because by then the money has moved.
    if (targetUserId) {
      const target = await this.prisma.organizationMember.findFirst({
        where: { organizationId: org.id, userId: targetUserId, status: 'active' },
      })
      if (!target) {
        throw new BadRequestException(
          'That person is not an active member of this team. Pick a current member, or buy for the shared pool instead.',
        )
      }
    }

    // Fail before writing anything when the card rail is off, so a refused card
    // purchase never leaves a pending team credit row behind.
    if (method === 'stripe') {
      this.requireStripe()
      return this.createTeamTopupStripeRow(
        adminUserId,
        org,
        credits,
        amountCents,
        targetUserId ?? null,
        pool?.periodEnd ?? sub?.currentPeriodEnd ?? null,
      )
    }
    return this.createTeamTopupKhqrRow(
      adminUserId,
      org,
      credits,
      amountCents,
      method,
      targetUserId ?? null,
      pool?.periodEnd ?? sub?.currentPeriodEnd ?? null,
    )
  }

  /** KHQR rail for team credit top-up. */
  private async createTeamTopupKhqrRow(
    adminUserId: number,
    org: { id: number; slug: string; name: string },
    credits: number,
    amountCents: number,
    method: PaymentMethod,
    targetUserId: number | null,
    creditsExpireAt: Date | null,
  ): Promise<TeamTopupResult> {
    // Refreshing checkout must not mint a second QR. Same intent = same credits,
    // same method AND the same target: "500 for the pool" and "500 for Bob" are
    // different purchases even though they cost the same.
    const existing = await this.prisma.organizationCreditTopup.findFirst({
      where: {
        organizationId: org.id,
        credits,
        targetUserId: targetUserId ?? null,
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing?.paymentId) {
      const reusable = await this.prisma.payment.findFirst({
        where: {
          id: existing.paymentId,
          provider: method,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
      })
      if (reusable?.khqr && reusable.md5) {
        return {
          paymentId: reusable.id,
          topupId: existing.id,
          organizationId: org.id,
          slug: org.slug,
          credits,
          targetUserId,
          amountCents: reusable.amountCents,
          currency: reusable.currency,
          method,
          qr: reusable.khqr,
          md5: reusable.md5,
          expiresAt: reusable.expiresAt,
          creditsExpireAt,
          reused: true,
        }
      }
    }

    const billNumber = `RAYU-ORGTOPUP-${org.id}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(method, amountCents / 100, billNumber)
    const payment = await this.prisma.payment.create({
      data: {
        userId: adminUserId,
        organizationId: org.id,
        provider,
        amountCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    const topup = await this.prisma.organizationCreditTopup.create({
      data: {
        organizationId: org.id,
        purchasedById: adminUserId,
        targetUserId,
        credits,
        amountCents,
        status: 'pending',
        paymentId: payment.id,
        // Recorded at purchase time for the receipt. The enforcement is the
        // period gate plus the reset at renewal, not this column.
        expiresAt: creditsExpireAt,
      },
    })
    this.logger.log(
      `team credit purchase created: org=${org.slug} admin=${adminUserId} credits=${credits} target=${targetUserId ?? 'pool'} amount=${amountCents}c payment=${payment.id}`,
    )
    return {
      paymentId: payment.id,
      topupId: topup.id,
      organizationId: org.id,
      slug: org.slug,
      credits,
      targetUserId,
      amountCents,
      currency: 'USD',
      method,
      qr,
      md5,
      expiresAt: payment.expiresAt,
      creditsExpireAt: topup.expiresAt,
      reused: false,
    }
  }

  /**
   * Card rail for team credit top-up. The 4th checkout flow: same pending
   * `payments` + `organization_credit_topups` pair as the KHQR rail, so the
   * grant path (activateTeamTopup) and the refund path (refundTeamTopup) cannot
   * tell the rails apart. `organizationId` on the payment row is what makes
   * activatePaid route to activateTeamTopup; the linked organization_credit_topups
   * row is what makes it a credit purchase rather than a plan purchase.
   */
  private async createTeamTopupStripeRow(
    adminUserId: number,
    org: { id: number; slug: string; name: string },
    credits: number,
    amountCents: number,
    targetUserId: number | null,
    creditsExpireAt: Date | null,
  ): Promise<TeamTopupResult> {
    const existing = await this.prisma.organizationCreditTopup.findFirst({
      where: {
        organizationId: org.id,
        credits,
        targetUserId: targetUserId ?? null,
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing?.paymentId) {
      const reusable = await this.prisma.payment.findFirst({
        where: {
          id: existing.paymentId,
          provider: 'stripe',
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
      })
      if (reusable?.stripeCheckoutUrl) {
        return {
          paymentId: reusable.id,
          topupId: existing.id,
          organizationId: org.id,
          slug: org.slug,
          credits,
          targetUserId,
          amountCents: reusable.amountCents,
          currency: reusable.currency,
          method: 'stripe',
          checkoutUrl: reusable.stripeCheckoutUrl,
          expiresAt: reusable.expiresAt,
          creditsExpireAt,
          reused: true,
        }
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId: adminUserId,
        organizationId: org.id,
        provider: 'stripe',
        amountCents,
        currency: 'USD',
        status: 'pending',
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    const topup = await this.prisma.organizationCreditTopup.create({
      data: {
        organizationId: org.id,
        purchasedById: adminUserId,
        targetUserId,
        credits,
        amountCents,
        status: 'pending',
        paymentId: payment.id,
        expiresAt: creditsExpireAt,
      },
    })
    const { checkoutUrl } = await this.attachCheckout(payment, {
      productName: `${credits.toLocaleString()} credits (team)`,
      metadata: {
        kind: 'team_topup',
        organizationId: String(org.id),
        userId: String(adminUserId),
        credits: String(credits),
        ...(targetUserId != null ? { targetUserId: String(targetUserId) } : {}),
      },
      customerEmail: await this.billingEmail(adminUserId),
    })
    this.logger.log(
      `team credit purchase created: org=${org.slug} admin=${adminUserId} credits=${credits} target=${targetUserId ?? 'pool'} amount=${amountCents}c payment=${payment.id} (stripe)`,
    )
    return {
      paymentId: payment.id,
      topupId: topup.id,
      organizationId: org.id,
      slug: org.slug,
      credits,
      targetUserId,
      amountCents,
      currency: 'USD',
      method: 'stripe',
      checkoutUrl,
      expiresAt: payment.expiresAt,
      creditsExpireAt: topup.expiresAt,
      reused: false,
    }
  }

  /**
   * Price a plan with an optional promo code WITHOUT creating a payment. Used by
   * the checkout UI to show the discounted total (and whether it becomes free,
   * so it can show a "Claim" button instead of a QR). Throws a clear reason when
   * the code is invalid for this user/plan.
   */
  async previewPromo(userId: number, planCode: PlanCode, code: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }
    const quote = await this.promo.validateForPurchase(
      code,
      planCode,
      userId,
      plan.priceCents,
    )
    return {
      planCode,
      planName: plan.name,
      code: quote.promo.code,
      discountType: quote.promo.discountType,
      discountValue: quote.promo.discountValue,
      originalCents: quote.originalCents,
      discountCents: quote.discountCents,
      finalCents: quote.finalCents,
      currency: 'USD',
      isFree: quote.isFree,
    }
  }

  /**
   * Claim a plan for $0 with a 100%-off (or ≥ price) promo code — no payment.
   * Validates the code makes the plan free, records a $0 'paid' payment, applies
   * the promo redemption, and switches the user's subscription (30-day period),
   * all atomically. Rejects a code that leaves a non-zero balance (must pay via
   * KHQR instead).
   */
  async claimFreePromo(userId: number, planCode: PlanCode, code: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }
    const quote = await this.promo.validateForPurchase(
      code,
      planCode,
      userId,
      plan.priceCents,
    )
    if (!quote.isFree) {
      throw new BadRequestException(
        `This promo code leaves a balance of $${(quote.finalCents / 100).toFixed(2)} — pay with KHQR instead of claiming.`,
      )
    }

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        provider: 'promo',
        amountCents: 0,
        currency: 'USD',
        status: 'paid',
        promoCodeId: quote.promo.id,
        discountCents: quote.discountCents,
        paidAt: new Date(),
        externalRef: `PROMO-${quote.promo.code}`,
      },
    })
    await this.promo.recordPendingRedemption({
      promoCodeId: quote.promo.id,
      userId,
      planCode,
      originalCents: quote.originalCents,
      discountCents: quote.discountCents,
      finalCents: quote.finalCents,
      paymentId: payment.id,
    })
    const carryoverCredits = await this.switchSubscriptionWithCarryover(
      userId,
      plan.id,
      periodEnd,
    )
    // Increment usedCount + mark the redemption applied (atomic cap re-check).
    await this.promo.finalizeRedemption(quote.promo.id, userId, payment.id)

    return {
      paymentId: payment.id,
      status: 'paid' as const,
      planCode,
      amountCents: 0,
      discountCents: quote.discountCents,
      activated: true,
      claimed: true,
      carryoverCredits,
    }
  }

  /**
   * Price a top-up WITHOUT creating a payment — the quote the CLI/dashboard
   * renders before the user commits. Reads `creditsPerDollar` / `minTopupCents`
   * LIVE from AppSettings on every call (AppSettingsService.get() queries the
   * singleton row directly; there is no cache), so an admin rate change on the
   * Plans & Credits page is reflected by the very next quote — no redeploy, no
   * TTL to wait out on this side.
   *
   * `enabled = false` (creditsPerDollar = 0) means the admin has not turned
   * top-up on; the client should hide the top-up UI rather than show a $0 price.
   */
  async getTopupQuote(credits?: number): Promise<TopupQuote> {
    return quoteTopup(await this.settings.get(), credits)
  }

  /**
   * Create a pay-as-you-go top-up on ANY rail. This is the single pricing +
   * row-creation path: ABA, Bakong KHQR and (once integrated) Stripe all come
   * through here, so there is exactly one place that converts credits to money
   * and exactly one place that writes the pending `credit_topups` row.
   *
   * The USD price comes from the admin-configured creditsPerDollar rate (read
   * live, never hardcoded), and the purchase must be worth at least
   * minTopupCents (default $1) — a 5¢ QR is not worth a payment round trip and
   * most wallets refuse trivial amounts. Creates a pending payment + a pending
   * credit_topups row linked by paymentId; the credits are granted when the
   * payment is confirmed (Bakong: checkStatus; ABA: Telegram userbot; Stripe:
   * webhook), all of which funnel into activatePaid.
   */
  async createTopupPayment(
    userId: number,
    credits: number,
    method: CheckoutMethod = 'aba',
  ): Promise<TopupPaymentResult> {
    const amountCents = await this.priceTopup(credits)

    // The card rail shares this pricing path — the amount above is what Stripe
    // charges — but it produces a hosted Checkout URL instead of a QR, so it
    // branches only after every price and eligibility rule has run.
    if (method === 'stripe') {
      return this.createTopupStripeRow(userId, credits, amountCents)
    }

    return this.createTopupKhqrRow(userId, credits, amountCents, method)
  }

  /**
   * The ONE place credits become money for an individual top-up, on every rail.
   *
   * Reads the rate LIVE (AppSettingsService.get() has no cache) so an admin change
   * applies to the very next purchase, and enforces the dollar floor — a 5¢ charge
   * is not worth a payment round trip and most wallets refuse trivial amounts.
   * Extracted so the KHQR alias below can share it without going through the
   * rail-branching return type.
   */
  private async priceTopup(credits: number): Promise<number> {
    const settings = await this.settings.get()
    if (!isTopupEnabled(settings)) {
      throw new BadRequestException('Top-up is not available')
    }
    // Shared math (topup-pricing.ts) — identical to what the quote endpoint and
    // the gateway quote return, so the user is never charged a different price
    // than the one they were shown at the same rate.
    const amountCents = amountCentsFor(credits, settings)
    const minCents = effectiveMinCents(settings)
    if (amountCents < minCents) {
      // Say what to do, in the unit the user chose (credits), not just "too small".
      const minCredits = minCreditsFor(settings)
      throw new BadRequestException(
        `Minimum top-up is $${(minCents / 100).toFixed(2)} (${minCredits.toLocaleString()} credits)`,
      )
    }
    return amountCents
  }

  /**
   * Card rail: mint (or reuse) a hosted Checkout Session and the pending rows.
   *
   * Deliberately the same shape as createTopupKhqrRow — same pending `payments` +
   * `credit_topups` pair, same reuse-on-refresh rule, same 30-minute deadline —
   * so the grant path (activatePaid) cannot tell the rails apart and no rail has
   * its own copy of the grant rules. The only difference in the response is
   * `checkoutUrl` where the KHQR rails return `qr`/`md5`.
   */
  private async createTopupStripeRow(
    userId: number,
    credits: number,
    amountCents: number,
  ) {
    // Fail before writing anything when the rail is off, so a refused card
    // purchase never leaves a pending row or a dangling top-up behind.
    this.requireStripe()

    // Reuse a still-valid pending Checkout Session on refresh (same intent = same
    // credit amount + rail), mirroring the KHQR behaviour. Requires a stored URL:
    // a row whose session creation failed has none and must not be handed back.
    const existingTopup = await this.prisma.creditTopup.findFirst({
      where: { userId, credits, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    if (existingTopup?.paymentId) {
      const reusable = await this.prisma.payment.findFirst({
        where: {
          id: existingTopup.paymentId,
          provider: 'stripe',
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
      })
      if (reusable?.stripeCheckoutUrl) {
        return {
          paymentId: reusable.id,
          credits,
          amountCents: reusable.amountCents,
          currency: reusable.currency,
          method: 'stripe' as const,
          checkoutUrl: reusable.stripeCheckoutUrl,
          expiresAt: reusable.expiresAt,
          reused: true,
        }
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        provider: 'stripe',
        amountCents,
        currency: 'USD',
        status: 'pending',
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    await this.prisma.creditTopup.create({
      data: { userId, credits, amountCents, status: 'pending', paymentId: payment.id },
    })
    const { checkoutUrl } = await this.attachCheckout(payment, {
      productName: `${credits.toLocaleString()} Rayu credits`,
      metadata: { kind: 'topup', userId: String(userId), credits: String(credits) },
      customerEmail: await this.billingEmail(userId),
    })

    return {
      paymentId: payment.id,
      credits,
      amountCents,
      currency: 'USD',
      method: 'stripe' as const,
      checkoutUrl,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /**
   * Back-compat alias for the original KHQR-only entrypoint (POST
   * /payments/topup-khqr and renewPayment both call it). Shares the same pricing
   * helper as the unified path, so there is no second copy of the pricing rules,
   * and returns the KHQR response shape only — callers of this alias render a QR
   * and never a Checkout URL.
   */
  async createTopupKhqr(
    userId: number,
    credits: number,
    method: PaymentMethod = 'aba',
  ) {
    const amountCents = await this.priceTopup(credits)
    return this.createTopupKhqrRow(userId, credits, amountCents, method)
  }

  /** KHQR/ABA rail: mint (or reuse) the QR and the pending rows. */
  private async createTopupKhqrRow(
    userId: number,
    credits: number,
    amountCents: number,
    method: PaymentMethod,
  ) {
    // Reuse a still-valid pending top-up QR on refresh (same intent = same
    // credit amount + method), mirroring the plan-checkout behavior.
    const existingTopup = await this.prisma.creditTopup.findFirst({
      where: { userId, credits, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    if (existingTopup?.paymentId) {
      const reusable = await this.prisma.payment.findFirst({
        where: {
          id: existingTopup.paymentId,
          provider: method,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
      })
      if (reusable?.khqr && reusable.md5) {
        return {
          paymentId: reusable.id,
          credits,
          amountCents: reusable.amountCents,
          currency: reusable.currency,
          method,
          qr: reusable.khqr,
          md5: reusable.md5,
          expiresAt: reusable.expiresAt,
          reused: true,
        }
      }
    }

    const billNumber = `RAYU-TOPUP-${userId}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(
      method,
      amountCents / 100,
      billNumber,
    )

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        provider,
        amountCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    await this.prisma.creditTopup.create({
      data: { userId, credits, amountCents, status: 'pending', paymentId: payment.id },
    })

    return { paymentId: payment.id, credits, amountCents, currency: 'USD', method, qr, md5, expiresAt: payment.expiresAt, reused: false }
  }

  /**
   * Build the QR + md5 + provider for the chosen method.
   * - bakong: dynamic KHQR via the Bakong SDK; md5 is checked against ABA later.
   * - aba: dynamic KHQR derived from the static ABA merchant QR. There is no API
   *   to poll, so we mark the row with provider='aba' and an `ABA-` md5 sentinel;
   *   confirmation arrives out-of-band via the Telegram credit-alert listener.
   */
  private buildQr(
    method: PaymentMethod,
    amountUsd: number,
    billNumber: string,
  ): { qr: string; md5: string; provider: PaymentMethod } {
    if (method === 'aba') {
      const qr = this.aba.generateAbaQR(amountUsd, KHQR_TTL_MINUTES)
      return { qr, md5: `ABA-${randomUUID()}`, provider: 'aba' }
    }
    const { qr, md5 } = this.bakong.generateKhqr(amountUsd, billNumber, KHQR_TTL_MS)
    return { qr, md5, provider: 'bakong' }
  }

  /**
   * Card rail counterpart to buildQr: turn an already-priced purchase into a
   * hosted Stripe Checkout Session and stamp it onto the payment row.
   *
   * The payment row is created by the caller FIRST and updated here, because the
   * row's id is what the session's metadata and idempotency key are built from —
   * and the idempotency key is what stops a retried create from minting a second
   * session the buyer could also pay. A row whose session creation failed keeps a
   * NULL stripeCheckoutUrl, and every reuse check requires that column to be set,
   * so an orphan is never handed to a buyer; it simply expires on the normal
   * 30-minute clock. This mirrors how the KHQR paths require `khqr && md5`.
   */
  private async attachCheckout(
    payment: Payment,
    args: {
      productName: string
      productDescription?: string
      metadata: Record<string, string>
      customerEmail?: string | null
    },
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const stripe = this.requireStripe()
    const session = await stripe.createCheckoutSession({
      amountCents: payment.amountCents,
      productName: args.productName,
      ...(args.productDescription
        ? { productDescription: args.productDescription }
        : {}),
      successUrl: stripe.successUrl,
      cancelUrl: stripe.cancelUrl,
      expiresAt: new Date(Date.now() + STRIPE_SESSION_TTL_MS),
      metadata: { ...args.metadata, paymentId: String(payment.id) },
      clientReferenceId: `rayu-payment-${payment.id}`,
      ...(args.customerEmail ? { customerEmail: args.customerEmail } : {}),
      // Derived from the payment row, so our own retry of this call reuses the
      // session Stripe already made instead of creating a second payable one.
      idempotencyKey: `rayu-payment-${payment.id}`,
    })
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        stripeCheckoutSessionId: session.id,
        stripeCheckoutUrl: session.url,
        stripePaymentIntentId: session.paymentIntentId,
      },
    })
    return { checkoutUrl: session.url, sessionId: session.id }
  }

  /** The buyer's email, so Stripe can prefill it. Never fatal if unavailable. */
  private async billingEmail(userId: number): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    })
    return user?.email ?? null
  }

  async checkStatus(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()

    if (payment.status !== 'pending') {
      return {
        paymentId: payment.id,
        status: payment.status,
        planCode: payment.plan?.code ?? null,
        activated: payment.status === 'paid',
        expiresAt: payment.expiresAt,
      }
    }

    // Bakong can be polled: give a just-in-time payment a final chance to land
    // before we expire the row, so a payment made right at the deadline still
    // activates instead of being lost. (ABA has no poll API — the Telegram
    // credit-alert listener flips the row; here we just report pending/expired.)
    if (!this.isAba(payment)) {
      const { paid, ref } = await this.bakong.checkPaidByMd5(payment.md5!)
      if (paid) return this.activatePaid(payment, ref ?? null)
    }

    // Past the 30-minute deadline and still unpaid → transition to 'expired' so
    // the client can prompt the user to generate a fresh QR (renew).
    if (this.isExpired(payment)) {
      return this.expirePayment(payment)
    }

    return {
      paymentId: payment.id,
      status: 'pending',
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /** True once the payment's 30-minute QR deadline has passed. */
  private isExpired(payment: Payment): boolean {
    return payment.expiresAt != null && payment.expiresAt.getTime() <= Date.now()
  }

  /**
   * Transition a stale pending payment (and any linked pending top-up) to
   * 'expired'. Shares the checkStatus response shape.
   */
  private async expirePayment(payment: Payment & { plan: Plan | null }) {
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'expired' },
      }),
      this.prisma.creditTopup.updateMany({
        where: { paymentId: payment.id, status: 'pending' },
        data: { status: 'expired' },
      }),
      // A team credit purchase whose QR was never paid must not stay 'pending'
      // forever: the create path reuses a pending row, so a stale one would keep
      // handing back a dead QR instead of minting a fresh one.
      this.prisma.organizationCreditTopup.updateMany({
        where: { paymentId: payment.id, status: 'pending' },
        data: { status: 'expired' },
      }),
    ])
    // Free the reserved promo slot so the code can be used again.
    if (payment.promoCodeId) {
      await this.promo.cancelPendingRedemption(payment.promoCodeId, payment.userId)
    }
    return {
      paymentId: payment.id,
      status: 'expired' as const,
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /**
   * Confirm an ABA payment from a Telegram credit alert. ABA's alert carries the
   * amount + trx id but not our payment id, so we match the most recent pending
   * ABA payment with the exact amount that has not expired beyond the grace
   * window (QR lifetime + a short lag allowance for the alert to post).
   * Returns true if a matching payment was found and activated.
   */
  async confirmAbaPaymentByAmount(
    amountUsd: number,
    ref?: string | null,
  ): Promise<boolean> {
    const amountCents = Math.round(amountUsd * 100)
    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: 'aba',
        status: 'pending',
        amountCents,
        expiresAt: { gte: new Date(Date.now() - ABA_MATCH_GRACE_MS) },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!payment) return false
    await this.activatePaid(payment, ref ?? null)
    return true
  }

  private isAba(payment: Payment): boolean {
    return payment.provider === 'aba' || (payment.md5?.startsWith('ABA-') ?? false)
  }

  /**
   * Confirm a Stripe payment from a verified `checkout.session.completed` (or
   * `async_payment_succeeded`) webhook. The card rail's ONE narrow entrypoint into
   * the shared grant path — the exact counterpart of confirmAbaPaymentByAmount for
   * ABA and checkStatus for Bakong — so no rail owns a copy of the grant rules.
   *
   * Looked up by session id rather than our payment id because that is what the
   * event carries, and the column is UNIQUE so a replay can never be attributed to
   * a different row.
   *
   * REVIVE: a row that already went 'expired' (or that the user canceled) is put
   * back to 'pending' before granting. This is not leniency, it is correctness —
   * Stripe's hosted page outlives our 30-minute deadline by a few minutes, and a
   * completed session means the money moved. Refusing to grant would be keeping
   * payment without delivering credits. The KHQR rails already work this way: ABA
   * has a 10-minute out-of-band grace window and Bakong gets a last-chance poll
   * before expiry. 'refunded' is deliberately NOT revived — that reversal was
   * intentional and re-granting would undo it.
   */
  async confirmStripeCheckout(sessionId: string, ref: string | null) {
    const payment = await this.prisma.payment.findUnique({
      where: { stripeCheckoutSessionId: sessionId },
      include: { plan: true },
    })
    if (!payment) {
      throw new NotFoundException(
        `No payment found for Stripe Checkout Session ${sessionId}`,
      )
    }
    if (payment.status === 'refunded') {
      this.logger.warn(
        `stripe completion for a refunded payment ignored: payment=${payment.id} session=${sessionId}`,
      )
      return {
        paymentId: payment.id,
        status: 'refunded' as const,
        planCode: payment.plan?.code ?? null,
        activated: false,
      }
    }
    if (payment.status === 'expired' || payment.status === 'canceled') {
      await this.revivePayment(payment)
    }
    return this.activatePaid(payment, ref)
  }

  /**
   * Put a given-up-on payment (and its linked pending purchase rows) back to
   * 'pending' so the shared grant path can run. Guarded on the exact status we
   * observed, so two concurrent webhook deliveries cannot both revive — and even
   * if they did, activatePaid's own pending->paid guard still grants once.
   */
  private async revivePayment(payment: Payment): Promise<void> {
    const from = payment.status
    await this.prisma.$transaction([
      this.prisma.payment.updateMany({
        where: { id: payment.id, status: from },
        data: { status: 'pending' },
      }),
      this.prisma.creditTopup.updateMany({
        where: { paymentId: payment.id, status: from },
        data: { status: 'pending' },
      }),
      this.prisma.organizationCreditTopup.updateMany({
        where: { paymentId: payment.id, status: from },
        data: { status: 'pending' },
      }),
    ])
    this.logger.warn(
      `revived ${from} payment on Stripe completion: payment=${payment.id} (buyer paid after Rayu's deadline)`,
    )
  }

  /**
   * Expire a Stripe Checkout Session that was abandoned or failed — the
   * counterpart of confirmStripeCheckout for the `checkout.session.expired` and
   * `checkout.session.async_payment_failed` events.
   *
   * Looks the row up by session id and reuses the existing expirePayment path so
   * the side effects are identical to a KHQR timing out: the payment row goes
   * 'expired', the linked pending top-up / team credit top-up goes 'expired',
   * and the reserved promo slot is freed. No-op (and still 200) when the row is
   * already in a terminal status (paid/expired/canceled/refunded) — Stripe
   * delivers checkout.session.expired for sessions that were already completed
   * too, and those must not be flipped out of 'paid'.
   */
  async expireStripeCheckout(sessionId: string): Promise<{ paymentId: number | null; status: string }> {
    const payment = await this.prisma.payment.findUnique({
      where: { stripeCheckoutSessionId: sessionId },
      include: { plan: true },
    })
    if (!payment) {
      // No row for this session — nothing to expire. Return a benign status so
      // the webhook answers 200 (a session that never got a row is already as
      // expired as it can be).
      return { paymentId: null, status: 'unknown' }
    }
    if (payment.status !== 'pending') {
      return { paymentId: payment.id, status: payment.status }
    }
    // Reuse the existing expire path: it writes the row, the linked top-ups and
    // frees the promo slot, all in one transaction.
    const res = await this.expirePayment(payment)
    return { paymentId: res.paymentId, status: res.status }
  }

  /**
   * Handle a `charge.refunded` event. The ONE refund dispatcher — branches on
   * what the refunded payment was for, the same way activatePaid branches on
   * grant kind. Every branch is idempotent (guarded on status='paid'/'pending'
   * as appropriate) so an out-of-order or replayed refund event is safe.
   *
   * Order independence: Stripe does NOT guarantee event ordering, so a
   * refund event can land BEFORE the matching checkout.session.completed. In
   * that case the payment is still 'pending' (or 'expired') and the refund
   * branches are all no-ops (refundTopup / refundTeamTopup guard on
   * status='paid'; the individual/team plan cancels guard on an ACTIVE
   * subscription that this payment activated). The completion event will
   * arrive later and grant normally — at which point the refund has already
   * been recorded, and a support-led reversal is the correct follow-up. We do
   * NOT attempt to "remember" a refund that arrived early and re-apply it
   * after a late completion: that would be a second source of truth for
   * refunds and would race with manual admin action.
   *
   * Deliberately NOT reversed (documented per branch): already-minted carry-over
   * credits, already-spent credits, and no proration. See cancelSubscription
   * and refundTopup for the per-branch rationale.
   */
  async handleChargeRefunded(paymentId: number, ref: string | null): Promise<{ paymentId: number; handled: string }> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) {
      throw new NotFoundException(`No payment found for refund (paymentId=${paymentId})`)
    }

    // Branch on the SAME shapes activatePaid uses to route the grant.
    const topup = await this.prisma.creditTopup.findFirst({ where: { paymentId } })
    if (topup) {
      await this.refundTopup(paymentId, ref)
      return { paymentId, handled: 'topup' }
    }

    const orgTopup = payment.organizationId
      ? await this.prisma.organizationCreditTopup.findFirst({ where: { paymentId } })
      : null
    if (orgTopup) {
      await this.refundTeamTopup(paymentId, ref)
      return { paymentId, handled: 'team_topup' }
    }

    // Plan purchases (individual or team) — a planId is set and there is no
    // credit-topup row.
    if (payment.organizationId) {
      // Team plan: cancel the team's subscription and zero the pool. The
      // OrganizationsService method is idempotent.
      await this.requireOrgs().cancelSubscription(payment.organizationId)
      return { paymentId, handled: 'team_plan' }
    }

    if (payment.planId) {
      await this.cancelIndividualPlanOnRefund(payment)
      return { paymentId, handled: 'individual_plan' }
    }

    // A row with no topup, no plan and no org — nothing to reverse. Log and
    // treat as handled so the webhook answers 200.
    this.logger.warn(
      `refund for payment ${paymentId} has nothing to reverse (no topup, no plan) — ignoring`,
    )
    return { paymentId, handled: 'nothing' }
  }

  /**
   * Guarded individual plan refund: cancel the user's active subscription ONLY
   * when it is the one this payment activated. Two conditions, both required:
   *  - the active subscription's planId matches the refunded payment's planId
   *    (a refund of a Pro purchase must not cancel a Pro Plus the user later
   *    bought — that would be reversing a different purchase);
   *  - the active subscription's startedAt is NOT earlier than the payment's
   *    paidAt (the activation started this period; if it started BEFORE this
   *    payment was paid, this payment did not start it and we leave it alone).
   *
   * When the guard fails we log at warn and leave the subscription active — a
   * refund of a superseded purchase is support's to handle, not an automated
   * cancel. The refund itself is already recorded on the payment row's status
   * (set to 'refunded' below) so the audit trail is intact either way.
   */
  private async cancelIndividualPlanOnRefund(payment: Payment & { plan: Plan | null }): Promise<void> {
    // Mark the payment refunded for the audit trail regardless of whether the
    // subscription is canceled. Idempotent: updateMany guards on status='paid'.
    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'paid' },
      data: { status: 'refunded' },
    })

    const active = await this.prisma.subscription.findFirst({
      where: { userId: payment.userId, status: 'active' },
      orderBy: { startedAt: 'desc' },
    })
    if (!active) {
      this.logger.warn(
        `refund of payment ${payment.id}: user ${payment.userId} has no active subscription — nothing to cancel`,
      )
      return
    }
    if (active.planId !== payment.planId) {
      this.logger.warn(
        `refund of payment ${payment.id} (plan ${payment.planId}) not canceling subscription ${active.id}: active plan is ${active.planId} (a different purchase). Refund recorded; subscription left active.`,
      )
      return
    }
    if (payment.paidAt && active.startedAt < payment.paidAt) {
      this.logger.warn(
        `refund of payment ${payment.id} not canceling subscription ${active.id}: it started ${active.startedAt.toISOString()} BEFORE this payment was paid ${payment.paidAt.toISOString()} (not the one this payment activated). Refund recorded; subscription left active.`,
      )
      return
    }
    await this.prisma.subscription.update({
      where: { id: active.id },
      data: { status: 'canceled' },
    })
    this.logger.warn(
      `individual plan refunded: payment=${payment.id} user=${payment.userId} plan=${payment.plan?.code ?? payment.planId} subscription=${active.id} canceled`,
    )
  }

  /**
   * Mark a confirmed payment as paid and apply its effect: either grant the
   * linked credit top-up, or switch the user's subscription (30-day period).
   * Shared by the Bakong poll path and the ABA Telegram listener (and, once it
   * lands, the Stripe webhook) — the SINGLE grant entrypoint, so no rail has its
   * own copy of the grant rules.
   * Idempotent: if the payment is already paid, returns the active state without
   * creating duplicate subscriptions or carry-over top-ups.
   */
  private async activatePaid(payment: Payment & { plan: Plan | null }, ref: string | null) {
    const topup = await this.prisma.creditTopup.findFirst({
      where: { paymentId: payment.id },
    })
    if (topup) {
      // THE GRANT. Flipping credit_topups.status pending -> 'paid' IS the credit
      // grant, and it is what makes the credits visible to the gateway with no
      // backend round trip: both balance readers — UsersService.getTopupBalance
      // and the gateway's store.TopupBalance — compute
      //   SUM(credit_topups.credits WHERE status='paid')
      //     - SUM(credit_ledger.credits WHERE source='topup')
      // so the paid row is the granted side and credit_ledger source='topup'
      // rows are the CONSUMPTION side (written by the gateway as the user
      // spends). That is why NO positive credit_ledger row is written here: it
      // would be read as consumption and cancel the grant it was meant to
      // record. The purchase's audit trail is the credit_topups row itself
      // (credits + amountCents + paymentId + createdAt).
      //
      // Idempotency contract: the updateMany guards on status='pending', so
      // exactly ONE concurrent caller flips the row and gets count === 1. Every
      // other caller sees count === 0 and returns the already-activated state
      // WITHOUT granting again. Do not weaken this to an update()/upsert().
      //
      // Gateway visibility: the limiter mirrors the MySQL balance into Redis via
      // EnsureTopup (SetNX, 5-minute TTL), so a fresh grant is spendable within
      // at most that TTL; GET /v1/credits reports the authoritative MySQL value
      // immediately.
      const [updated] = await this.prisma.$transaction([
        this.prisma.payment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: { status: 'paid', paidAt: new Date(), externalRef: ref },
        }),
        this.prisma.creditTopup.updateMany({
          where: { id: topup.id, status: 'pending' },
          data: { status: 'paid' },
        }),
      ])
      if ((updated as { count: number }).count === 0) {
        // Already activated by another concurrent caller; return current state.
        return {
          paymentId: payment.id,
          status: 'paid' as const,
          kind: 'topup' as const,
          credits: topup.credits,
          activated: true,
          granted: false,
        }
      }
      return {
        paymentId: payment.id,
        status: 'paid',
        kind: 'topup' as const,
        credits: topup.credits,
        activated: true,
        granted: true,
      }
    }

    if (!payment.planId || !payment.plan) {
      // A team CREDIT purchase has an organizationId but no plan — that is the
      // shape that distinguishes it from team plan checkout. Checked before the
      // "no plan" error below, because for this kind of payment a missing plan is
      // correct rather than a broken row.
      const orgTopup = payment.organizationId
        ? await this.prisma.organizationCreditTopup.findFirst({
            where: { paymentId: payment.id },
          })
        : null
      if (orgTopup) return this.activateTeamTopup(payment, orgTopup, ref)
      throw new BadRequestException('Payment has no associated plan')
    }

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    // --- TEAM purchase -------------------------------------------------------
    // organizationId on the payment is the whole switch: the money buys an
    // ORG-owned subscription and seeds the team's shared credit pool, and the
    // paying admin's OWN subscription is left exactly as it was (they may hold a
    // personal plan alongside their team seat). Same pending -> paid idempotency
    // guard as the individual path, so a duplicate poll/alert cannot seed the
    // pool twice.
    if (payment.organizationId) {
      const [updated] = await this.prisma.$transaction([
        this.prisma.payment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: { status: 'paid', paidAt: new Date(), externalRef: ref },
        }),
      ])
      if ((updated as { count: number }).count === 0) {
        return {
          paymentId: payment.id,
          status: 'paid' as const,
          kind: 'team' as const,
          organizationId: payment.organizationId,
          planCode: payment.plan.code,
          activated: true,
        }
      }
      const seeded = await this.requireOrgs().activateSubscription(
        payment.organizationId,
        payment.plan,
        periodEnd,
      )
      return {
        paymentId: payment.id,
        status: 'paid' as const,
        kind: 'team' as const,
        organizationId: payment.organizationId,
        planCode: payment.plan.code,
        activated: true,
        poolCredits: seeded.totalCredits,
        members: seeded.members,
        periodEnd,
      }
    }

    // Idempotent paid transition for plan purchases: only one caller wins the
    // pending -> paid status flip. Losers see count===0 and return the already-
    // activated state without duplicating subscriptions or carry-over credits.
    const [updated] = await this.prisma.$transaction([
      this.prisma.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'paid', paidAt: new Date(), externalRef: ref },
      }),
    ])
    if ((updated as { count: number }).count === 0) {
      return {
        paymentId: payment.id,
        status: 'paid' as const,
        planCode: payment.plan?.code ?? null,
        activated: true,
      }
    }

    const carryoverCredits = await this.switchSubscriptionWithCarryover(
      payment.userId,
      payment.planId,
      periodEnd,
    )

    // Finalize a promo redemption (increment usedCount, mark applied) when this
    // purchase used a discount code.
    if (payment.promoCodeId) {
      await this.promo.finalizeRedemption(
        payment.promoCodeId,
        payment.userId,
        payment.id,
      )
    }

    return {
      paymentId: payment.id,
      status: 'paid' as const,
      planCode: payment.plan?.code ?? null,
      activated: true,
      carryoverCredits,
    }
  }

  /**
   * Grant a confirmed TEAM credit purchase. Reached from activatePaid, so every
   * rail (Bakong poll, ABA alert, future Stripe webhook) lands here.
   *
   * Uses an INTERACTIVE transaction rather than the array form the other branches
   * use, and that is deliberate: the pending guard has to decide whether the
   * increment happens AT ALL. An array transaction runs every statement it is
   * given, so a losing concurrent caller would flip nothing but still raise the
   * pool — minting credits nobody paid for. Here the guard and the increment are
   * in one transaction, and the increment is skipped when the guard loses.
   *
   * The member-bucket half of the grant happens AFTER the transaction, through
   * OrganizationsService, because it is allowed to degrade (a target who left the
   * team) and must never roll back money that has already been taken.
   */
  private async activateTeamTopup(
    payment: Payment,
    topup: { id: number; credits: number; targetUserId: number | null },
    ref: string | null,
  ) {
    const organizationId = payment.organizationId as number
    const granted = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.organizationCreditTopup.updateMany({
        where: { id: topup.id, status: 'pending' },
        data: { status: 'paid' },
      })
      if (flipped.count === 0) return false
      await tx.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'paid', paidAt: new Date(), externalRef: ref },
      })
      return true
    })

    if (!granted) {
      // Another confirmation already granted this purchase. Report the paid state
      // without touching the pool a second time.
      return {
        paymentId: payment.id,
        status: 'paid' as const,
        kind: 'team_topup' as const,
        organizationId,
        credits: topup.credits,
        targetUserId: topup.targetUserId,
        activated: true,
        granted: false,
      }
    }

    const result = await this.requireOrgs().grantExtraCredits(
      organizationId,
      topup.credits,
      topup.targetUserId,
    )
    if (result.targetMissing) {
      // Record it against the purchase so support (and the dashboard) can explain
      // why Bob's quota did not move.
      await this.prisma.organizationCreditTopup.update({
        where: { id: topup.id },
        data: { targetUserId: null },
      })
    }
    this.logger.log(
      `team credits paid: org=${organizationId} payment=${payment.id} credits=${topup.credits} target=${result.targetUserId ?? 'pool'} extra=${result.extraCredits}`,
    )
    return {
      paymentId: payment.id,
      status: 'paid' as const,
      kind: 'team_topup' as const,
      organizationId,
      credits: topup.credits,
      targetUserId: result.targetUserId,
      targetMissing: result.targetMissing,
      extraCredits: result.extraCredits,
      poolRemaining: result.poolRemaining,
      creditsExpireAt: result.periodEnd,
      activated: true,
      granted: true,
    }
  }

  /**
   * Claw back a refunded TEAM credit purchase. Mirrors refundTopup, but the
   * clawback is a real decrement rather than a row dropping out of a SUM: the
   * team's spendable number is a COLUMN (credit_pools.extra_credits), so the
   * credits have to be taken back out of it explicitly.
   *
   * Floored at 0, and the floor matters: if the team has already spent what was
   * bought, the pool cannot go negative and quietly eat the plan's own allowance.
   * Idempotent through the same status='paid' guard, so a replayed refund event
   * writes nothing.
   */
  async refundTeamTopup(paymentId: number, ref?: string | null) {
    const topup = await this.prisma.organizationCreditTopup.findFirst({
      where: { paymentId },
    })
    if (!topup) {
      throw new NotFoundException('Team credit purchase not found for this payment')
    }
    const clawedBack = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.organizationCreditTopup.updateMany({
        where: { id: topup.id, status: 'paid' },
        data: { status: 'refunded' },
      })
      if (flipped.count === 0) return false
      await tx.payment.updateMany({
        where: { id: paymentId, status: 'paid' },
        data: { status: 'refunded', externalRef: ref ?? undefined },
      })
      const pool = await tx.creditPool.findUnique({
        where: { organizationId: topup.organizationId },
      })
      if (pool) {
        await tx.creditPool.update({
          where: { organizationId: topup.organizationId },
          data: { extraCredits: Math.max(0, pool.extraCredits - topup.credits) },
        })
      }
      return true
    })
    if (clawedBack) {
      this.logger.warn(
        `team credits refunded: org=${topup.organizationId} payment=${paymentId} credits=${topup.credits}`,
      )
    }
    return {
      paymentId,
      organizationId: topup.organizationId,
      credits: topup.credits,
      status: 'refunded' as const,
      clawedBack,
    }
  }

  /**
   * Claw back a REFUNDED top-up (Stripe `charge.refunded`, an ABA reversal, or
   * an admin correction). The mirror image of the grant:   *
   *  - The clawback itself flips credit_topups.status 'paid' -> 'refunded', which
   *    drops those credits out of the granted SUM that both balance readers use.
   *    That is what makes the clawback visible to the gateway — the same single
   *    column the grant used, so there is no second write path to keep in sync.
   *  - A credit_ledger row with source='refund' is written as the AUDIT trail.
   *    It is deliberately not source='topup': that value means "consumed from
   *    the top-up balance" to both readers, so reusing it would subtract the
   *    credits a SECOND time.
   *
   * Never goes negative: both readers clamp the balance at 0, so clawing back
   * credits the user has already spent leaves them at 0 rather than in debt.
   * Idempotent: the updateMany guards on status='paid', so a replayed refund
   * event finds count === 0 and writes nothing.
   */
  async refundTopup(paymentId: number, ref?: string | null) {
    const topup = await this.prisma.creditTopup.findFirst({
      where: { paymentId },
    })
    if (!topup) throw new NotFoundException('Top-up not found for this payment')

    const [updated] = await this.prisma.$transaction([
      this.prisma.creditTopup.updateMany({
        where: { id: topup.id, status: 'paid' },
        data: { status: 'refunded' },
      }),
      this.prisma.payment.updateMany({
        where: { id: paymentId, status: 'paid' },
        data: { status: 'refunded', externalRef: ref ?? undefined },
      }),
    ])
    const clawedBack = (updated as { count: number }).count > 0
    if (clawedBack) {
      // Audit only — see REFUND_LEDGER_SOURCE. modelCode is not a model here, so
      // it carries the reason instead of an empty string (the column is required).
      await this.prisma.creditLedger.create({
        data: {
          userId: topup.userId,
          modelCode: 'topup-refund',
          credits: topup.credits,
          source: REFUND_LEDGER_SOURCE,
        },
      })
    }
    // Report the balance AFTER the clawback so a caller can log/verify the clamp.
    const balance = await this.users.getTopupBalance(topup.userId)
    return {
      paymentId,
      topupId: topup.id,
      status: 'refunded' as const,
      credits: topup.credits,
      clawedBack,
      topupBalance: balance,
    }
  }

  /**
   * User-initiated cancel of a pending payment (the "Cancel" button on the
   * checkout screen). Marks it — and any linked pending top-up — 'canceled' so
   * it is no longer reused on refresh, polled, or ABA-alert matched, freeing the
   * user to start a fresh purchase. Rejects canceling an already-paid payment.
   */
  async cancelPayment(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()
    if (payment.status === 'paid') {
      throw new BadRequestException('Payment already completed')
    }
    if (payment.status === 'pending') {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'canceled' },
        }),
        this.prisma.creditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'canceled' },
        }),
        // Same for a team credit purchase, so the admin can immediately start a
        // fresh one instead of being handed back the QR they just abandoned.
        this.prisma.organizationCreditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'canceled' },
        }),
      ])
      // Free the reserved promo slot so the code can be used again.
      if (payment.promoCodeId) {
        await this.promo.cancelPendingRedemption(
          payment.promoCodeId,
          payment.userId,
        )
      }
    }
    return {
      paymentId: payment.id,
      status:
        payment.status === 'pending' ? ('canceled' as const) : payment.status,
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /**
   * Regenerate a fresh KHQR for an unpaid payment whose QR has expired (or is
   * still pending). The old row (and any linked pending top-up) is marked
   * 'expired', and a brand-new payment for the SAME intent — same plan or same
   * top-up credit amount, same provider — is created with a new QR and a fresh
   * 30-minute deadline. Rejects a payment that is already paid.
   */
  async renewPayment(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()
    if (payment.status === 'paid') {
      throw new BadRequestException('Payment already completed')
    }

    const topup = await this.prisma.creditTopup.findFirst({
      where: { paymentId: payment.id },
    })
    // A team credit purchase is renewable too — same intent (org, credits,
    // target), fresh QR. Without this branch it would fall through to "cannot
    // renew" and the admin would have to rebuild the purchase by hand.
    const orgTopup = payment.organizationId
      ? await this.prisma.organizationCreditTopup.findFirst({
          where: { paymentId: payment.id },
        })
      : null

    // Expire the old row (+ its pending top-up) so it can no longer be polled
    // or alert-matched to 'paid'. Idempotent when it is already 'expired'.
    if (payment.status === 'pending') {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'expired' },
        }),
        this.prisma.creditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'expired' },
        }),
        this.prisma.organizationCreditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'expired' },
        }),
      ])
    }

    // Preserve the original rail on renewal: a Stripe purchase re-mints a
    // Checkout Session, a KHQR purchase re-mints a QR. Detected from the row's
    // provider rather than passed in, so a renew call cannot accidentally
    // downgrade a card purchase to a QR (or vice versa).
    const method: CheckoutMethod =
      payment.provider === 'stripe'
        ? 'stripe'
        : payment.provider === 'bakong'
          ? 'bakong'
          : 'aba'

    if (topup) {
      // Routed through createTopupPayment (not the KHQR-only alias) so a stripe
      // renewal re-mints a Checkout Session rather than falling back to a QR.
      return this.createTopupPayment(userId, topup.credits, method)
    }
    if (orgTopup) {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgTopup.organizationId },
        select: { slug: true },
      })
      if (!org) throw new NotFoundException('Team not found')
      // Goes through the normal create path, so eligibility is re-checked: a team
      // whose plan lapsed while the QR sat unpaid is refused here rather than
      // handed a QR for credits it could not use.
      return this.createTeamTopup(
        userId,
        org.slug,
        orgTopup.credits,
        method,
        orgTopup.targetUserId,
      )
    }
    if (payment.plan) {
      return this.createKhqr(userId, payment.plan.code as PlanCode, method)
    }
    throw new BadRequestException('Cannot renew this payment')
  }

  async getUserPayments(userId: number, page: number, pageSize: number) {
    const skip = (page - 1) * pageSize
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId },
        include: { plan: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.payment.count({ where: { userId } }),
    ])
    return {
      items: items.map((p) => ({
        id: p.id,
        planCode: p.plan?.code ?? null,
        provider: p.provider,
        amountCents: p.amountCents,
        currency: p.currency,
        status: p.status,
        externalRef: p.externalRef,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      })),
      total,
      page,
      pageSize,
    }
  }
}
