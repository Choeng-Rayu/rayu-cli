import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ctx-'))
  process.env.RAYU_CONFIG_DIR = dir
  delete process.env.RAYU_CONTEXT_TOKENS
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

async function fresh() {
  const m = await import('../src/utils/rayuConfig.ts')
  m._resetRayuConfigCache()
  return m
}

describe('getRayuModelContextWindow — Gemini 1M', () => {
  test('gemini-3.5-flash resolves to ~1M on an openai-compatible provider', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'gemini',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('gemini-3.5-flash')).toBe(1_048_576)
    expect(m.getRayuModelContextWindow('models/gemini-3.5-flash')).toBe(1_048_576)
    expect(m.getRayuModelContextWindow('gemini-2.5-pro')).toBe(1_048_576)
  })

  test('resolves for a vertex provider', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'gemini-vertex', kind: 'vertex', gcpProject: 'p', gcpRegion: 'global' })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('gemini-3.5-flash')).toBe(1_048_576)
  })

  test('resolves for a genai provider', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'gemini-login', kind: 'genai', gcpProject: 'p' })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('gemini-3-flash')).toBe(1_048_576)
  })

  test('gemini-3.1+ (Code Assist) reports 1M native context on a genai provider', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'gemini-login', kind: 'genai' })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('gemini-3.1-pro-preview')).toBe(1_048_576)
    expect(m.getRayuModelContextWindow('gemini-3-pro-preview')).toBe(1_048_576)
    expect(m.getRayuModelContextWindow('models/gemini-3.1-pro-preview')).toBe(1_048_576)
    expect(m.getRayuModelContextWindow('gemini-2.5-pro')).toBe(1_048_576)
  })

  test('getContextWindowForModel (/, /context display path) reports 1M for Gemini on genai', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'gemini-login', kind: 'genai' })
    m._resetRayuConfigCache()
    const { getContextWindowForModel } = await import('../src/utils/context.ts')
    expect(getContextWindowForModel('gemini-3.1-pro-preview')).toBe(1_048_576)
  })

  test('getContextWindowForModel reports 1M for Gemini on a vertex provider', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'gemini-vertex', kind: 'vertex', gcpProject: 'p', gcpRegion: 'global' })
    m._resetRayuConfigCache()
    const { getContextWindowForModel } = await import('../src/utils/context.ts')
    expect(getContextWindowForModel('gemini-3.5-flash')).toBe(1_048_576)
  })
})

describe('getRayuModelContextWindow — non-Anthropic providers use the model table', () => {
  test('deepseek-v4 on rayu-hosted reports the real 1M window, not the 200k default', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-flash',
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('deepseek-v4-flash')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('deepseek-v4-pro')).toBe(1_000_000)
  })

  test('per-model context override still wins on a non-allowlisted provider kind', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['deepseek-v4-flash'],
      modelContextWindows: { 'deepseek-v4-flash': 500_000 },
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('deepseek-v4-flash')).toBe(500_000)
  })
})

describe('getRayuModelContextWindow — Kimi K2 context windows', () => {
  function nvidia(m: Awaited<ReturnType<typeof fresh>>, defaultModel?: string) {
    m.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      ...(defaultModel ? { defaultModel } : {}),
    })
    m._resetRayuConfigCache()
  }

  test('newer Kimi K2 releases (K2.6 / K2.5 / Thinking / dated) report 256k', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('moonshotai/kimi-k2.6')).toBe(256_000)
    expect(m.getRayuModelContextWindow('moonshotai/Kimi-K2.6')).toBe(256_000)
    expect(m.getRayuModelContextWindow('moonshotai/kimi-k2.5')).toBe(256_000)
    expect(m.getRayuModelContextWindow('moonshot.kimi-k2-thinking')).toBe(256_000)
    expect(m.getRayuModelContextWindow('moonshotai/kimi-k2-0905')).toBe(256_000)
  })

  test('original Kimi K2 (0711) / generic Moonshot stays on the 128k fallback', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('moonshotai/kimi-k2-instruct')).toBe(131_072)
    expect(m.getRayuModelContextWindow('kimi-k2')).toBe(131_072)
  })

  test('/context display path resolves Kimi K2.6 to 256k (not the 128k default)', async () => {
    const m = await fresh()
    nvidia(m, 'moonshotai/kimi-k2.6')
    const { getContextWindowForModel } = await import('../src/utils/context.ts')
    expect(getContextWindowForModel('moonshotai/kimi-k2.6')).toBe(256_000)
  })
})

describe('getRayuModelContextWindow — steering-requested LLM windows', () => {
  function nvidia(m: Awaited<ReturnType<typeof fresh>>) {
    m.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
    })
    m._resetRayuConfigCache()
  }

  test('DeepSeek V4 flash & pro = 1M', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('deepseek-v4-flash')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('deepseek-v4-pro')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('deepseek-ai/deepseek-v4-flash')).toBe(1_000_000)
  })

  test('GLM-5.2 = 1M while GLM-5.1 stays 200K', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('glm-5.2')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('glm5.2')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('glm-5.1')).toBe(200_000)
  })

  test('MiniMax-M3 = 1M while MiniMax-M2 stays 204,800', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('MiniMax-M3')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('minimax-m3')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('MiniMax-M2')).toBe(204_800)
  })

  test('Kimi Code 2.7 = 256K while plain Kimi K2 stays 128K', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('kimi-code-2.7')).toBe(256_000)
    expect(m.getRayuModelContextWindow('kimicode-2.7')).toBe(256_000)
    expect(m.getRayuModelContextWindow('kimi-k2.7')).toBe(256_000)
    expect(m.getRayuModelContextWindow('kimi-k2')).toBe(131_072)
    expect(m.getRayuModelContextWindow('moonshotai/kimi-k2-instruct')).toBe(131_072)
  })

  test('Llama 4 = 1M while Llama 3.x stays 128K', async () => {
    const m = await fresh()
    nvidia(m)
    expect(m.getRayuModelContextWindow('llama-4-scout')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('meta-llama/Llama-4-Maverick-17B')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('meta/llama-3.3-70b-instruct')).toBe(131_072)
  })
})
