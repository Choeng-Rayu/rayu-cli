import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ent-'))
  process.env.RAYU_CONFIG_DIR = dir
  delete process.env.USE_RAYU_OAUTH
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
  m._resetRayuEntitlementsForTesting()
})

const ent = (features: Record<string, { enabled: boolean; limit?: number | null }>) => ({
  plan: { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
  maxDailyTurns: 50,
  features,
})

describe('rayuFeatureAllowed', () => {
  test('flag OFF -> always allowed even if cache disables it', async () => {
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(ent({ telegram: { enabled: false } }))
    expect(m.rayuFeatureAllowed('telegram')).toBe(true)
  })

  test('flag ON + signed out + no entitlements -> allowed (login gate governs)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._resetRayuEntitlementsForTesting()
    // no session in temp dir -> not signed in -> gating doesn't double-block
    expect(m.rayuFeatureAllowed('telegram')).toBe(true)
  })

  test('flag ON + signed in + NO entitlements -> DENIED (closes cold-start hole)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const sess = await import('../src/services/rayuAuth/rayuSession.ts')
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    sess.writeRayuSession({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600_000,
      user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
    })
    m._resetRayuEntitlementsForTesting()
    // Signed in but entitlements not yet known: a free user must NOT slip
    // through before the first fetch. Gated features are denied.
    expect(m.rayuFeatureAllowed('telegram')).toBe(false)
    expect(m.rayuFeatureAllowed('image_generation')).toBe(false)
  })

  test('flag ON + feature disabled by admin -> blocked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(
      ent({ telegram: { enabled: false }, image_generation: { enabled: true } }),
    )
    expect(m.rayuFeatureAllowed('telegram')).toBe(false)
    expect(m.rayuFeatureAllowed('image_generation')).toBe(true)
  })

  test('flag ON + unknown feature key -> allowed', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(ent({ telegram: { enabled: false } }))
    expect(m.rayuFeatureAllowed('not_a_feature')).toBe(true)
  })

  test('clearRayuEntitlements empties the cache', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(ent({ telegram: { enabled: false } }))
    expect(m.getCachedEntitlements()).not.toBeNull()
    m.clearRayuEntitlements()
    expect(m.getCachedEntitlements()).toBeNull()
  })

  test('discards a cache minted for a different signed-in user', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const sess = await import('../src/services/rayuAuth/rayuSession.ts')
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // Current session is user #1.
    sess.writeRayuSession({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600_000,
      user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
    })
    // Cache claims to belong to user #999 -> must be discarded, not trusted.
    m._setRayuEntitlementsForTesting({ ...ent({ telegram: { enabled: true } }), userId: 999 })
    expect(m.getCachedEntitlements()).toBeNull()
  })
})

describe('command-level gating (wiring)', () => {
  test('telegram-bot command isEnabled follows admin entitlements', async () => {
    const ents = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    const telegram = (await import('../src/commands/telegram-bot/index.ts')).default

    // Flag off -> command enabled regardless of entitlements.
    delete process.env.USE_RAYU_OAUTH
    ents._resetRayuEntitlementsForTesting()
    expect(telegram.isEnabled?.()).toBe(true)

    // Flag on + admin disabled telegram -> command hidden.
    process.env.USE_RAYU_OAUTH = 'true'
    ents._setRayuEntitlementsForTesting(ent({ telegram: { enabled: false } }))
    expect(telegram.isEnabled?.()).toBe(false)

    // Flag on + admin enabled telegram -> command visible.
    ents._setRayuEntitlementsForTesting(ent({ telegram: { enabled: true } }))
    expect(telegram.isEnabled?.()).toBe(true)
  })
})

describe('stale cache refresh (plan upgrade)', () => {
  test('a persisted Free cache refreshes to the upgraded plan (telegram unlocks)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const sess = await import('../src/services/rayuAuth/rayuSession.ts')
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')

    // Signed in as user #1.
    sess.writeRayuSession({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600_000,
      user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
    })

    // Stale FREE cache (telegram disabled) belonging to user #1 — the state of a
    // user who logged in before upgrading.
    m._resetRayuEntitlementsForTesting()
    m._setRayuEntitlementsForTesting({
      ...ent({ telegram: { enabled: false } }),
      userId: 1,
    })
    expect(m.rayuFeatureAllowed('telegram')).toBe(false) // before refresh

    // Backend now returns the upgraded Basic plan (telegram enabled).
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        plan: { code: 'basic', name: 'Basic', priceCents: 300, availability: 'active' },
        maxDailyTurns: null,
        features: { telegram: { enabled: true } },
      }),
    })) as unknown as typeof fetch

    try {
      // Reading the cache must kick a background refresh even though the cache
      // is non-null (the bug: it only refreshed when empty).
      m.getCachedEntitlements()
      await new Promise((r) => setTimeout(r, 50))
      const updated = m.getCachedEntitlements()
      expect(updated?.plan.code).toBe('basic')
      expect(m.rayuFeatureAllowed('telegram')).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('credit allowance shape', () => {
  test('creditAllowance round-trips with creditsPerPeriod (no legacy weekly fields)', async () => {
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting({
      ...ent({ telegram: { enabled: true } }),
      creditAllowance: { creditsPerPeriod: 50, topUpEnabled: true },
      creditConfig: { baselineCreditsPer1M: 1000, tokensPerCredit: 1000 },
    })
    const cached = m.getCachedEntitlements()
    expect(cached?.creditAllowance?.creditsPerPeriod).toBe(50)
    expect(cached?.creditAllowance?.topUpEnabled).toBe(true)
    expect(cached?.creditConfig?.tokensPerCredit).toBe(1000)
    // Legacy windowed fields must not exist on the typed shape.
    expect((cached?.creditAllowance as Record<string, unknown>)?.creditsPerWeek).toBeUndefined()
  })
})

describe('hosted model entitlement', () => {
  const hostedEnt = (allowedCodes: string[]) => ({
    plan: { code: allowedCodes.length ? 'pro' : 'free', name: 'P', priceCents: 0, availability: 'active' },
    maxDailyTurns: null,
    features: {},
    allowedModels: allowedCodes.map((c) => ({ code: c, label: c, provider: 'deepseek', creditMultiplier: 1 })),
    hostedModels: [
      { code: 'deepseek-v4-flash', label: 'f', provider: 'deepseek', creditMultiplier: 0.33 },
      { code: 'deepseek-v4-pro', label: 'p', provider: 'deepseek', creditMultiplier: 1 },
    ],
  })

  test('flag OFF -> entitled (gating off)', async () => {
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(hostedEnt([]))
    expect(m.isHostedModelEntitled('deepseek-v4-pro')).toBe(true)
  })

  test('flag ON + free (no allowed models) -> NOT entitled', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(hostedEnt([]))
    expect(m.isHostedModelEntitled('deepseek-v4-pro')).toBe(false)
  })

  test('flag ON + paid (model in allowed) -> entitled; other model -> not', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._setRayuEntitlementsForTesting(hostedEnt(['deepseek-v4-pro']))
    expect(m.isHostedModelEntitled('deepseek-v4-pro')).toBe(true)
    expect(m.isHostedModelEntitled('deepseek-v4-flash')).toBe(false)
  })

  test('flag ON + no entitlements cached -> fail open (entitled)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    m._resetRayuEntitlementsForTesting()
    expect(m.isHostedModelEntitled('deepseek-v4-pro')).toBe(true)
  })

  test('upgrade message includes the /plans link', async () => {
    process.env.RAYU_WEB_URL = 'https://web.example.test'
    const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    const msg = m.hostedModelUpgradeMessage()
    expect(msg).toContain('https://web.example.test/plans')
    delete process.env.RAYU_WEB_URL
  })
})
