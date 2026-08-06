import {
  TOPUP_MAX_CREDITS,
  amountCentsFor,
  effectiveMinCents,
  isTopupEnabled,
  minCreditsFor,
  quoteTopup,
} from './topup-pricing'

// Every case here feeds the rate in as DATA. If any of these could pass with a
// rate baked into the module, the module would be hardcoding a price.
describe('topup-pricing', () => {
  describe('isTopupEnabled', () => {
    it('is off at rate 0 — the admin has not turned top-up on', () => {
      expect(isTopupEnabled({ creditsPerDollar: 0, minTopupCents: 100 })).toBe(false)
    })

    it('is off for a negative or non-finite rate', () => {
      expect(isTopupEnabled({ creditsPerDollar: -5, minTopupCents: 100 })).toBe(false)
      expect(
        isTopupEnabled({ creditsPerDollar: Number.NaN, minTopupCents: 100 }),
      ).toBe(false)
    })

    it('is on for any positive rate', () => {
      expect(isTopupEnabled({ creditsPerDollar: 1, minTopupCents: 100 })).toBe(true)
    })
  })

  describe('effectiveMinCents', () => {
    it('uses the admin floor verbatim', () => {
      expect(effectiveMinCents({ creditsPerDollar: 5, minTopupCents: 250 })).toBe(250)
    })

    it('never allows a 0¢ purchase — there would be no payment to confirm', () => {
      expect(effectiveMinCents({ creditsPerDollar: 5, minTopupCents: 0 })).toBe(1)
      expect(effectiveMinCents({ creditsPerDollar: 5, minTopupCents: -100 })).toBe(1)
    })
  })

  describe('amountCentsFor', () => {
    it('prices credits at the given rate', () => {
      expect(amountCentsFor(25, { creditsPerDollar: 5, minTopupCents: 100 })).toBe(500)
      expect(amountCentsFor(25, { creditsPerDollar: 25, minTopupCents: 100 })).toBe(100)
    })

    it('rounds UP so a buyer never receives unpaid-for credits', () => {
      // 5 credits at 3/$ = $1.6667 → 167¢.
      expect(amountCentsFor(5, { creditsPerDollar: 3, minTopupCents: 1 })).toBe(167)
    })

    it('is 0 when top-up is disabled', () => {
      expect(amountCentsFor(25, { creditsPerDollar: 0, minTopupCents: 100 })).toBe(0)
    })
  })

  describe('minCreditsFor', () => {
    it('converts the cents floor into credits at the live rate', () => {
      expect(minCreditsFor({ creditsPerDollar: 5, minTopupCents: 100 })).toBe(5)
      expect(minCreditsFor({ creditsPerDollar: 1000, minTopupCents: 100 })).toBe(1000)
      expect(minCreditsFor({ creditsPerDollar: 1000, minTopupCents: 250 })).toBe(2500)
    })

    it('rounds UP so the floor is always actually met', () => {
      // $1 floor at 3 credits/$ = 3 credits exactly; at 2.5 → 2.5 must become 3.
      expect(minCreditsFor({ creditsPerDollar: 2.5, minTopupCents: 100 })).toBe(3)
    })

    it('round-trips: buying minCredits always costs at least the floor', () => {
      for (const creditsPerDollar of [1, 2.5, 3, 5, 7, 1000]) {
        for (const minTopupCents of [1, 50, 100, 250, 999]) {
          const settings = { creditsPerDollar, minTopupCents }
          const cents = amountCentsFor(minCreditsFor(settings), settings)
          expect(cents).toBeGreaterThanOrEqual(effectiveMinCents(settings))
        }
      }
    })
  })

  describe('quoteTopup', () => {
    it('reports the rate and floor it used, so no client has to assume one', () => {
      const q = quoteTopup({ creditsPerDollar: 5, minTopupCents: 100 }, 25)
      expect(q).toMatchObject({
        enabled: true,
        credits: 25,
        amountCents: 500,
        currency: 'USD',
        minCredits: 5,
        maxCredits: TOPUP_MAX_CREDITS,
        rateCreditsPerDollar: 5,
        minTopupCents: 100,
        meetsMinimum: true,
      })
    })

    it('raises a below-floor request to minCredits and flags the bump', () => {
      const q = quoteTopup({ creditsPerDollar: 5, minTopupCents: 100 }, 2)
      expect(q.meetsMinimum).toBe(false)
      expect(q.credits).toBe(5)
      expect(q.amountCents).toBe(100)
    })

    it('defaults to the cheapest payable amount when none is requested', () => {
      const q = quoteTopup({ creditsPerDollar: 20, minTopupCents: 100 })
      expect(q.credits).toBe(20)
      expect(q.amountCents).toBe(100)
    })

    it('caps at the anti-abuse maximum', () => {
      const q = quoteTopup(
        { creditsPerDollar: 5, minTopupCents: 100 },
        TOPUP_MAX_CREDITS * 10,
      )
      expect(q.credits).toBe(TOPUP_MAX_CREDITS)
    })

    it('zeroes every derived number when disabled, rather than quoting $0', () => {
      const q = quoteTopup({ creditsPerDollar: 0, minTopupCents: 100 }, 5000)
      expect(q).toMatchObject({
        enabled: false,
        credits: 0,
        amountCents: 0,
        minCredits: 0,
        rateCreditsPerDollar: 0,
      })
    })

    it('truncates a fractional credit request — credits are whole units', () => {
      const q = quoteTopup({ creditsPerDollar: 5, minTopupCents: 1 }, 25.9)
      expect(q.credits).toBe(25)
    })
  })
})
