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
import { loadRayuConfig } from '../src/utils/rayuConfig.ts'

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
    expect(s).toContain('Plan: Pro ($10/mo)')
    expect(s).toContain('1 / 50 used')
    expect(s).toContain('49 left')
    expect(s).toContain('5,000,000')
    expect(s).toContain('Top-up balance: 0')
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
    expect(s).toContain('Daily turns: 12 / 50 used')
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
})
