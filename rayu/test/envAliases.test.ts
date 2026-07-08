import { afterEach, describe, expect, test } from 'bun:test'

// Env-var back-compat contract: RAYU_* is the canonical interface; the legacy
// CLAUDE_CODE_* / CLAUDE_* names inherited from upstream remain honored as
// READ-ONLY fallback aliases (interop + existing users) but never win over an
// explicitly-set RAYU_* value.

const TOUCHED = [
  'RAYU_FOO',
  'CLAUDE_FOO',
  'CLAUDE_BAR',
  'RAYU_SIMPLE',
  'CLAUDE_CODE_SIMPLE',
  'RAYU_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'RAYU_TELEMETRY',
  'RAYU_OPENAI_COMPATIBLE',
] as const

const saved: Record<string, string | undefined> = {}
for (const k of TOUCHED) saved[k] = process.env[k]
function reset(): void {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}
afterEach(reset)

describe('env var back-compat: RAYU_ canonical, CLAUDE_ legacy fallback', () => {
  test('getEnvWithLegacyAlias: canonical wins, legacy is fallback', async () => {
    const { getEnvWithLegacyAlias } = await import('../src/utils/envUtils.ts')
    for (const k of TOUCHED) delete process.env[k]

    expect(getEnvWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO', 'CLAUDE_BAR')).toBeUndefined()

    process.env.CLAUDE_BAR = 'from-legacy-2'
    expect(getEnvWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO', 'CLAUDE_BAR')).toBe('from-legacy-2')

    process.env.CLAUDE_FOO = 'from-legacy-1'
    expect(getEnvWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO', 'CLAUDE_BAR')).toBe('from-legacy-1')

    process.env.RAYU_FOO = 'canonical'
    expect(getEnvWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO', 'CLAUDE_BAR')).toBe('canonical')
  })

  test('isEnvTruthyWithLegacyAlias: explicit RAYU_ false overrides legacy true', async () => {
    const { isEnvTruthyWithLegacyAlias } = await import('../src/utils/envUtils.ts')
    for (const k of TOUCHED) delete process.env[k]

    process.env.CLAUDE_FOO = '1'
    expect(isEnvTruthyWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO')).toBe(true)

    process.env.RAYU_FOO = '0'
    expect(isEnvTruthyWithLegacyAlias('RAYU_FOO', 'CLAUDE_FOO')).toBe(false)
  })

  test('isBareMode honors canonical RAYU_SIMPLE and legacy CLAUDE_CODE_SIMPLE', async () => {
    const { isBareMode } = await import('../src/utils/envUtils.ts')
    delete process.env.RAYU_SIMPLE
    delete process.env.CLAUDE_CODE_SIMPLE
    const bareViaArgv = process.argv.includes('--bare')
    if (!bareViaArgv) expect(isBareMode()).toBe(false)

    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(isBareMode()).toBe(true)

    process.env.CLAUDE_CODE_SIMPLE = '0'
    process.env.RAYU_SIMPLE = '1'
    expect(isBareMode()).toBe(true)
  })

  test('RAYU_DISABLE_NONESSENTIAL_TRAFFIC is canonical; legacy alias still honored', async () => {
    const { getPrivacyLevel, getEssentialTrafficOnlyReason } = await import(
      '../src/utils/privacyLevel.ts'
    )
    for (const k of TOUCHED) delete process.env[k]

    // Legacy alias alone still forces essential-traffic.
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(getEssentialTrafficOnlyReason()).toBe('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')

    // Canonical RAYU_ name works and is reported as the reason.
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.RAYU_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(getEssentialTrafficOnlyReason()).toBe('RAYU_DISABLE_NONESSENTIAL_TRAFFIC')
  })
})
