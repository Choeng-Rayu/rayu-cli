import { getStripe, resetStripeClient } from './stripe.client'
import { isStripeEnabled, loadStripeConfig } from './stripe.config'

/**
 * The card rail must be inert — and cheap — while it is switched off, and it must
 * fail with a NAMED variable (never a secret value) when it is switched on
 * without credentials. Both halves are load-bearing: the first is what lets every
 * existing ABA/Bakong deployment upgrade without touching its environment, and
 * the second is what stops a misconfigured deployment from failing later at
 * Stripe's API with an opaque auth error.
 */

const STRIPE_VARS = [
  'STRIPE_ENABLED',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_TOLERANCE',
  'STRIPE_SUCCESS_URL',
  'STRIPE_CANCEL_URL',
  'STRIPE_API_VERSION',
] as const

/** A complete, valid card-rail environment. Fake values — never real keys. */
function enableStripe(overrides: Record<string, string> = {}): void {
  process.env.STRIPE_ENABLED = 'true'
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_value_for_tests'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy_value_for_tests'
  process.env.STRIPE_SUCCESS_URL = 'https://rayucode.com/billing?checkout=success'
  process.env.STRIPE_CANCEL_URL = 'https://rayucode.com/billing?checkout=canceled'
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
}

describe('stripe.config', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of STRIPE_VARS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    resetStripeClient()
  })

  afterEach(() => {
    for (const k of STRIPE_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetStripeClient()
  })

  describe('isStripeEnabled', () => {
    it.each(['1', 'true', 'TRUE', 'yes', ' true '])('treats %p as enabled', (v) => {
      process.env.STRIPE_ENABLED = v
      expect(isStripeEnabled()).toBe(true)
    })

    it.each(['', '0', 'false', 'no', 'maybe'])('treats %p as disabled', (v) => {
      process.env.STRIPE_ENABLED = v
      expect(isStripeEnabled()).toBe(false)
    })

    it('is disabled when the variable is absent entirely', () => {
      expect(isStripeEnabled()).toBe(false)
    })
  })

  describe('loadStripeConfig', () => {
    it('returns null when the rail is off, without requiring any key', () => {
      expect(loadStripeConfig()).toBeNull()
    })

    it.each([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SUCCESS_URL',
      'STRIPE_CANCEL_URL',
    ])('names %s when it is missing but the rail is on', (missing) => {
      enableStripe()
      delete process.env[missing]
      expect(() => loadStripeConfig()).toThrow(missing)
    })

    it('treats a whitespace-only value as missing', () => {
      enableStripe({ STRIPE_SECRET_KEY: '   ' })
      expect(() => loadStripeConfig()).toThrow('STRIPE_SECRET_KEY')
    })

    it('never leaks a secret value in the error message', () => {
      enableStripe({ STRIPE_SECRET_KEY: '   ' })
      // The webhook secret IS set here, so a naive "dump the config" error would
      // expose it while complaining about the missing key.
      try {
        loadStripeConfig()
        throw new Error('expected loadStripeConfig to throw')
      } catch (err) {
        expect((err as Error).message).not.toContain('whsec_dummy_value_for_tests')
      }
    })

    it('defaults the webhook tolerance to Stripe\u2019s own 300s', () => {
      enableStripe()
      expect(loadStripeConfig()?.webhookToleranceSeconds).toBe(300)
    })

    it('honors an explicit tolerance', () => {
      enableStripe({ STRIPE_WEBHOOK_TOLERANCE: '120' })
      expect(loadStripeConfig()?.webhookToleranceSeconds).toBe(120)
    })

    it.each(['0', '-5', 'abc'])('refuses tolerance %p (0 disables replay protection)', (v) => {
      enableStripe({ STRIPE_WEBHOOK_TOLERANCE: v })
      expect(() => loadStripeConfig()).toThrow('STRIPE_WEBHOOK_TOLERANCE')
    })

    it('pins an API version rather than defaulting to the account version', () => {
      enableStripe()
      // Never null/undefined: an unpinned version changes the wire format under
      // us when Stripe rolls a release.
      expect(loadStripeConfig()?.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}/)
    })

    it('allows overriding the pinned API version', () => {
      enableStripe({ STRIPE_API_VERSION: '2025-01-01.acacia' })
      expect(loadStripeConfig()?.apiVersion).toBe('2025-01-01.acacia')
    })
  })

  describe('getStripe', () => {
    it('constructs no client at all while the rail is off', () => {
      expect(getStripe()).toBeNull()
    })

    it('returns a client when enabled and reuses it across calls', () => {
      enableStripe()
      const first = getStripe()
      expect(first?.client).toBeDefined()
      // Same instance: the SDK holds an HTTP connection pool, so a per-call
      // client would leak sockets.
      expect(getStripe()?.client).toBe(first?.client)
    })

    it('drops the cached client when the rail is switched off', () => {
      enableStripe()
      expect(getStripe()).not.toBeNull()
      delete process.env.STRIPE_ENABLED
      expect(getStripe()).toBeNull()
    })

    it('rebuilds the client when the secret key is rotated', () => {
      enableStripe()
      const first = getStripe()?.client
      enableStripe({ STRIPE_SECRET_KEY: 'sk_test_rotated_dummy_value' })
      expect(getStripe()?.client).not.toBe(first)
    })
  })
})
