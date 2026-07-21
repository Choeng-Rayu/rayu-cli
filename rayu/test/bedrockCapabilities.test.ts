import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Regression for the Bedrock Haiku 400s: native Claude models on a 3P provider
// (Bedrock) must use canonical per-family capability gating, NOT the blanket
// "any non-Anthropic provider supports everything" path. Haiku on Bedrock must
// report NO thinking/adaptive-thinking/effort so the CLI never sends those
// unsupported params (which made AWS Bedrock 400). Sonnet/Opus 4.6 keep them.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-bedrock-cap-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_USE_BEDROCK
})

async function withBedrockAnthropic() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  cfg.upsertProvider(
    {
      id: 'bedrock-anthropic',
      kind: 'bedrock',
      bedrockApi: 'anthropic',
      apiKey: 'test',
      awsRegion: 'us-east-1',
    } as never,
    true,
  )
}

const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
const SONNET = 'us.anthropic.claude-sonnet-4-6-v1'
const OPUS = 'us.anthropic.claude-opus-4-6-v1'

describe('Bedrock native-Claude capability gating', () => {
  test('Haiku on Bedrock reports NO thinking / adaptive / effort / maxEffort', async () => {
    await withBedrockAnthropic()
    const t = await import('../src/utils/thinking.ts')
    const e = await import('../src/utils/effort.ts')
    expect(t.modelSupportsThinking(HAIKU)).toBe(false)
    expect(t.modelSupportsAdaptiveThinking(HAIKU)).toBe(false)
    expect(e.modelSupportsEffort(HAIKU)).toBe(false)
    expect(e.modelSupportsMaxEffort(HAIKU)).toBe(false)
  })

  test('Sonnet 4.6 on Bedrock keeps thinking + adaptive + effort', async () => {
    await withBedrockAnthropic()
    const t = await import('../src/utils/thinking.ts')
    const e = await import('../src/utils/effort.ts')
    expect(t.modelSupportsThinking(SONNET)).toBe(true)
    expect(t.modelSupportsAdaptiveThinking(SONNET)).toBe(true)
    expect(e.modelSupportsEffort(SONNET)).toBe(true)
  })

  test('Opus 4.6 on Bedrock keeps thinking + adaptive + effort + maxEffort', async () => {
    await withBedrockAnthropic()
    const t = await import('../src/utils/thinking.ts')
    const e = await import('../src/utils/effort.ts')
    expect(t.modelSupportsThinking(OPUS)).toBe(true)
    expect(t.modelSupportsAdaptiveThinking(OPUS)).toBe(true)
    expect(e.modelSupportsEffort(OPUS)).toBe(true)
    expect(e.modelSupportsMaxEffort(OPUS)).toBe(true)
  })

  test('a NON-Claude model on Bedrock (converse) still supports thinking + effort', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    cfg.upsertProvider(
      {
        id: 'bedrock',
        kind: 'bedrock',
        bedrockApi: 'converse',
        apiKey: 'test',
        awsRegion: 'us-east-1',
      } as never,
      true,
    )
    const t = await import('../src/utils/thinking.ts')
    const e = await import('../src/utils/effort.ts')
    expect(t.modelSupportsThinking('deepseek-r1')).toBe(true)
    expect(e.modelSupportsEffort('deepseek-r1')).toBe(true)
  })
})
