import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-model-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_COMPATIBLE
})

async function fresh() {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  return cfg
}

describe('provider/model registry', () => {
  test('getActiveProviderModelOptions lists default + extra models for openai-compatible', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      models: ['nvidia/llama-3.1-nemotron-70b-instruct'],
    })
    const opts = cfg.getActiveProviderModelOptions()
    expect(opts[0].value).toBe('meta/llama-3.3-70b-instruct')
    expect(opts.map(o => o.value)).toContain('nvidia/llama-3.1-nemotron-70b-instruct')
  })

  test('isOpenAICompatibleActive reflects active provider kind', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({ id: 'openai', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://api.openai.com/v1' })
    const { isOpenAICompatibleActive } = await import('../src/utils/model/providers.ts')
    expect(isOpenAICompatibleActive()).toBe(true)

    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'a' })
    cfg.setActiveProvider('anthropic')
    expect(isOpenAICompatibleActive()).toBe(false)
  })

  test('anthropic provider yields no openai-compatible model options', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({ id: 'anthropic', kind: 'anthropic', apiKey: 'a' })
    expect(cfg.getActiveProviderModelOptions()).toEqual([])
  })
})
