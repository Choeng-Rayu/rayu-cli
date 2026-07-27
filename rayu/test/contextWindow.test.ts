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
  test('per-model context override still wins on a non-allowlisted provider kind', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'byo-openai',
      kind: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: ['deepseek-v4-flash'],
      modelContextWindows: { 'deepseek-v4-flash': 500_000 },
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('deepseek-v4-flash')).toBe(500_000)
  })

  // BYO-key providers still use the built-in table: the CLI is the only thing
  // that knows those models. (Rayu-hosted deliberately does NOT — see below.)
  test('a BYO OpenAI-compatible provider still resolves from the known-model table', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'byo-openai',
      kind: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      models: ['glm-5.2', 'kimi-k2.7-code'],
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('glm-5.2')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('kimi-k2.7-code')).toBe(256_000)
  })
})


describe('rayu-hosted: the admin-managed catalog drives the context window', () => {
  // What the admin-managed catalog buys us: a model the CLI has never heard of
  // still gets a correct window, because syncRayuHostedProvider copies the
  // dashboard value into provider.modelContextWindows.
  test('an admin-added model unknown to the CLI table uses the synced window', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['brand-new-model-2027'],
      defaultModel: 'brand-new-model-2027',
      modelContextWindows: { 'brand-new-model-2027': 400_000 },
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('brand-new-model-2027')).toBe(400_000)
  })

  // When the admin's value disagrees with the CLI's built-in guess, the ADMIN
  // wins for hosted models — that is what makes the dashboard authoritative.
  test('the admin window overrides the CLI table for a hosted model', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['glm-5.2'],
      defaultModel: 'glm-5.2',
      // The table says 1M for glm-5.2; this deployment's admin says 200K.
      modelContextWindows: { 'glm-5.2': 200_000 },
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('glm-5.2')).toBe(200_000)
  })

  // A model the admin left unset must NOT inherit some other model's window from
  // a hardcoded table: hosted context is server-driven, so an unset window means
  // "unknown" and the caller applies its documented client default.
  test('a hosted model with no synced window is unknown (no hardcoded guess)', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      // These codes DO match the built-in table, which a BYO provider would use —
      // hosted must ignore it entirely.
      models: ['glm-5.2', 'kimi-k2.7', 'deepseek-v4-pro'],
      defaultModel: 'glm-5.2',
      modelContextWindows: { 'glm-5.2': 200_000 }, // only glm has an admin value
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('glm-5.2')).toBe(200_000)
    expect(m.getRayuModelContextWindow('kimi-k2.7')).toBeNull()
    expect(m.getRayuModelContextWindow('deepseek-v4-pro')).toBeNull()
  })

  // A provider-level window is explicit local config, not a per-model guess, so
  // it is still honoured when the admin hasn't set a per-model value.
  test('falls back to an explicit provider-level window when set', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['some-new-model'],
      defaultModel: 'some-new-model',
      contextWindow: 300_000,
    })
    m._resetRayuConfigCache()
    expect(m.getRayuModelContextWindow('some-new-model')).toBe(300_000)
  })

  // The env escape hatch must still win everywhere (operator override).
  test('RAYU_CONTEXT_TOKENS overrides even the admin value', async () => {
    const m = await fresh()
    m.upsertProvider({
      id: 'rayu-hosted',
      kind: 'rayu-hosted',
      baseURL: 'https://hosted.example',
      models: ['glm-5.2'],
      defaultModel: 'glm-5.2',
      modelContextWindows: { 'glm-5.2': 200_000 },
    })
    m._resetRayuConfigCache()
    process.env.RAYU_CONTEXT_TOKENS = '64000'
    try {
      expect(m.getRayuModelContextWindow('glm-5.2')).toBe(64_000)
    } finally {
      delete process.env.RAYU_CONTEXT_TOKENS
    }
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
