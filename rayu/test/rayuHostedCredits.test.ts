import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  formatRayuUsageLine,
  formatRayuUsageSummary,
  type RayuCreditStatus,
} from '../src/services/rayuAuth/rayuCredits.ts'
import { syncRayuHostedProvider } from '../src/services/rayuAuth/rayuHostedProvider.ts'
import type { RayuEntitlements } from '../src/services/rayuAuth/rayuEntitlements.ts'
import {
  _resetRayuEntitlementsForTesting,
  _setRayuEntitlementsForTesting,
} from '../src/services/rayuAuth/rayuEntitlements.ts'
import { makeRayuHostedFetch } from '../src/services/api/rayuHosted/rayuHostedAuth.ts'
import { loadRayuConfig, saveRayuConfig } from '../src/utils/rayuConfig.ts'
import { APIError } from '@anthropic-ai/sdk/index.js'
import Anthropic from '@anthropic-ai/sdk'
import {
  getAssistantMessageFromError,
  isRayuCreditLimitError,
  isRayuHostedProviderUnavailable,
} from '../src/services/api/errors.ts'
import { CannotRetryError, withRetry } from '../src/services/api/withRetry.ts'
import { createRayuHostedClient } from '../src/services/api/rayuHosted/rayuHostedClient.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-hosted-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

const status = (over: Partial<RayuCreditStatus> = {}): RayuCreditStatus => ({
  plan: 'pro',
  planName: 'Pro',
  priceCents: 1000,
  creditsPerPeriod: 50,
  usedCredits: 1,
  remainingCredits: 49,
  tokensPerCredit: 100000,
  allowanceTokens: 5000000,
  usedTokens: 100000,
  remainingTokens: 4900000,
  resetSeconds: 3600,
  periodEnd: '2026-07-18T00:00:00Z',
  topupBalance: 0,
  topUpEnabled: true,
  ...over,
})

describe('rayu usage formatter', () => {
  test('paid plan summary shows plan/price + credits + tokens + topup', () => {
    const s = formatRayuUsageSummary(status())
    expect(s).toContain('Rayu Plan Usage')
    expect(s).toContain('Pro ($10/mo)')
    expect(s).toContain('1 / 50 used')
    expect(s).toContain('49 left')
    expect(s).toContain('5,000,000')
    expect(s).toContain('Top-up')
  })

  test('free plan summary notes no allowance', () => {
    const s = formatRayuUsageSummary(
      status({
        plan: 'free',
        planName: 'Free',
        priceCents: 0,
        creditsPerPeriod: null,
        remainingCredits: null,
        allowanceTokens: null,
        usedTokens: null,
        remainingTokens: null,
        topUpEnabled: false,
      }),
    )
    expect(s).toContain('No hosted credit allowance')
  })

  test('compact line format', () => {
    expect(formatRayuUsageLine(status())).toBe('Rayu: 49 / 50 credits left')
  })

  test('shows the daily turn cap when set', () => {
    const s = formatRayuUsageSummary(
      status({
        plan: 'free',
        planName: 'Free',
        priceCents: 0,
        creditsPerPeriod: null,
        remainingCredits: null,
        allowanceTokens: null,
        usedTokens: null,
        remainingTokens: null,
        topUpEnabled: false,
        maxDailyTurns: 50,
        turnsUsedToday: 12,
        turnsRemaining: 38,
        turnsResetSeconds: 7200,
      }),
    )
    expect(s).toContain('12 / 50 turns used')
    expect(s).toContain('38 left')
  })

  test('compact line shows turns left when there is no credit allowance', () => {
    expect(
      formatRayuUsageLine(
        status({
          creditsPerPeriod: null,
          maxDailyTurns: 50,
          turnsUsedToday: 12,
          turnsRemaining: 38,
        }),
      ),
    ).toBe('Rayu: 38 / 50 turns left today')
  })
})

const entWith = (codes: string[], planCode = 'pro'): RayuEntitlements => ({
  plan: { code: planCode, name: planCode, priceCents: 1000, availability: 'active' },
  maxDailyTurns: null,
  features: {},
  allowedModels: codes.map((c) => ({
    code: c,
    label: c,
    provider: 'deepseek',
    creditMultiplier: 1,
  })),
})

describe('syncRayuHostedProvider', () => {
  test('registers + activates the rayu-hosted provider when paid', () => {
    syncRayuHostedProvider(entWith(['deepseek-v4-flash', 'deepseek-v4-pro']), {
      activate: true,
    })
    const cfg = loadRayuConfig()
    const p = cfg.providers.find((x) => x.id === 'rayu-hosted')
    expect(p).toBeTruthy()
    expect(p?.kind).toBe('rayu-hosted')
    expect(p?.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(p?.baseURL ?? '').toContain('/v1')
    expect(cfg.activeProvider).toBe('rayu-hosted')
  })

  test('removes the provider when entitlement has no hosted models', () => {
    syncRayuHostedProvider(entWith(['deepseek-v4-flash']), { activate: true })
    syncRayuHostedProvider(entWith([], 'free'))
    const cfg = loadRayuConfig()
    expect(cfg.providers.find((x) => x.id === 'rayu-hosted')).toBeFalsy()
    expect(cfg.activeProvider).not.toBe('rayu-hosted')
  })
})

describe('rayu-hosted visibility (free sees it, blocked on use)', () => {
  const freeCatalogEnt = (): RayuEntitlements => ({
    plan: { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
    maxDailyTurns: 50,
    features: {},
    allowedModels: [], // not entitled to use
    hostedModels: [
      { code: 'deepseek-v4-flash', label: 'f', provider: 'deepseek', creditMultiplier: 0.33 },
      { code: 'deepseek-v4-pro', label: 'p', provider: 'deepseek', creditMultiplier: 1 },
    ],
  })

  test('free: provider is registered (visible) from the catalog but NOT auto-activated', () => {
    syncRayuHostedProvider(freeCatalogEnt(), { activate: true })
    const cfg = loadRayuConfig()
    const p = cfg.providers.find((x) => x.id === 'rayu-hosted')
    expect(p).toBeTruthy()
    expect(p?.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(cfg.activeProvider).not.toBe('rayu-hosted') // free keeps their own active provider
  })

  test('free: using a hosted model returns a 403 with the /plans upgrade link', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_WEB_URL = 'https://web.example.test'
    _setRayuEntitlementsForTesting(freeCatalogEnt())
    try {
      const f = makeRayuHostedFetch()
      const res = await f('https://gw.example/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error?: { message?: string; code?: string } }
      expect(body.error?.code).toBe('plan_upgrade_required')
      expect(body.error?.message).toContain('https://web.example.test/plans')
    } finally {
      _resetRayuEntitlementsForTesting()
      delete process.env.USE_RAYU_OAUTH
      delete process.env.RAYU_WEB_URL
    }
  })

  test('paid: a hosted request with a NON-exact model id is NOT blocked client-side', async () => {
    // Regression: a paid user (has allowedModels) whose request carries a model
    // string that isn't an exact allowed-code — e.g. a subagent/side-query or an
    // upstream/variant id like "kimi-k2.7-code:cloud" — must NOT get the client
    // "upgrade your plan" 403. The gateway is the authoritative per-model gate.
    process.env.USE_RAYU_OAUTH = 'true'
    _setRayuEntitlementsForTesting({
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        { code: 'kimi-k2.7', label: 'k', provider: 'rayu-ollama', creditMultiplier: 2.5 },
      ],
    })
    try {
      const f = makeRayuHostedFetch()
      let blockedWithUpgrade403 = false
      try {
        const res = await f('https://gw.example/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ model: 'kimi-k2.7-code:cloud', messages: [] }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string }
        }
        blockedWithUpgrade403 =
          res.status === 403 && body.error?.code === 'plan_upgrade_required'
      } catch {
        // Gate passed → proceeded to the token/inner-fetch step (no session in
        // tests), which is NOT the gate's upgrade 403. That's the success path.
      }
      expect(blockedWithUpgrade403).toBe(false)
    } finally {
      _resetRayuEntitlementsForTesting()
      delete process.env.USE_RAYU_OAUTH
    }
  })
})


// --- Credit / period limit (429) is TERMINAL: no retry, clear renew message ---

/** Build the exact Anthropic-shaped error the OpenAI adapter produces for the
 *  gateway's credit-limit 429 (reason:"period_limit", Retry-After = period reset). */
function creditLimitError(retryAfterSeconds = 2_452_241): APIError {
  const headers = new Headers({ 'retry-after': String(retryAfterSeconds) })
  return APIError.generate(
    429,
    {
      error: { message: 'credit limit reached: period_limit', type: 'rate_limit_exceeded' },
      reason: 'period_limit',
      resetSeconds: retryAfterSeconds,
    },
    'credit limit reached: period_limit',
    headers,
  ) as APIError
}

function textOf(m: { message: { content: unknown } }): string {
  const c = m.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}

describe('isRayuCreditLimitError', () => {
  test('true for a period_limit 429 (structured body reason)', () => {
    expect(isRayuCreditLimitError(creditLimitError())).toBe(true)
  })

  test('true via nested-body message when the discriminator reason differs', () => {
    // Full gateway-shaped body (so APIError preserves .error) but with a
    // non-"period_limit" reason — exercises the nested-message fallback.
    // NB: a Headers object is required for APIError.generate to produce a
    // status-bearing error (undefined headers degrades to APIConnectionError).
    const e = APIError.generate(
      429,
      {
        error: { message: 'credit limit reached: period_limit', type: 'rate_limit_exceeded' },
        reason: 'other',
        resetSeconds: 10,
      },
      'credit limit reached',
      new Headers({ 'retry-after': '10' }),
    )
    expect(isRayuCreditLimitError(e)).toBe(true)
  })

  test('false for a transient 429 (concurrency / plain rate limit)', () => {
    const h = new Headers({ 'retry-after': '5' })
    const conc = APIError.generate(429, { error: { message: 'too many concurrent requests' }, reason: 'concurrency' }, 'too many concurrent requests', h)
    expect(isRayuCreditLimitError(conc)).toBe(false)
    const plain = APIError.generate(429, { error: { message: 'Rate limit exceeded, slow down' } }, 'Rate limit exceeded, slow down', h)
    expect(isRayuCreditLimitError(plain)).toBe(false)
  })

  test('false for non-429 errors and non-APIError values', () => {
    const h = new Headers()
    expect(isRayuCreditLimitError(APIError.generate(500, { error: { message: 'server error' } }, 'server error', h))).toBe(false)
    expect(isRayuCreditLimitError(new Error('period_limit'))).toBe(false)
  })
})

describe('getAssistantMessageFromError · credit limit', () => {
  test('renders a billing message with the /plans link and a reset ETA', () => {
    process.env.RAYU_WEB_URL = 'https://web.example.test'
    try {
      const msg = getAssistantMessageFromError(creditLimitError(), 'deepseek-v4-pro')
      const text = textOf(msg)
      expect(text.toLowerCase()).toContain('credit limit')
      expect(text).toContain('https://web.example.test/plans')
      // 2_452_241s ≈ 28 days → the human reset hint is included.
      expect(text).toContain('28 days')
      expect(msg.isApiErrorMessage).toBe(true)
    } finally {
      delete process.env.RAYU_WEB_URL
    }
  })
})

describe('withRetry · credit limit is not retried', () => {
  test('bails after a single attempt with CannotRetryError (no 10× / no multi-week sleep)', async () => {
    let calls = 0
    const err = creditLimitError()
    const getClient = async () => ({}) as never
    const operation = async (): Promise<{ ok: true }> => {
      calls++
      throw err
    }
    const gen = withRetry<{ ok: true }>(getClient, operation, {
      model: 'deepseek-v4-pro',
      thinkingConfig: { type: 'disabled' },
      maxRetries: 10,
    })

    let threw: unknown
    try {
      // Drain the generator; a credit-limit error must throw before any
      // system 'retrying…' message is yielded and before any sleep.
      for await (const _m of gen) {
        void _m
      }
    } catch (e) {
      threw = e
    }

    expect(calls).toBe(1)
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect((threw as CannotRetryError).originalError).toBe(err)
  })
})


describe('createRayuHostedClient · native Anthropic (DeepSeek Anthropic API)', () => {
  test('returns a native @anthropic-ai/sdk client pointed at the gateway /anthropic base', () => {
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.test'
    try {
      const client = createRayuHostedClient(
        { id: 'rayu-hosted', kind: 'rayu-hosted' } as never,
        2,
      )
      // It's the real Anthropic SDK client — not the OpenAI adapter shim — so
      // claude.ts drives it natively (thinking/tools/usage map 1:1, no
      // translation), and usage comes back in Anthropic's native shape.
      expect(client).toBeInstanceOf(Anthropic)
      expect(typeof (client as unknown as { messages?: { create?: unknown } }).messages?.create).toBe('function')
      expect(
        typeof (client as unknown as { beta?: { messages?: { create?: unknown } } }).beta?.messages?.create,
      ).toBe('function')
      // Targets the gateway's Anthropic endpoint (SDK appends /v1/messages).
      expect(String((client as unknown as { baseURL?: string }).baseURL)).toContain('/anthropic')
    } finally {
      delete process.env.RAYU_GATEWAY_URL
    }
  })
})

// --- Case 1: RAYU's own upstream LLM provider is unavailable (rayu-hosted) ---
// Distinct from the customer's plan/credit limit (Case 2, the credit-limit
// branch above). The gateway sanitizes ANY hosted upstream failure (an Ollama
// "requires a subscription" 403, an upstream 5xx, out-of-credits, …) to a clean
// 5xx `provider_unavailable`, so the CLI shows "try a smaller model / try again
// later" and NEVER leaks the upstream (e.g. ollama.com).

/** Point the on-disk active provider at a given kind (getActiveProvider reads it). */
function setActiveProvider(kind: 'rayu-hosted' | 'byo'): void {
  const cfg = loadRayuConfig()
  cfg.providers = (kind === 'rayu-hosted'
    ? [{ id: 'rayu-hosted', kind: 'rayu-hosted' }]
    : [{ id: 'deepseek', kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x' }]) as never
  cfg.activeProvider = kind === 'rayu-hosted' ? 'rayu-hosted' : 'deepseek'
  saveRayuConfig(cfg)
}

/** The clean 5xx the gateway now returns for a sanitized hosted upstream failure. */
function providerUnavailableError(status = 502): APIError {
  return APIError.generate(
    status,
    {
      error: {
        message:
          'The AI provider for this model is temporarily unavailable. Try another (smaller) model or try again later.',
        type: 'provider_unavailable',
      },
    },
    'provider unavailable',
    new Headers(),
  ) as APIError
}

describe('getAssistantMessageFromError · rayu-hosted provider unavailable (Case 1)', () => {
  test('renders "try a smaller model / try again later" and never leaks the upstream', () => {
    setActiveProvider('rayu-hosted')
    const msg = getAssistantMessageFromError(providerUnavailableError(502), 'kimi-k2.7')
    const text = textOf(msg)
    expect(text.toLowerCase()).toContain('temporarily unavailable')
    expect(text.toLowerCase()).toContain('smaller model')
    expect(msg.isApiErrorMessage).toBe(true)
    // Never surface the upstream provider or its subscription/limit wording…
    expect(text.toLowerCase()).not.toContain('ollama')
    expect(text.toLowerCase()).not.toContain('subscription')
    // …and this is NOT the plan/credit-limit (upgrade) message.
    expect(text).not.toContain('/plans')
  })

  test('detector: true for a hosted 5xx, false for a 429 (that is the plan-limit path)', () => {
    setActiveProvider('rayu-hosted')
    expect(isRayuHostedProviderUnavailable(providerUnavailableError(503))).toBe(true)
    expect(isRayuHostedProviderUnavailable(providerUnavailableError(500))).toBe(true)
    expect(isRayuHostedProviderUnavailable(creditLimitError())).toBe(false)
  })

  test('BYO-key providers are NOT affected — a 5xx keeps normal handling, not the hosted message', () => {
    setActiveProvider('byo')
    expect(isRayuHostedProviderUnavailable(providerUnavailableError(502))).toBe(false)
    const msg = getAssistantMessageFromError(providerUnavailableError(502), 'deepseek-chat')
    expect(textOf(msg)).not.toContain("Rayu's AI provider")
  })
})
