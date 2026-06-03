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
