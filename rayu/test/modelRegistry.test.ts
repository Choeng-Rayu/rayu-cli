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
  delete process.env.ANTHROPIC_MODEL
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

  test('openai-compatible provider ignores Anthropic model settings and uses provider default', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'stepfun-ai/step-3.7-flash',
    })
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
    const { getMainLoopModel } = await import('../src/utils/model/model.ts')
    expect(getMainLoopModel()).toBe('stepfun-ai/step-3.7-flash')
  })

  // Regression: selecting deepseek-v4-pro-1m via --model (or the /model
  // keybinding fallback) failed with "model is not available on your
  // provider" because getModelOptions()'s gate for surfacing a provider's own
  // models only checked isOpenAICompatibleActive() || bedrock — excluding
  // kind:'deepseek-web' (and every other non-openai-compatible/non-bedrock
  // Rayu kind) — even though getActiveProviderModelOptions() already listed
  // it correctly. Fixed by widening the gate with isRayuNonAnthropicActive().
  test('getModelOptions surfaces deepseek-web models (regression: was excluded, causing "model not available")', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'deepseek-web',
      kind: 'deepseek-web',
      apiKey: 'user-token',
      defaultModel: 'deepseek-v4-pro-1m',
      smallFastModel: 'deepseek-v4-pro-1m',
      models: ['deepseek-v4-pro-1m'],
      fetchedModels: ['deepseek-v4-pro-1m'],
    })
    cfg.setActiveProvider('deepseek-web')

    const { isRayuNonAnthropicActive } = await import('../src/utils/model/providers.ts')
    expect(isRayuNonAnthropicActive()).toBe(true)

    const { getModelOptions } = await import('../src/utils/model/modelOptions.ts')
    const opts = getModelOptions()
    expect(opts.map(o => o.value)).toContain('deepseek-v4-pro-1m')
    // The provider's own model is surfaced FIRST (mirrors the openai-compatible
    // behavior already covered above), before the stock Anthropic aliases.
    expect(opts[0]!.value).toBe('deepseek-v4-pro-1m')
  })

  test('getActiveProviderModelOptions (the underlying data source) also lists deepseek-web models directly', async () => {
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'deepseek-web',
      kind: 'deepseek-web',
      apiKey: 'user-token',
      defaultModel: 'deepseek-v4-pro-1m',
      models: ['deepseek-v4-pro-1m'],
      fetchedModels: ['deepseek-v4-pro-1m'],
    })
    const opts = cfg.getActiveProviderModelOptions()
    expect(opts.map(o => o.value)).toContain('deepseek-v4-pro-1m')
  })
})
