import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
const ENV_KEYS = ['NVIDIA_API_KEY', 'DOUBLE_WORD_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_FOR_CODE_API_KEY']
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-prov-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  for (const k of ENV_KEYS) delete process.env[k]
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  return cfg
}

describe('provider presets', () => {
  test('registry includes the 4 user providers as OpenAI-compatible with /v1 base URLs', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const byId = Object.fromEntries(PROVIDER_PRESETS.map(p => [p.id, p]))
    for (const id of ['nvidia', 'doubleword', 'deepseek', 'kimi-moonshot', 'kimi-for-code']) {
      expect(byId[id]?.kind).toBe('openai-compatible')
      expect(byId[id]?.baseURL?.endsWith('/v1')).toBe(true)
      expect(byId[id]?.smallFastModel).toBeTruthy()
    }
    expect(byId['doubleword'].baseURL).toBe('https://api.doubleword.ai/v1')
  })

  test('registry includes the first-party Anthropic Console (native) provider', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const anthropic = PROVIDER_PRESETS.find(p => p.id === 'anthropic')
    // kind:'anthropic' routes through getAnthropicClient() (the native
    // Anthropic Messages API) → native extended thinking + full context window.
    expect(anthropic?.kind).toBe('anthropic')
    // First-party endpoint: no baseURL (the Anthropic SDK default api.anthropic.com).
    expect(anthropic?.baseURL).toBeUndefined()
    expect(anthropic?.envKeys).toContain('ANTHROPIC_API_KEY')
    expect(anthropic?.defaultModel).toBe('claude-sonnet-4-6')
    expect(anthropic?.smallFastModel).toBe('claude-haiku-4-5-20251001')
    // Surfaced first in /connect (the flagship native provider).
    expect(PROVIDER_PRESETS[0]?.id).toBe('anthropic')
  })

  test('an active anthropic provider routes to the native (non-OpenAI) API path', async () => {
    const cfg = await fresh()
    const providers = await import('../src/utils/model/providers.ts')
    cfg.upsertProvider(
      {
        id: 'anthropic',
        kind: 'anthropic',
        apiKey: 'sk-ant-test',
        defaultModel: 'claude-sonnet-4-6',
      },
      true,
    )
    expect(cfg.getActiveProvider()?.kind).toBe('anthropic')
    expect(providers.getAPIProvider()).toBe('anthropic')
    expect(providers.isOpenAICompatibleActive()).toBe(false)
    expect(providers.isRayuNonAnthropicActive()).toBe(false)
  })

  test('registry includes GLM (Z.ai) and MiniMax as openai-compatible providers', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const glm = PROVIDER_PRESETS.find(p => p.id === 'glm')
    expect(glm?.kind).toBe('openai-compatible')
    expect(glm?.baseURL).toBe('https://api.z.ai/api/paas/v4')
    expect(glm?.defaultModel).toBe('glm-5.2')
    expect(glm?.smallFastModel).toBe('glm-4.5-air')
    expect(glm?.envKeys).toEqual(expect.arrayContaining(['ZAI_API_KEY', 'GLM_API_KEY']))

    const mm = PROVIDER_PRESETS.find(p => p.id === 'minimax')
    expect(mm?.kind).toBe('openai-compatible')
    expect(mm?.baseURL).toBe('https://api.minimax.io/v1')
    expect(mm?.defaultModel).toBe('MiniMax-M2')
    expect(mm?.envKeys).toContain('MINIMAX_API_KEY')

    // Curated catalogs keep the full lineup selectable in /model even when the
    // provider's /models endpoint isn't usable (merged with the live fetch).
    const { CURATED_PROVIDER_MODELS } = await import('../src/utils/curatedProviderModels.ts')
    expect(CURATED_PROVIDER_MODELS.glm).toEqual(expect.arrayContaining(['glm-4.6', 'glm-4.5-air']))
    expect(CURATED_PROVIDER_MODELS.minimax).toEqual(
      expect.arrayContaining(['MiniMax-M3', 'MiniMax-M2']),
    )
  })

  test('GLM and MiniMax resolve native per-model context windows', async () => {
    const cfg = await fresh()
    // GLM-5.2 = 1M (flagship); GLM-4.6/4.7/5.x = 200K; GLM-4.5 family = 128K.
    cfg.upsertProvider(
      { id: 'glm', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://api.z.ai/api/paas/v4' },
      true,
    )
    expect(cfg.getRayuModelContextWindow('glm-5.2')).toBe(1_000_000)
    expect(cfg.getRayuModelContextWindow('glm-4.6')).toBe(200_000)
    expect(cfg.getRayuModelContextWindow('glm-5.1')).toBe(200_000)
    expect(cfg.getRayuModelContextWindow('glm-4.5')).toBe(131_072)
    expect(cfg.getRayuModelContextWindow('glm-4.5-air')).toBe(131_072)
    // MiniMax-M3 = 1M; M2 / M2.x = 204,800 (the generic /minimax/ → 1M bug is fixed).
    cfg.upsertProvider(
      { id: 'minimax', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://api.minimax.io/v1' },
      true,
    )
    expect(cfg.getRayuModelContextWindow('MiniMax-M3')).toBe(1_000_000)
    expect(cfg.getRayuModelContextWindow('MiniMax-M2')).toBe(204_800)
    expect(cfg.getRayuModelContextWindow('MiniMax-M2.5-highspeed')).toBe(204_800)
  })

  test('registry includes Hugging Face Inference Providers (openai-compatible router)', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const hf = PROVIDER_PRESETS.find(p => p.id === 'huggingface')
    expect(hf?.kind).toBe('openai-compatible')
    expect(hf?.baseURL).toBe('https://router.huggingface.co/v1')
    expect(hf?.envKeys).toContain('HF_TOKEN')
    expect(hf?.defaultModel).toBeTruthy()
    expect(hf?.smallFastModel).toBeTruthy()
  })

  test('registry includes Fugu (Sakana AI) as an openai-compatible provider', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const fugu = PROVIDER_PRESETS.find(p => p.id === 'fugu')
    expect(fugu?.kind).toBe('openai-compatible')
    expect(fugu?.baseURL).toBe('https://api.sakana.ai/v1')
    expect(fugu?.baseURL?.endsWith('/v1')).toBe(true)
    expect(fugu?.defaultModel).toBe('fugu')
    expect(fugu?.smallFastModel).toBe('fugu')
    expect(fugu?.envKeys).toContain('SAKANA_API_KEY')
  })

  test('Fugu ships a curated catalog (fugu + fugu-ultra) and a 1M context window', async () => {
    const { CURATED_PROVIDER_MODELS } = await import('../src/utils/curatedProviderModels.ts')
    expect(CURATED_PROVIDER_MODELS.fugu).toEqual(['fugu', 'fugu-ultra'])

    // Fugu's 1M window must resolve via the known-model table for an active
    // openai-compatible Fugu provider (not the generic 200k fallback).
    const cfg = await fresh()
    cfg.upsertProvider(
      {
        id: 'fugu',
        kind: 'openai-compatible',
        apiKey: 'sk-test',
        baseURL: 'https://api.sakana.ai/v1',
        defaultModel: 'fugu',
      },
      true,
    )
    cfg._resetRayuConfigCache()
    expect(cfg.getRayuModelContextWindow('fugu')).toBe(1_000_000)
    expect(cfg.getRayuModelContextWindow('fugu-ultra')).toBe(1_000_000)
  })
})

describe('env key migration', () => {
  test('imports keys from env into config providers', async () => {
    process.env.NVIDIA_API_KEY = 'nv-1'
    process.env.DEEPSEEK_API_KEY = 'ds-1'
    await fresh()
    const { migrateEnvKeysToConfig } = await import('../src/utils/rayuProviders.ts')
    migrateEnvKeysToConfig()
    const cfg = await fresh()
    const c = cfg.loadRayuConfig()
    expect(c.providers.find(p => p.id === 'nvidia')?.apiKey).toBe('nv-1')
    expect(c.providers.find(p => p.id === 'deepseek')?.apiKey).toBe('ds-1')
    expect(c.activeProvider).toBeDefined()
  })

  test('imported provider gets its preset base URL', async () => {
    process.env.DOUBLE_WORD_API_KEY = 'dw-1'
    await fresh()
    const { migrateEnvKeysToConfig } = await import('../src/utils/rayuProviders.ts')
    migrateEnvKeysToConfig()
    const cfg = await fresh()
    const dw = cfg.loadRayuConfig().providers.find(p => p.id === 'doubleword')
    expect(dw?.apiKey).toBe('dw-1')
    expect(dw?.baseURL).toBe('https://api.doubleword.ai/v1')
    expect(dw?.smallFastModel).toBe('Qwen/Qwen3.5-9B')
  })

  test('migration fills missing preset smallFastModel without overwriting user values', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'user-key',
      baseURL: 'https://custom.example/v1',
      defaultModel: 'user/main-model',
    })
    const { migrateEnvKeysToConfig } = await import('../src/utils/rayuProviders.ts')
    migrateEnvKeysToConfig()
    cfg._resetRayuConfigCache()
    const nvidia = cfg.loadRayuConfig().providers.find(p => p.id === 'nvidia')
    expect(nvidia?.apiKey).toBe('user-key')
    expect(nvidia?.baseURL).toBe('https://custom.example/v1')
    expect(nvidia?.defaultModel).toBe('user/main-model')
    expect(nvidia?.smallFastModel).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
  })
})
