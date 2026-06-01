import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
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
