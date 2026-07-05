import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-model-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  // isUseDeepseekOAuthEnabled() requires USE_RAYU_OAUTH=true too (AND, not
  // independent) — delete rather than rely on the ambient shell/.env value,
  // so these tests are deterministic regardless of what's set outside the
  // test process (mirrors the convention in rayuAuth.test.ts /
  // rayuEntitlements.test.ts / rayuGatewayRouting.test.ts / etc.).
  delete process.env.USE_RAYU_OAUTH
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_OPENAI_COMPATIBLE
  delete process.env.ANTHROPIC_MODEL
  delete process.env.USE_DEEPSEEK_OAUTH
  delete process.env.USE_RAYU_OAUTH
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
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.USE_DEEPSEEK_OAUTH = 'true'
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
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.USE_DEEPSEEK_OAUTH = 'true'
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

  // Regression: USE_DEEPSEEK_OAUTH=false did NOT hide an already-persisted
  // deepseek-web provider entry, because the flag was previously consulted
  // ONLY inside the background entitlements sync (syncDeepseekWebProvider),
  // which runs at most every 30s and only when USE_RAYU_OAUTH is on AND the
  // user is signed in. A provider registered while the flag was true stayed
  // fully usable/listed after flipping it to false in .env, since nothing
  // else in the dispatch or listing path ever re-checked the flag. Fixed by
  // making the flag an ACTIVE, per-call gate in both
  // getActiveProviderModelOptions (listing) and client.ts's
  // getRayuDeepseekWebClient (dispatch), instead of a one-shot registration
  // guard.
  test('getActiveProviderModelOptions hides an already-persisted deepseek-web provider when USE_DEEPSEEK_OAUTH=false (regression: flag was only checked at registration time, never again)', async () => {
    // USE_RAYU_OAUTH=true so this test isolates the USE_DEEPSEEK_OAUTH check
    // specifically, rather than passing incidentally because
    // isUseDeepseekOAuthEnabled() also short-circuits false when
    // USE_RAYU_OAUTH is off.
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.USE_DEEPSEEK_OAUTH = 'false'
    const cfg = await fresh()
    // Simulate a provider that was persisted to disk while the flag was
    // previously true (e.g. an earlier session, or the user just flipped
    // .env) — the entry exists on disk regardless of the CURRENT flag value.
    cfg.upsertProvider({
      id: 'deepseek-web',
      kind: 'deepseek-web',
      apiKey: 'user-token',
      defaultModel: 'deepseek-v4-pro-1m',
      models: ['deepseek-v4-pro-1m'],
      fetchedModels: ['deepseek-v4-pro-1m'],
    })
    cfg.setActiveProvider('deepseek-web')

    const opts = cfg.getActiveProviderModelOptions()
    expect(opts).toEqual([])
    expect(opts.map(o => o.value)).not.toContain('deepseek-v4-pro-1m')
  })

  test('getModelOptions falls back to the stock Anthropic aliases when the active deepseek-web provider is hidden by the flag', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.USE_DEEPSEEK_OAUTH = 'false'
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'deepseek-web',
      kind: 'deepseek-web',
      apiKey: 'user-token',
      defaultModel: 'deepseek-v4-pro-1m',
      models: ['deepseek-v4-pro-1m'],
      fetchedModels: ['deepseek-v4-pro-1m'],
    })
    cfg.setActiveProvider('deepseek-web')

    const { getModelOptions } = await import('../src/utils/model/modelOptions.ts')
    const opts = getModelOptions()
    expect(opts.map(o => o.value)).not.toContain('deepseek-v4-pro-1m')
  })

  test('a non-deepseek-web provider (e.g. openai-compatible) is completely unaffected by USE_DEEPSEEK_OAUTH', async () => {
    process.env.USE_DEEPSEEK_OAUTH = 'false'
    const cfg = await fresh()
    cfg.upsertProvider({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
    })
    const opts = cfg.getActiveProviderModelOptions()
    expect(opts.map(o => o.value)).toContain('meta/llama-3.3-70b-instruct')
  })
})
