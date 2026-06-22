import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Soft paid-gating: a Free user should still SEE the image/video tools (so the
// model can offer them) but the prompt carries an upgrade note and execution is
// refused. Paid users and the OAuth-off (BYOK) path are unchanged.
//
// The upgrade target's plan NAME + PRICE are NOT hardcoded — they come from the
// admin-configured plan catalog (GET /plans). These tests feed that catalog via
// the test hook and assert the copy reflects it dynamically.

const IMG_KEY = 'image_generation'
const VID_KEY = 'video_generation'

// NVIDIA media env keys cleared so a stray host key can't skew isEnabled().
const MEDIA_ENV = [
  'FAL_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
]

// As GET /plans would return it: the cheapest ACTIVE plan with price > 0 is the
// upgrade target. Here that's "Basic" at $3 — chosen dynamically, not hardcoded.
const CATALOG = [
  { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
  { code: 'basic', name: 'Basic', priceCents: 300, availability: 'active' },
  { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active' },
  { code: 'enterprise', name: 'Enterprise', priceCents: 0, availability: 'coming_soon' },
]

let dir: string
let saved: Record<string, string | undefined>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-paidgate-'))
  process.env.RAYU_CONFIG_DIR = dir
  delete process.env.USE_RAYU_OAUTH
  saved = {}
  for (const k of MEDIA_ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // An image/video backend IS configured, so isEnabled() is capability-true
  // regardless of plan — the whole point of the soft gate.
  saved.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY
  process.env.NVIDIA_API_KEY = 'nv-test-key'
  // Default: admin catalog is known, so messages name the real upgrade target.
  const cat = await import('../src/services/rayuAuth/rayuPlansCatalog.ts')
  cat._setPlansCatalogForTesting(CATALOG)
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  for (const k of [...MEDIA_ENV, 'NVIDIA_API_KEY']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  const m = await import('../src/services/rayuAuth/rayuEntitlements.ts')
  m._resetRayuEntitlementsForTesting()
  const cat = await import('../src/services/rayuAuth/rayuPlansCatalog.ts')
  cat._resetPlansCatalogForTesting()
  const fu = await import('../src/services/rayuAuth/rayuFeatureUsage.ts')
  fu._resetFeatureUsageForTesting()
})

/** Entitlement cache for a plan where image/video are enabled (paid) or not (free). */
const planEnt = (enabled: boolean) => ({
  plan: enabled
    ? { code: 'basic', name: 'Basic', priceCents: 300, availability: 'active' }
    : { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
  maxDailyTurns: enabled ? null : 50,
  features: {
    image_generation: { enabled },
    video_generation: { enabled },
  },
})

async function ents() {
  return await import('../src/services/rayuAuth/rayuEntitlements.ts')
}
async function gate() {
  return await import('../src/services/rayuAuth/paidFeatureGate.ts')
}
async function catalog() {
  return await import('../src/services/rayuAuth/rayuPlansCatalog.ts')
}
async function usage() {
  return await import('../src/services/rayuAuth/rayuFeatureUsage.ts')
}
async function tools() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const { ImageGenTool } = await import('../src/tools/ImageGenTool/ImageGenTool.ts')
  const { VideoGenTool } = await import('../src/tools/VideoGenTool/VideoGenTool.ts')
  return { ImageGenTool, VideoGenTool }
}

describe('getEntryPaidPlan (admin-configured upgrade target)', () => {
  test('picks the cheapest ACTIVE plan with price > 0', async () => {
    const c = await catalog()
    expect(c.getEntryPaidPlan()?.code).toBe('basic')
  })

  test('null when no purchasable plan is configured', async () => {
    const c = await catalog()
    c._setPlansCatalogForTesting([
      { code: 'free', name: 'Free', priceCents: 0, availability: 'active' },
      { code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon' },
    ])
    expect(c.getEntryPaidPlan()).toBeNull()
  })
})

describe('isPaidFeatureLocked', () => {
  test('OAuth OFF -> never locked (BYOK path unchanged)', async () => {
    const g = await gate()
    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(false)
    expect(g.isPaidFeatureLocked(VID_KEY)).toBe(false)
  })

  test('OAuth ON + Free plan -> locked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(false))
    const g = await gate()
    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(true)
    expect(g.isPaidFeatureLocked(VID_KEY)).toBe(true)
  })

  test('OAuth ON + Basic (paid) plan -> not locked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    const g = await gate()
    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(false)
    expect(g.isPaidFeatureLocked(VID_KEY)).toBe(false)
  })
})

describe('upgrade copy is admin-driven, not hardcoded', () => {
  test('names the configured entry plan + price', async () => {
    const g = await gate()
    expect(g.upgradeTargetLabel()).toBe('the Basic plan ($3/mo)')

    const note = g.paidFeatureUpgradeNote('image generation')
    expect(note).toContain('Basic')
    expect(note).toContain('$3')
    expect(note.toLowerCase()).toContain('upgrade')
    expect(note).toContain('image generation')

    expect(g.paidFeatureDescriptionSuffix()).toContain('Basic')
    expect(g.paidFeatureDescriptionSuffix()).toContain('$3')

    const msg = g.paidFeatureBlockedMessage('image generation')
    expect(msg).toContain('Basic')
    expect(msg).toContain('$3')
    expect(msg.toLowerCase()).toContain('upgrade')
  })

  test('reflects a DIFFERENT admin-configured plan (proves not hardcoded)', async () => {
    ;(await catalog())._setPlansCatalogForTesting([
      { code: 'starter', name: 'Starter', priceCents: 500, availability: 'active' },
    ])
    const g = await gate()
    expect(g.upgradeTargetLabel()).toBe('the Starter plan ($5/mo)')
    const note = g.paidFeatureUpgradeNote('image generation')
    expect(note).toContain('Starter')
    expect(note).toContain('$5')
    expect(note).not.toContain('Basic')
  })

  test('no catalog -> generic "a paid plan", no hardcoded name/price', async () => {
    ;(await catalog())._setPlansCatalogForTesting(null)
    const g = await gate()
    expect(g.upgradeTargetLabel()).toBe('a paid plan')
    const note = g.paidFeatureUpgradeNote('image generation')
    expect(note).toContain('a paid plan')
    expect(note).not.toContain('Basic')
    expect(note).not.toContain('$')
    const msg = g.paidFeatureBlockedMessage('image generation')
    expect(msg).toContain('a paid plan')
    expect(msg).not.toContain('$')
  })
})

describe('ImageGenTool soft gating', () => {
  test('Free user: visible, prompt note + description suffix, call blocked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(false))
    const { ImageGenTool } = await tools()

    // The model can still SEE the tool.
    expect(ImageGenTool.isEnabled()).toBe(true)

    const prompt = await ImageGenTool.prompt()
    expect(prompt).toContain('Paid feature')
    expect(prompt).toContain('Basic')
    expect(prompt).toContain('$3')
    expect(prompt.toLowerCase()).toContain('upgrade')

    const desc = await ImageGenTool.description()
    expect(desc).toContain('Basic')

    // But execution is refused with an upgrade ask.
    await expect(
      ImageGenTool.call(
        { prompt: 'a cat' } as never,
        { abortController: new AbortController() } as never,
      ),
    ).rejects.toThrow(/Basic plan/)
  })

  test('Basic (paid) user: visible, no paid note, base prompt/description', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    const { ImageGenTool } = await tools()
    const g = await gate()

    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(false)
    expect(await ImageGenTool.prompt()).not.toContain('Paid feature')
    expect(await ImageGenTool.description()).not.toContain('Requires')
  })

  test('OAuth OFF: base prompt/description (no gating)', async () => {
    const { ImageGenTool } = await tools()
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(await ImageGenTool.prompt()).not.toContain('Paid feature')
    expect(await ImageGenTool.description()).not.toContain('Requires')
  })
})

describe('VideoGenTool soft gating', () => {
  test('Free user: visible, prompt note, call blocked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(false))
    const { VideoGenTool } = await tools()

    expect(VideoGenTool.isEnabled()).toBe(true)

    const prompt = await VideoGenTool.prompt()
    expect(prompt).toContain('Paid feature')
    expect(prompt).toContain('Basic')
    expect(prompt).toContain('$3')

    await expect(
      VideoGenTool.call(
        { prompt: 'a river' } as never,
        { abortController: new AbortController() } as never,
      ),
    ).rejects.toThrow(/Basic plan/)
  })

  test('Basic (paid) user: no paid note, not locked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    const { VideoGenTool } = await tools()
    const g = await gate()

    expect(VideoGenTool.isEnabled()).toBe(true)
    expect(g.isPaidFeatureLocked(VID_KEY)).toBe(false)
    expect(await VideoGenTool.prompt()).not.toContain('Paid feature')
  })
})

describe('rayuFeatureUsage cache', () => {
  test('getFeatureUsage returns set values; unknown key + null cache -> null', async () => {
    const fu = await usage()
    fu._setFeatureUsageForTesting({ image_generation: { used: 4, limit: 10 } })
    expect(fu.getFeatureUsage('image_generation')).toEqual({ used: 4, limit: 10 })
    expect(fu.getFeatureUsage('video_generation')).toBeNull()
    fu._setFeatureUsageForTesting(null)
    expect(fu.getFeatureUsage('image_generation')).toBeNull()
  })

  test('bumpFeatureUsage increments the cached used count in-session', async () => {
    const fu = await usage()
    fu._setFeatureUsageForTesting({ image_generation: { used: 4, limit: 10 } })
    fu.bumpFeatureUsage('image_generation')
    expect(fu.getFeatureUsage('image_generation')).toEqual({ used: 5, limit: 10 })
    // no-op for an uncached feature
    fu.bumpFeatureUsage('video_generation')
    expect(fu.getFeatureUsage('video_generation')).toBeNull()
  })
})

describe('featureLimitReached (monthly numeric cap)', () => {
  test('enabled + under limit -> false; at/over limit -> true', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true)) // image enabled
    const g = await gate()
    const fu = await usage()

    fu._setFeatureUsageForTesting({ image_generation: { used: 3, limit: 10 } })
    expect(g.featureLimitReached(IMG_KEY)).toBe(false)

    fu._setFeatureUsageForTesting({ image_generation: { used: 10, limit: 10 } })
    expect(g.featureLimitReached(IMG_KEY)).toBe(true)

    fu._setFeatureUsageForTesting({ image_generation: { used: 99, limit: 10 } })
    expect(g.featureLimitReached(IMG_KEY)).toBe(true)
  })

  test('unlimited (limit null) -> never reached', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    const g = await gate()
    ;(await usage())._setFeatureUsageForTesting({
      image_generation: { used: 9999, limit: null },
    })
    expect(g.featureLimitReached(IMG_KEY)).toBe(false)
  })

  test('disabled feature -> not a limit case (lock path handles it)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(false)) // image disabled
    const g = await gate()
    ;(await usage())._setFeatureUsageForTesting({
      image_generation: { used: 10, limit: 10 },
    })
    expect(g.featureLimitReached(IMG_KEY)).toBe(false)
    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(true)
  })

  test('OAuth off -> never reached (fail open)', async () => {
    const g = await gate()
    ;(await usage())._setFeatureUsageForTesting({
      image_generation: { used: 10, limit: 10 },
    })
    expect(g.featureLimitReached(IMG_KEY)).toBe(false)
  })
})

describe('ImageGenTool monthly-limit gating', () => {
  test('enabled + limit reached: prompt note + call blocked with limit message', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true)) // enabled
    ;(await usage())._setFeatureUsageForTesting({
      image_generation: { used: 10, limit: 10 },
    })
    const { ImageGenTool } = await tools()

    expect(ImageGenTool.isEnabled()).toBe(true)
    const prompt = await ImageGenTool.prompt()
    expect(prompt.toLowerCase()).toContain('limit reached')
    expect(prompt).toContain('10/10')
    expect(prompt.toLowerCase()).toContain('upgrade')
    expect(prompt).not.toContain('Paid feature') // not the disabled/locked note

    const desc = await ImageGenTool.description()
    expect(desc.toLowerCase()).toContain('limit reached')

    await expect(
      ImageGenTool.call(
        { prompt: 'a cat' } as never,
        { abortController: new AbortController() } as never,
      ),
    ).rejects.toThrow(/limit reached/i)
  })

  test('enabled + under limit: base prompt, gate does not fire', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    ;(await usage())._setFeatureUsageForTesting({
      image_generation: { used: 2, limit: 10 },
    })
    const { ImageGenTool } = await tools()
    const g = await gate()

    expect(g.isPaidFeatureLocked(IMG_KEY)).toBe(false)
    expect(g.featureLimitReached(IMG_KEY)).toBe(false)
    const prompt = await ImageGenTool.prompt()
    expect(prompt).not.toContain('Paid feature')
    expect(prompt.toLowerCase()).not.toContain('limit reached')
  })
})

describe('VideoGenTool monthly-limit gating', () => {
  test('enabled + limit reached: prompt note + call blocked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    ;(await ents())._setRayuEntitlementsForTesting(planEnt(true))
    ;(await usage())._setFeatureUsageForTesting({
      video_generation: { used: 5, limit: 5 },
    })
    const { VideoGenTool } = await tools()

    expect(VideoGenTool.isEnabled()).toBe(true)
    const prompt = await VideoGenTool.prompt()
    expect(prompt.toLowerCase()).toContain('limit reached')
    expect(prompt).toContain('5/5')

    await expect(
      VideoGenTool.call(
        { prompt: 'a river' } as never,
        { abortController: new AbortController() } as never,
      ),
    ).rejects.toThrow(/limit reached/i)
  })
})
