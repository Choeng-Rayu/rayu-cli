import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  formatRayuCreditsLine,
  formatRayuCreditsSummary,
  type RayuCreditStatus,
} from '../src/services/rayuAuth/rayuCredits.ts'
import { syncRayuHostedProvider } from '../src/services/rayuAuth/rayuHostedProvider.ts'
import type { RayuEntitlements } from '../src/services/rayuAuth/rayuEntitlements.ts'
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
  creditsPerWeek: 500000,
  creditsPer5h: 100000,
  used5h: 1000,
  usedWeek: 5000,
  remaining5h: 99000,
  remainingWeek: 495000,
  reset5hSeconds: 3600,
  resetWeekSeconds: 7200,
  topupBalance: 0,
  topUpEnabled: true,
  ...over,
})

describe('rayu credits formatter', () => {
  test('paid plan summary shows weekly/5h remaining + topup', () => {
    const s = formatRayuCreditsSummary(status())
    expect(s).toContain('Plan: pro')
    expect(s).toContain('495,000 / 500,000')
    expect(s).toContain('resets in 2h 0m')
    expect(s).toContain('Top-up balance: 0')
  })

  test('free plan summary notes no allowance', () => {
    const s = formatRayuCreditsSummary(
      status({
        plan: 'free',
        creditsPerWeek: null,
        creditsPer5h: null,
        remainingWeek: null,
        remaining5h: null,
        topUpEnabled: false,
      }),
    )
    expect(s).toContain('No hosted credit allowance')
  })

  test('compact line format', () => {
    expect(formatRayuCreditsLine(status())).toBe(
      'Rayu: 495,000 credits left this week',
    )
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
