import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  formatRayuUsageLine,
  formatRayuUsageSummary,
  type RayuCreditStatus,
} from '../src/services/rayuAuth/rayuCredits.ts'
import {
  refreshHostedCatalog,
  syncRayuHostedProvider,
} from '../src/services/rayuAuth/rayuHostedProvider.ts'
import type { RayuEntitlements } from '../src/services/rayuAuth/rayuEntitlements.ts'
import {
  _resetRayuEntitlementsForTesting,
  _setRayuEntitlementsForTesting,
} from '../src/services/rayuAuth/rayuEntitlements.ts'
import { makeRayuHostedFetch } from '../src/services/api/rayuHosted/rayuHostedAuth.ts'
import {
  getAllProviderModelOptions,
  loadRayuConfig,
  saveRayuConfig,
} from '../src/utils/rayuConfig.ts'
import {
  describeModelChoice,
  formatContextTokens,
} from '../src/components/SearchableModelPicker.tsx'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk/index.js'
// Same specifier the source uses (src/services/api/anthropicMessagesClient.ts).
// The bare '@anthropic-ai/sdk' and '@anthropic-ai/sdk/index.js' resolve to
// separate module records, giving two distinct Anthropic classes — so
// `toBeInstanceOf` only holds when both sides import the same one.
import Anthropic from '@anthropic-ai/sdk/index.js'
import {
  getAssistantMessageFromError,
  isRayuCreditLimitError,
  isRayuHostedProviderUnavailable,
} from '../src/services/api/errors.ts'
import { CannotRetryError, withRetry } from '../src/services/api/withRetry.ts'

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

  // The whole point of the server-driven catalog: an admin adds a model in the
  // dashboard and it appears in the CLI on the next entitlements refresh, with no
  // release and no user action.
  test('a model added by the admin appears on the next sync (and a removed one goes)', () => {
    syncRayuHostedProvider(entWith(['deepseek-v4-pro']), { activate: true })
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')?.models,
    ).toEqual(['deepseek-v4-pro'])

    // Admin adds "deepseek" and drops nothing.
    syncRayuHostedProvider(entWith(['deepseek-v4-pro', 'deepseek']))
    const grown = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    expect(grown?.models).toEqual(['deepseek-v4-pro', 'deepseek'])
    // fetchedModels drives the /model picker, so it must track the catalog too.
    expect(grown?.fetchedModels).toEqual(['deepseek-v4-pro', 'deepseek'])

    // Admin then removes the original model.
    syncRayuHostedProvider(entWith(['deepseek']))
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')?.models,
    ).toEqual(['deepseek'])
  })

  // A stale default is worse than no default: every request would go to a model
  // the gateway now rejects (403), which looks like a CLI bug.
  test('prunes a default/small model that left the catalog, keeps one that stayed', () => {
    syncRayuHostedProvider(entWith(['deepseek-v4-pro', 'glm-5.2']), { activate: true })
    const cfg = loadRayuConfig()
    const i = cfg.providers.findIndex((x) => x.id === 'rayu-hosted')
    cfg.providers[i] = {
      ...cfg.providers[i]!,
      defaultModel: 'glm-5.2',
      smallFastModel: 'glm-5.2',
    }
    saveRayuConfig(cfg)

    // glm-5.2 survives a refresh that still lists it.
    syncRayuHostedProvider(entWith(['deepseek-v4-pro', 'glm-5.2']))
    let p = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    expect(p?.defaultModel).toBe('glm-5.2')
    expect(p?.smallFastModel).toBe('glm-5.2')

    // Admin removes glm-5.2 → both fall back to a model that actually exists.
    syncRayuHostedProvider(entWith(['deepseek-v4-pro']))
    p = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    expect(p?.defaultModel).toBe('deepseek-v4-pro')
    expect(p?.smallFastModel).toBe('deepseek-v4-pro')
  })

  // The admin-entered context window must reach the provider config, because that
  // map is what getRayuModelContextWindow() reads for hosted models.
  test('stores the admin context window per model, omitting unset/invalid ones', () => {
    const ent: RayuEntitlements = {
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        { code: 'big', label: 'big', provider: 'p', creditMultiplier: 1, contextWindow: 1_000_000 },
        { code: 'mid', label: 'mid', provider: 'p', creditMultiplier: 1, contextWindow: 200_000 },
        { code: 'unset', label: 'unset', provider: 'p', creditMultiplier: 1, contextWindow: null },
        { code: 'missing', label: 'missing', provider: 'p', creditMultiplier: 1 },
        // Defensive: a bad server value must NOT become a 0-token window.
        { code: 'zero', label: 'zero', provider: 'p', creditMultiplier: 1, contextWindow: 0 },
      ],
    }
    syncRayuHostedProvider(ent, { activate: true })
    const p = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    expect(p?.modelContextWindows).toEqual({ big: 1_000_000, mid: 200_000 })
    // Every model is still selectable — only the WINDOW is unknown for some.
    expect(p?.models).toEqual(['big', 'mid', 'unset', 'missing', 'zero'])
  })

  test('an admin raising the context window overwrites the stored one', () => {
    const withWindow = (tokens: number): RayuEntitlements => ({
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        { code: 'deepseek', label: 'd', provider: 'p', creditMultiplier: 1, contextWindow: tokens },
      ],
    })
    syncRayuHostedProvider(withWindow(200_000), { activate: true })
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
        ?.modelContextWindows?.['deepseek'],
    ).toBe(200_000)

    syncRayuHostedProvider(withWindow(1_000_000))
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
        ?.modelContextWindows?.['deepseek'],
    ).toBe(1_000_000)
  })

  // The model NAME the admin typed must reach the CLI, because the picker shows it
  // next to the id. Nothing about the hosted catalog is hardcoded here, so a
  // rename in the dashboard has to travel through the entitlements payload.
  test('stores the admin display name per model, skipping ones that add nothing', () => {
    const ent: RayuEntitlements = {
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        { code: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'deepseek', creditMultiplier: 1 },
        // A label that just repeats the id would render as "x — x".
        { code: 'glm-5.2', label: 'glm-5.2', provider: 'zai', creditMultiplier: 1 },
        // Blank / whitespace-only names are not names.
        { code: 'blank', label: '   ', provider: 'p', creditMultiplier: 1 },
      ],
    }
    syncRayuHostedProvider(ent, { activate: true })
    const p = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    expect(p?.modelLabels).toEqual({ 'deepseek-v4-pro': 'DeepSeek V4 Pro' })
    // Every model stays selectable — only the NAME is missing for some.
    expect(p?.models).toEqual(['deepseek-v4-pro', 'glm-5.2', 'blank'])
  })

  test('an admin renaming a model overwrites the stored name', () => {
    const named = (label: string): RayuEntitlements => ({
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [{ code: 'm1', label, provider: 'p', creditMultiplier: 1 }],
    })
    syncRayuHostedProvider(named('Old Name'), { activate: true })
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
        ?.modelLabels?.['m1'],
    ).toBe('Old Name')

    syncRayuHostedProvider(named('New Name'))
    expect(
      loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
        ?.modelLabels?.['m1'],
    ).toBe('New Name')
  })

  // What the picker actually consumes: id + name + window for every hosted model,
  // all three sourced from the backend payload.
  test('picker options carry the backend id, name and context window', () => {
    const ent: RayuEntitlements = {
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        {
          code: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          provider: 'deepseek',
          creditMultiplier: 1,
          contextWindow: 128_000,
        },
        { code: 'nameless', label: '', provider: 'p', creditMultiplier: 1 },
      ],
    }
    syncRayuHostedProvider(ent, { activate: true })

    const options = getAllProviderModelOptions()
    const pro = options.find((o) => o.model === 'deepseek-v4-pro')
    expect(pro).toMatchObject({
      providerId: 'rayu-hosted',
      model: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      contextWindow: 128_000,
    })
    expect(describeModelChoice(pro!)).toBe('rayu-hosted · DeepSeek V4 Pro · 128K ctx')

    // A model with no admin name/window still lists — just without the extras.
    const bare = options.find((o) => o.model === 'nameless')
    expect(bare?.label).toBeUndefined()
    expect(bare?.contextWindow).toBeUndefined()
    expect(describeModelChoice(bare!)).toBe('rayu-hosted')
  })

  // The upstream provider (which reseller serves a model) is an internal
  // commercial detail. The CLI shows one provider for every hosted model —
  // "rayu-hosted" — so nothing from the payload's `provider` field may reach the
  // config the picker renders from.
  test('never stores or shows the upstream provider name', () => {
    const ent: RayuEntitlements = {
      plan: { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
      maxDailyTurns: null,
      features: {},
      allowedModels: [
        {
          code: 'glm-5.2',
          label: 'GLM-5.2',
          provider: 'rayu-ollama',
          creditMultiplier: 1,
          contextWindow: 1_000_000,
        },
        { code: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'bedrock', creditMultiplier: 2 },
      ],
    }
    syncRayuHostedProvider(ent, { activate: true })

    const hosted = loadRayuConfig().providers.find((x) => x.id === 'rayu-hosted')
    const serialized = JSON.stringify(hosted)
    for (const upstream of ['rayu-ollama', 'bedrock', 'ollama']) {
      expect(serialized).not.toContain(upstream)
    }

    // And the row the user reads names only the hosted provider.
    const glm = getAllProviderModelOptions().find((o) => o.model === 'glm-5.2')!
    expect(describeModelChoice(glm)).toBe('rayu-hosted · GLM-5.2 · 1M ctx')
  })

  // Scope guard: the hosted sync must never disturb another provider's entry.
  test('leaves other providers untouched', () => {
    const cfg = loadRayuConfig()
    cfg.providers.push({
      id: 'my-openai',
      kind: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: ['gpt-x'],
      defaultModel: 'gpt-x',
      modelContextWindows: { 'gpt-x': 111_000 },
    })
    cfg.activeProvider = 'my-openai'
    saveRayuConfig(cfg)

    syncRayuHostedProvider(entWith(['deepseek-v4-pro']))

    const after = loadRayuConfig()
    const other = after.providers.find((x) => x.id === 'my-openai')
    expect(other).toMatchObject({
      kind: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: ['gpt-x'],
      defaultModel: 'gpt-x',
      modelContextWindows: { 'gpt-x': 111_000 },
    })
    // A background refresh must not hijack the user's active provider either.
    expect(after.activeProvider).toBe('my-openai')
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


describe('rayu-hosted client · native Anthropic (DeepSeek Anthropic API)', () => {
  test('returns a native @anthropic-ai/sdk client pointed at the gateway /anthropic base', async () => {
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.test'
    try {
      const { buildClient } = await import(
        '../src/services/api/providerRegistry.ts'
      )
      const client = (await buildClient(
        { id: 'rayu-hosted', kind: 'rayu-hosted' } as never,
        { maxRetries: 2 },
      )) as Anthropic
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

// --- Case 1b: connection failure (gateway/origin unreachable, e.g. Cloudflare
// 5xx before the origin, or the Go gateway down). This is what surfaced in the
// wild as "API Error: Connection error." — on rayu-hosted it must read as a
// friendly "can't reach Rayu" instead of the raw SDK string. ---
describe('getAssistantMessageFromError · rayu-hosted connection failure', () => {
  test('hosted: a connection error becomes a friendly "can\'t reach Rayu" message', () => {
    setActiveProvider('rayu-hosted')
    const err = new APIConnectionError({ message: 'Connection error.' })
    const text = textOf(getAssistantMessageFromError(err, 'glm-5.2'))
    expect(text.toLowerCase()).toContain("can't reach rayu")
    expect(text).not.toContain('Connection error.') // not the raw SDK string
  })

  test('BYO: a connection error keeps the normal connection message (not the hosted one)', () => {
    setActiveProvider('byo')
    const err = new APIConnectionError({ message: 'Connection error.' })
    const text = textOf(getAssistantMessageFromError(err, 'deepseek-chat'))
    expect(text).not.toContain("Can't reach Rayu")
  })
})

// Regression for the exact production report: a Cloudflare "origin_bad_gateway"
// 502 (the Go gateway origin was down, so Cloudflare answered before it) on a
// rayu-hosted model must render the friendly message — never the raw Cloudflare
// JSON. This is the precise payload/shape the CLI saw in the wild.
describe('getAssistantMessageFromError · exact Cloudflare origin 502', () => {
  test('hosted: Cloudflare 502 becomes the friendly message, not the raw JSON', () => {
    setActiveProvider('rayu-hosted')
    const cf = {
      type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/',
      title: 'Error 502: Bad gateway',
      status: 502,
      detail:
        'The origin web server returned an invalid or incomplete response to Cloudflare.',
      error_code: 502,
      error_name: 'origin_bad_gateway',
      error_category: 'origin',
      zone: 'gateway.rayucode.com',
      cloudflare_error: true,
    }
    const err = APIError.generate(
      502,
      cf,
      `502 ${JSON.stringify(cf)}`,
      new Headers({ 'content-type': 'application/json' }),
    ) as APIError
    const text = textOf(getAssistantMessageFromError(err, 'kimi-k2.7'))
    expect(text.toLowerCase()).toContain('temporarily unavailable')
    // The raw Cloudflare body must NOT leak to the customer.
    expect(text.toLowerCase()).not.toContain('cloudflare')
    expect(text).not.toContain('origin_bad_gateway')
    expect(text).not.toContain('gateway.rayucode.com')
  })
})

// The compact window shown in the picker: readable at a glance, and never a lie
// (a 1.5M window must not round to "1M").
describe('formatContextTokens', () => {
  test('renders the units admins think in', () => {
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_500_000)).toBe('1.5M')
    expect(formatContextTokens(200_000)).toBe('200K')
    expect(formatContextTokens(128_000)).toBe('128K')
    expect(formatContextTokens(32_768)).toBe('32.8K')
    expect(formatContextTokens(900)).toBe('900')
  })
})

// A newly added model has to show up without relaunching, so the picker refreshes
// the catalog when it opens. That refresh must be harmless when there is nothing
// to fetch (signed out / OAuth off), because a picker has to open regardless.
describe('refreshHostedCatalog', () => {
  test('reports no change and never throws without a session', async () => {
    await expect(refreshHostedCatalog()).resolves.toBe(false)
  })
})
