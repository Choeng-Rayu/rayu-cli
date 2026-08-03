import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  clampTopupCredits,
  createTopupPurchase,
  fetchTopupQuote,
  formatTopupRate,
  formatUsd,
  isTopupError,
  previewAmountCents,
  suggestedTopupAmounts,
  type TopupQuote,
} from '../src/services/rayuAuth/rayuTopup.ts'

// A quote as the server would return it. Every test that involves a price feeds
// the rate in through this fixture — if any of them could pass with a rate baked
// into the CLI, the CLI would be hardcoding a price.
const quote = (over: Partial<TopupQuote> = {}): TopupQuote => ({
  enabled: true,
  credits: 1000,
  amountCents: 100,
  currency: 'USD',
  minCredits: 1000,
  maxCredits: 100_000_000,
  rateCreditsPerDollar: 1000,
  minTopupCents: 100,
  meetsMinimum: true,
  ...over,
})

let dir: string
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-topup-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.USE_RAYU_OAUTH = 'true'
  process.env.RAYU_GATEWAY_URL = 'https://gw.test'
  process.env.RAYU_API_URL = 'https://api.test/api'
  // A far-future expiry so getValidRayuAccessToken uses the token as-is instead
  // of trying to refresh it over the network. Field names/filename must match
  // rayuSession.ts exactly (rayu-auth.json, `expiresAt` in epoch ms).
  writeFileSync(
    join(dir, 'rayu-auth.json'),
    JSON.stringify({
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600_000,
      user: {
        id: 1,
        email: 'u@example.com',
        displayName: null,
        avatarUrl: null,
        role: 'user',
      },
    }),
    { mode: 0o600 },
  )
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  delete process.env.RAYU_GATEWAY_URL
  delete process.env.RAYU_API_URL
})

/** Stub fetch with a per-URL responder, recording the URLs that were hit. */
function stubFetch(
  responder: (url: string, init?: RequestInit) => { status: number; body: unknown } | null,
): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    seen.push(url)
    const res = responder(url, init)
    if (!res) throw new Error('network down')
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return seen
}

describe('clampTopupCredits — bounds come from the quote, never from constants', () => {
  test('raises a below-minimum entry to the server minimum', () => {
    expect(clampTopupCredits(10, quote())).toBe(1000)
    expect(clampTopupCredits('10', quote())).toBe(1000)
  })

  test('follows the minimum when the admin changes it', () => {
    expect(clampTopupCredits(1500, quote({ minCredits: 2500 }))).toBe(2500)
  })

  test('caps at the server maximum', () => {
    expect(clampTopupCredits(999_999_999, quote())).toBe(100_000_000)
  })

  test('keeps a valid amount and truncates fractions to whole credits', () => {
    expect(clampTopupCredits(5000, quote())).toBe(5000)
    expect(clampTopupCredits('5000.9', quote())).toBe(5000)
  })

  test('a non-numeric entry becomes the minimum, so submission is always payable', () => {
    expect(clampTopupCredits('abc', quote())).toBe(1000)
    expect(clampTopupCredits('', quote())).toBe(1000)
  })
})

describe('previewAmountCents — priced with the quote’s own rate', () => {
  test('prices at the quoted rate', () => {
    expect(previewAmountCents(5000, quote())).toBe(500)
  })

  test('re-prices when the rate changes, with no code change', () => {
    expect(previewAmountCents(5000, quote({ rateCreditsPerDollar: 500 }))).toBe(1000)
  })

  test('rounds UP, matching the server, so a preview never undercuts the charge', () => {
    // 5 credits at 3/$ = $1.6667 → 167¢.
    expect(previewAmountCents(5, quote({ rateCreditsPerDollar: 3 }))).toBe(167)
  })

  test('is 0 when top-up is disabled', () => {
    expect(previewAmountCents(5000, quote({ enabled: false, rateCreditsPerDollar: 0 }))).toBe(0)
  })
})

describe('suggestedTopupAmounts — derived from the live minimum', () => {
  test('offers multiples of the server minimum, not a fixed dollar menu', () => {
    expect(suggestedTopupAmounts(quote())).toEqual([1000, 2000, 5000, 10000, 20000])
  })

  test('moves with the minimum when the admin changes the floor or the rate', () => {
    expect(suggestedTopupAmounts(quote({ minCredits: 2500 }))).toEqual([
      2500, 5000, 12500, 25000, 50000,
    ])
  })

  test('never suggests more than the maximum', () => {
    const amounts = suggestedTopupAmounts(quote({ minCredits: 1000, maxCredits: 3000 }))
    expect(amounts).toEqual([1000, 2000])
  })

  test('offers nothing when top-up is disabled', () => {
    expect(suggestedTopupAmounts(quote({ enabled: false, minCredits: 0 }))).toEqual([])
  })
})

describe('display helpers', () => {
  test('formatUsd renders cents as dollars', () => {
    expect(formatUsd(100)).toBe('$1.00')
    expect(formatUsd(167)).toBe('$1.67')
  })

  test('formatTopupRate states the admin’s rate and minimum verbatim', () => {
    expect(formatTopupRate(quote())).toBe(
      '$1.00 = 1,000 credits · minimum $1.00 (1,000 credits)',
    )
    expect(formatTopupRate(quote({ rateCreditsPerDollar: 500, minTopupCents: 250, minCredits: 1250 }))).toBe(
      '$1.00 = 500 credits · minimum $2.50 (1,250 credits)',
    )
  })

  test('formatTopupRate says top-up is off rather than showing a price', () => {
    expect(formatTopupRate(quote({ enabled: false }))).toBe(
      'Credit top-up is not enabled on this server.',
    )
  })
})

describe('fetchTopupQuote', () => {
  test('prefers the gateway so no backend round trip is needed', async () => {
    const seen = stubFetch((url) =>
      url.startsWith('https://gw.test') ? { status: 200, body: quote() } : null,
    )
    const q = await fetchTopupQuote(5000)
    expect(q?.rateCreditsPerDollar).toBe(1000)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('https://gw.test/v1/credits/topup/quote?credits=5000')
  })

  test('falls back to the backend when the gateway is unreachable', async () => {
    const seen = stubFetch((url) =>
      url.startsWith('https://api.test') ? { status: 200, body: quote() } : null,
    )
    const q = await fetchTopupQuote(5000)
    expect(q?.enabled).toBe(true)
    expect(seen).toEqual([
      'https://gw.test/v1/credits/topup/quote?credits=5000',
      'https://api.test/api/payments/topup/quote?credits=5000',
    ])
  })

  test('omits the credits param when no amount is chosen yet', async () => {
    const seen = stubFetch(() => ({ status: 200, body: quote() }))
    await fetchTopupQuote()
    expect(seen[0]).toBe('https://gw.test/v1/credits/topup/quote')
  })

  test('returns null when neither service answers — no invented price', async () => {
    stubFetch(() => null)
    expect(await fetchTopupQuote(5000)).toBeNull()
  })

  test('surfaces the disabled state instead of a price', async () => {
    stubFetch(() => ({
      status: 200,
      body: quote({ enabled: false, credits: 0, amountCents: 0, minCredits: 0, rateCreditsPerDollar: 0 }),
    }))
    const q = await fetchTopupQuote(5000)
    expect(q?.enabled).toBe(false)
    expect(q?.amountCents).toBe(0)
  })
})

describe('createTopupPurchase', () => {
  test('posts to the backend (the authoritative price) and returns the purchase', async () => {
    let body: unknown
    const seen = stubFetch((url, init) => {
      body = JSON.parse(String(init?.body))
      return {
        status: 201,
        body: {
          paymentId: 42,
          credits: 5000,
          amountCents: 500,
          currency: 'USD',
          method: 'bakong',
          qr: 'TESTQR',
          md5: 'md5',
          expiresAt: null,
          reused: false,
        },
      }
    })
    const res = await createTopupPurchase(5000, 'bakong')
    expect(isTopupError(res)).toBe(false)
    expect(seen[0]).toBe('https://api.test/api/payments/topup')
    expect(body).toEqual({ credits: 5000, method: 'bakong' })
    expect(res && !isTopupError(res) ? res.amountCents : null).toBe(500)
  })

  test('returns the server’s own explanation for a rejected purchase', async () => {
    stubFetch(() => ({
      status: 400,
      body: { message: 'Minimum top-up is $1.00 (1,000 credits)' },
    }))
    const res = await createTopupPurchase(10, 'bakong')
    expect(isTopupError(res)).toBe(true)
    expect(isTopupError(res) ? res.message : '').toBe(
      'Minimum top-up is $1.00 (1,000 credits)',
    )
  })

  test('reports the 501 for the card rail instead of falling back to a QR', async () => {
    stubFetch(() => ({
      status: 501,
      body: { message: 'Card (Stripe) top-up is not enabled on this server — use ABA or Bakong KHQR.' },
    }))
    const res = await createTopupPurchase(5000, 'stripe')
    expect(isTopupError(res)).toBe(true)
    expect(isTopupError(res) ? res.status : 0).toBe(501)
  })

  test('joins a validation error array into one readable message', async () => {
    stubFetch(() => ({
      status: 400,
      body: { message: ['credits must be an integer', 'credits must not be less than 1'] },
    }))
    const res = await createTopupPurchase(0, 'aba')
    expect(isTopupError(res) ? res.message : '').toContain('credits must be an integer')
  })
})
