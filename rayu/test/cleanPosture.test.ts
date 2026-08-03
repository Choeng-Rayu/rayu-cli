import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Consolidated "clean posture" invariants — a single place that ties together
// the de-brand / de-risk guarantees delivered by this work. Individual aspects
// also have dedicated tests (rebrand, networkGuard, analyticsEventLogging,
// claudeSubscriptionOAuth, remoteSessionDeClaudeAi); this asserts them together.

const DIST = join(import.meta.dir, '..', 'dist', 'rayu.js')

describe('clean posture', () => {
  test('brand identity is Rayu', async () => {
    const { PRODUCT_NAME, PRODUCT_COMMAND, PRODUCT_CONFIG_DIRNAME } =
      await import('../src/constants/product.ts')
    expect(PRODUCT_NAME).toBe('Rayu-CLI')
    expect(PRODUCT_COMMAND).toBe('rayu')
    expect(PRODUCT_CONFIG_DIRNAME).toBe('.rayu')
  })

  test('telemetry is off by default and analytics gates are neutralized', async () => {
    const prev = process.env.RAYU_TELEMETRY
    const prevOac = process.env.RAYU_OPENAI_COMPATIBLE
    delete process.env.RAYU_TELEMETRY
    delete process.env.RAYU_OPENAI_COMPATIBLE
    try {
      const { isTelemetryDisabled } = await import('../src/utils/privacyLevel.ts')
      expect(isTelemetryDisabled()).toBe(true)

      const gb = await import('../src/services/analytics/growthbook.ts')
      expect(gb.checkStatsigFeatureGate_CACHED_MAY_BE_STALE('any')).toBe(false)
      expect(gb.getFeatureValue_CACHED_MAY_BE_STALE('any', 'DEFAULT')).toBe('DEFAULT')
      expect(await gb.initializeGrowthBook()).toBeNull()

      const fp = await import('../src/services/analytics/firstPartyEventLogger.ts')
      expect(fp.is1PEventLoggingEnabled()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.RAYU_TELEMETRY
      else process.env.RAYU_TELEMETRY = prev
      if (prevOac === undefined) delete process.env.RAYU_OPENAI_COMPATIBLE
      else process.env.RAYU_OPENAI_COMPATIBLE = prevOac
    }
  })

  test('the OAuth authorize URL comes from config, and remote-session host is not claude.ai', async () => {
    // The claude.ai subscription login ("Login with Claude — Pro/Max plan") is
    // SUPPORTED, reachable from /connect. The posture guarantee is narrower now:
    // every endpoint/client id must come from constants/oauth.ts (so a FedStart
    // or local override is honored and nothing is hardcoded at the call site),
    // and the PKCE verifier must never appear in the URL.
    const { buildAuthUrl } = await import('../src/services/oauth/client.ts')
    const { getOauthConfig } = await import('../src/constants/oauth.ts')
    const cfg = getOauthConfig()
    const url = buildAuthUrl({
      codeChallenge: 'a',
      state: 'b',
      port: 0,
      isManual: false,
      loginWithClaudeAi: true,
    })
    expect(url.startsWith(cfg.CLAUDE_AI_AUTHORIZE_URL)).toBe(true)
    expect(url).toContain(encodeURIComponent(cfg.CLIENT_ID))
    expect(url).not.toContain('code_verifier')

    const prevR = process.env.RAYU_REMOTE_SESSION_URL
    const prevW = process.env.RAYU_WEB_URL
    delete process.env.RAYU_REMOTE_SESSION_URL
    delete process.env.RAYU_WEB_URL
    try {
      const { getRemoteSessionUrl } = await import('../src/constants/product.ts')
      expect(getRemoteSessionUrl('session_x')).not.toContain('claude.ai')
    } finally {
      if (prevR !== undefined) process.env.RAYU_REMOTE_SESSION_URL = prevR
      if (prevW !== undefined) process.env.RAYU_WEB_URL = prevW
    }
  })

  test('built bundle contains no GrowthBook SDK import', () => {
    // dist/rayu.js is produced by `bun run build` (the verification flow builds
    // before testing). Skip cleanly if it has not been built.
    if (!existsSync(DIST)) return
    const bundle = readFileSync(DIST, 'utf8')
    expect(bundle).not.toMatch(/from\s*["']@growthbook\/growthbook["']/)
    expect(bundle).not.toMatch(/require\(\s*["']@growthbook\/growthbook["']\s*\)/)
  })
})
