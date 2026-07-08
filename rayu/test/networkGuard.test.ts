import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Rayu must not emit telemetry/analytics by default. These guards assert the
// privacy posture rather than mocking sockets (the analytics sink is null
// unless explicitly attached, and isAnalyticsDisabled gates all egress).
const saved = {
  rayu: process.env.RAYU_TELEMETRY,
  disable: process.env.DISABLE_TELEMETRY,
  noness: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  node: process.env.NODE_ENV,
  oac: process.env.RAYU_OPENAI_COMPATIBLE,
  cfg: process.env.RAYU_CONFIG_DIR,
}
// Isolate config so getPrivacyLevel does not read a real ~/.rayu provider
// (an active OpenAI-compatible provider correctly forces essential-traffic).
let tmp: string
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rayu-net-'))
  process.env.RAYU_CONFIG_DIR = tmp
  delete process.env.RAYU_OPENAI_COMPATIBLE
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env.RAYU_TELEMETRY = saved.rayu
  process.env.DISABLE_TELEMETRY = saved.disable
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = saved.noness
  process.env.NODE_ENV = saved.node
  if (saved.oac === undefined) delete process.env.RAYU_OPENAI_COMPATIBLE
  else process.env.RAYU_OPENAI_COMPATIBLE = saved.oac
  if (saved.cfg === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = saved.cfg
})

describe('network guard: telemetry off by default', () => {
  test('privacy level is no-telemetry unless RAYU_TELEMETRY=1', async () => {
    delete process.env.RAYU_TELEMETRY
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    const { getPrivacyLevel, isTelemetryDisabled } = await import(
      '../src/utils/privacyLevel.ts'
    )
    expect(getPrivacyLevel()).toBe('no-telemetry')
    expect(isTelemetryDisabled()).toBe(true)
  })

  test('opt-in re-enables default privacy level', async () => {
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.RAYU_TELEMETRY = '1'
    const { getPrivacyLevel } = await import('../src/utils/privacyLevel.ts')
    expect(getPrivacyLevel()).toBe('default')
  })

  test('config home resolves under ~/.rayu (never ~/.claude) by default', async () => {
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    const { getRayuConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const dir = getRayuConfigHomeDir()
    expect(dir.endsWith('/.rayu')).toBe(true)
    expect(dir.endsWith('/.claude')).toBe(false)
  })

  test('openai-compatible provider forces essential-traffic (no Anthropic egress)', async () => {
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.RAYU_TELEMETRY
    process.env.RAYU_OPENAI_COMPATIBLE = '1'
    try {
      const { getPrivacyLevel, isEssentialTrafficOnly } = await import(
        '../src/utils/privacyLevel.ts'
      )
      expect(getPrivacyLevel()).toBe('essential-traffic')
      expect(isEssentialTrafficOnly()).toBe(true)
    } finally {
      delete process.env.RAYU_OPENAI_COMPATIBLE
    }
  })
})


describe('telemetry gate module is neutralized (no analytics client, no SDK)', () => {
  afterEach(() => {
    if (saved.rayu === undefined) delete process.env.RAYU_TELEMETRY
    else process.env.RAYU_TELEMETRY = saved.rayu
  })

  test('gate/feature reads return caller defaults even with RAYU_TELEMETRY=1', async () => {
    // Even if a user opts telemetry back on, there is no flag service: every
    // gate/feature read must resolve to the caller's own default.
    process.env.RAYU_TELEMETRY = '1'
    const gb = await import('../src/services/analytics/growthbook.ts')
    expect(gb.getFeatureValue_CACHED_MAY_BE_STALE('any_flag', 'DEFAULT')).toBe('DEFAULT')
    expect(gb.getFeatureValue_CACHED_MAY_BE_STALE('any_flag', 123)).toBe(123)
    expect(gb.getFeatureValue_CACHED_WITH_REFRESH('any_flag', true, 1000)).toBe(true)
    expect(gb.getDynamicConfig_CACHED_MAY_BE_STALE('cfg', { x: 1 })).toEqual({ x: 1 })
    expect(gb.checkStatsigFeatureGate_CACHED_MAY_BE_STALE('any_gate')).toBe(false)
    expect(await gb.checkGate_CACHED_OR_BLOCKING('any_gate')).toBe(false)
    expect(await gb.checkSecurityRestrictionGate('any_gate')).toBe(false)
    expect(await gb.getDynamicConfig_BLOCKS_ON_INIT('cfg', 'd')).toBe('d')
    expect(gb.hasGrowthBookEnvOverride('x')).toBe(false)
    expect(gb.getAllGrowthBookFeatures()).toEqual({})
    expect(gb.getGrowthBookConfigOverrides()).toEqual({})
  })

  test('no GrowthBook client is ever constructed (initializeGrowthBook resolves null)', async () => {
    process.env.RAYU_TELEMETRY = '1'
    const gb = await import('../src/services/analytics/growthbook.ts')
    expect(await gb.initializeGrowthBook()).toBeNull()
    // onGrowthBookRefresh returns a callable no-op unsubscribe.
    const unsub = gb.onGrowthBookRefresh(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  test('gate module imports no analytics SDK or first-party event logger', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'analytics', 'growthbook.ts'),
      'utf8',
    )
    // Assert on real import statements (the explanatory header comment may name
    // the removed dependencies).
    expect(src).not.toMatch(/\bfrom\s+['"]@growthbook\/growthbook['"]/)
    expect(src).not.toMatch(/\bfrom\s+['"][^'"]*firstPartyEventLogger[^'"]*['"]/)
  })
})
