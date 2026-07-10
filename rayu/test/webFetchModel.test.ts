import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-webfetch-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  delete process.env.RAYU_OPENAI_COMPATIBLE
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})

async function setActiveNvidiaProvider(extra: Partial<RayuProvider> = {}) {
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.upsertProvider(
    {
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'nv-key',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.3-70b-instruct',
      smallFastModel: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
      ...extra,
    },
    true,
  )
}

test('webFetchModel selection set/get/clear round-trips', async () => {
  const cfg = await import('../src/utils/rayuConfig.ts')
  expect(cfg.getWebFetchModelSelection()).toBeUndefined()
  cfg.setWebFetchModelSelection('meta/llama-3.3-70b-instruct')
  expect(cfg.getWebFetchModelSelection()).toBe('meta/llama-3.3-70b-instruct')
  cfg.setWebFetchModelSelection(undefined)
  expect(cfg.getWebFetchModelSelection()).toBeUndefined()
})

test('getSmallFastModel uses the active provider small-fast model (not Anthropic Haiku)', async () => {
  await setActiveNvidiaProvider()
  const { getSmallFastModel } = await import('../src/utils/model/model.ts')
  expect(getSmallFastModel()).toBe('nvidia/llama-3.1-nemotron-nano-8b-v1')
})

test('getSmallFastModel falls back to the provider default (never claude-haiku) when no smallFastModel', async () => {
  // Root-cause regression: previously fell through to getDefaultHaikuModel().
  await setActiveNvidiaProvider({ smallFastModel: undefined })
  const { getSmallFastModel } = await import('../src/utils/model/model.ts')
  const m = getSmallFastModel()
  expect(m).not.toContain('claude-haiku')
  expect(m).toBe('meta/llama-3.3-70b-instruct')
})

test('getWebFetchModel defaults to getSmallFastModel and honors an explicit selection', async () => {
  await setActiveNvidiaProvider()
  const { getWebFetchModel, getSmallFastModel } = await import(
    '../src/utils/model/model.ts'
  )
  // Default: no /webfetch_model set → the active provider's small-fast model.
  expect(getWebFetchModel()).toBe(getSmallFastModel())
  expect(getWebFetchModel()).not.toContain('claude-haiku')

  // Explicit selection wins.
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg.setWebFetchModelSelection('meta/llama-3.3-70b-instruct')
  expect(getWebFetchModel()).toBe('meta/llama-3.3-70b-instruct')
})
