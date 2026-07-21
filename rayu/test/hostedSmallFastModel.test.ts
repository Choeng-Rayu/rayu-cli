import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Multi-provider regression: the small/fast (and default) model must belong to
// the ACTIVE provider. A rayu-hosted session (e.g. GLM-5.2 via Ollama Cloud)
// must NOT fall back to a hardcoded Anthropic Haiku (claude-haiku-4-5-20251001)
// for background/utility work — the gateway rejects that with
// `not allowed for plan` (403), which is what the user saw interleaved with
// their GLM-5.2 traffic. Anthropic/Bedrock keep the (valid) Claude Haiku.

const ANTHROPIC_HAIKU = 'claude-haiku-4-5-20251001'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-smallfast-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const state = await import('../src/bootstrap/state.ts')
  state.resetModelStringsForTestingOnly()
  return cfg
}

describe('getSmallFastModel is provider-aware (multi-provider)', () => {
  test('rayu-hosted (GLM-5.2): uses the hosted small/fast model, NOT a hardcoded Anthropic Haiku', async () => {
    const cfg = await fresh()
    cfg.upsertProvider(
      {
        id: 'rayu-hosted',
        kind: 'rayu-hosted',
        defaultModel: 'glm-5.2',
        smallFastModel: 'glm-5.2',
      } as never,
      true,
    )
    const { getSmallFastModel } = await import('../src/utils/model/model.ts')
    const m = getSmallFastModel()
    expect(m).toBe('glm-5.2')
    expect(m).not.toBe(ANTHROPIC_HAIKU)
    expect(m.toLowerCase()).not.toContain('claude')
  })

  test('rayu-hosted without a smallFastModel: falls back to the provider default (still not Claude)', async () => {
    const cfg = await fresh()
    cfg.upsertProvider(
      { id: 'rayu-hosted', kind: 'rayu-hosted', defaultModel: 'kimi-k2.7' } as never,
      true,
    )
    const { getSmallFastModel } = await import('../src/utils/model/model.ts')
    const m = getSmallFastModel()
    expect(m).toBe('kimi-k2.7')
    expect(m.toLowerCase()).not.toContain('claude')
  })

  test('anthropic provider still uses the (valid) Claude Haiku', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'a' } as never, true)
    const { getSmallFastModel } = await import('../src/utils/model/model.ts')
    expect(getSmallFastModel()).toBe(ANTHROPIC_HAIKU)
  })

  test('bedrock keeps the provider-correct (valid) Claude Haiku id', async () => {
    const cfg = await fresh()
    cfg.upsertProvider(
      {
        id: 'bedrock-anthropic',
        kind: 'bedrock',
        bedrockApi: 'anthropic',
        apiKey: 'bearer',
        awsRegion: 'us-east-1',
      } as never,
      true,
    )
    const { getSmallFastModel } = await import('../src/utils/model/model.ts')
    const m = getSmallFastModel()
    // Bedrock DOES serve Claude Haiku — keep it, but as the Bedrock id, not the
    // bare first-party id.
    expect(m.toLowerCase()).toContain('haiku')
    expect(m).not.toBe(ANTHROPIC_HAIKU)
  })
})

describe('getDefaultMainLoopModelSetting is provider-aware', () => {
  test('rayu-hosted default is the hosted model, not a hardcoded Claude', async () => {
    const cfg = await fresh()
    cfg.upsertProvider(
      {
        id: 'rayu-hosted',
        kind: 'rayu-hosted',
        defaultModel: 'glm-5.2',
        smallFastModel: 'glm-5.2',
      } as never,
      true,
    )
    const { getDefaultMainLoopModelSetting } = await import('../src/utils/model/model.ts')
    const m = getDefaultMainLoopModelSetting()
    expect(m).toBe('glm-5.2')
    expect(m.toLowerCase()).not.toContain('claude')
  })
})
