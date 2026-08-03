/**
 * Pay-as-you-go top-up pricing — the SINGLE source of truth for the
 * credit <-> cents conversion, shared by every payment rail (ABA, Bakong KHQR,
 * Stripe) and by the quote endpoint the CLI/dashboard price against.
 *
 * NOTHING here hardcodes a price. Every function takes the live
 * `AppSettings.creditsPerDollar` / `minTopupCents` (admin-editable on the Plans
 * & Credits page) as input, so changing the rate in the dashboard re-prices
 * every rail immediately with no code change and no redeploy. The only constant
 * in this file is TOPUP_MAX_CREDITS, an anti-abuse *validation* bound on a
 * single purchase — not a price.
 */

/**
 * Hard ceiling on one purchase's credit amount. A validation bound (matches
 * CreateTopupDto's @Max) so a typo can't mint a $1M QR, NOT a pricing input.
 */
export const TOPUP_MAX_CREDITS = 100_000_000

/** The pricing inputs read live from AppSettings. */
export interface TopupPricingSettings {
  /** How many credits one US dollar buys. 0 = top-up unavailable. */
  creditsPerDollar: number
  /** Smallest purchase allowed, in cents (default 100 = $1). */
  minTopupCents: number
}

/** A priced top-up, as returned by the quote endpoint. */
export interface TopupQuote {
  /** Top-up is available at all — i.e. the admin set creditsPerDollar > 0. */
  enabled: boolean
  /** The credit amount this quote prices (clamped to [minCredits, maxCredits]). */
  credits: number
  /** What those credits cost, in cents. 0 when disabled. */
  amountCents: number
  currency: 'USD'
  /** Smallest purchasable credit amount at the current rate. */
  minCredits: number
  /** Largest purchasable credit amount (validation bound). */
  maxCredits: number
  /** The live rate this quote used (echoed so a client never assumes one). */
  rateCreditsPerDollar: number
  /** The live dollar floor this quote used, in cents. */
  minTopupCents: number
  /**
   * Whether `credits` as requested already met the dollar floor. False means the
   * request was raised to `minCredits`, so a UI can explain the bump instead of
   * silently charging more than the user asked for.
   */
  meetsMinimum: boolean
}

/** Top-up is available only when the admin has set a positive rate. */
export function isTopupEnabled(settings: TopupPricingSettings): boolean {
  return Number.isFinite(settings.creditsPerDollar) && settings.creditsPerDollar > 0
}

/**
 * The dollar floor in cents. `minTopupCents` is clamped to at least 1¢ because a
 * free "purchase" has no payment to confirm — a 0¢ QR would sit pending forever.
 */
export function effectiveMinCents(settings: TopupPricingSettings): number {
  return Math.max(1, Math.trunc(settings.minTopupCents))
}

/**
 * Price a credit amount in cents. Rounds UP so a buyer never receives credits
 * that were not paid for (the pre-existing createTopupKhqr behaviour, kept
 * verbatim so no rail diverges from the price the user was quoted).
 */
export function amountCentsFor(
  credits: number,
  settings: TopupPricingSettings,
): number {
  if (!isTopupEnabled(settings)) return 0
  return Math.ceil((credits / settings.creditsPerDollar) * 100)
}

/**
 * The smallest credit amount that satisfies the `minTopupCents` dollar floor at
 * the CURRENT rate. Derived, never cached: the floor is stored in cents while
 * the UI's input is in credits, so this MUST be recomputed on every quote —
 * caching it across a rate change would quote a stale minimum.
 */
export function minCreditsFor(settings: TopupPricingSettings): number {
  if (!isTopupEnabled(settings)) return 0
  return Math.ceil((effectiveMinCents(settings) / 100) * settings.creditsPerDollar)
}

/**
 * Build a quote for `credits` at the live rate. A requested amount below the
 * dollar floor is raised to `minCredits` (and flagged via `meetsMinimum`) rather
 * than rejected, so the quote endpoint can always answer with a payable price;
 * the CREATE path still rejects a below-floor request outright (see
 * PaymentsService.createTopupPayment) because that charges real money.
 *
 * When top-up is disabled (creditsPerDollar = 0) every derived number is 0 and
 * `enabled` is false — the client's cue to hide the top-up UI entirely.
 */
export function quoteTopup(
  settings: TopupPricingSettings,
  requestedCredits?: number,
): TopupQuote {
  const enabled = isTopupEnabled(settings)
  const minTopupCents = effectiveMinCents(settings)
  const minCredits = minCreditsFor(settings)

  if (!enabled) {
    return {
      enabled: false,
      credits: 0,
      amountCents: 0,
      currency: 'USD',
      minCredits: 0,
      maxCredits: TOPUP_MAX_CREDITS,
      rateCreditsPerDollar: 0,
      minTopupCents,
      meetsMinimum: false,
    }
  }

  // Default to the cheapest payable purchase so a client can render a price
  // without having to guess an amount first.
  const asked =
    requestedCredits == null || !Number.isFinite(requestedCredits)
      ? minCredits
      : Math.trunc(requestedCredits)
  const meetsMinimum = asked >= minCredits
  const credits = Math.min(TOPUP_MAX_CREDITS, Math.max(minCredits, asked))

  return {
    enabled: true,
    credits,
    amountCents: amountCentsFor(credits, settings),
    currency: 'USD',
    minCredits,
    maxCredits: TOPUP_MAX_CREDITS,
    rateCreditsPerDollar: settings.creditsPerDollar,
    minTopupCents,
    meetsMinimum,
  }
}
