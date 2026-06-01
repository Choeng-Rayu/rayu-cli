import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ctx-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  delete process.env.RAYU_CONTEXT_TOKENS
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_CONTEXT_TOKENS
})
async function fresh() {
  const m = await import('../src/utils/rayuConfig.ts')
  m._resetRayuConfigCache()
  return m
}

describe('openai-compatible context window', () => {
  test('known models resolve their real context (DeepSeek V4 Flash = 1M, llama = 128k)', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1' })
    expect(m.getRayuModelContextWindow('deepseek-ai/deepseek-v4-flash')).toBe(1_000_000)
    expect(m.getRayuModelContextWindow('meta/llama-3.3-70b-instruct')).toBe(131_072)
  })

  test('per-model config override wins', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1', modelContextWindows: { 'custom/model': 500_000 } })
    expect(m.getRayuModelContextWindow('custom/model')).toBe(500_000)
  })

  test('RAYU_CONTEXT_TOKENS env overrides everything', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1' })
    process.env.RAYU_CONTEXT_TOKENS = '750000'
    expect(m.getRayuModelContextWindow('meta/llama-3.3-70b-instruct')).toBe(750_000)
  })

  test('unknown model returns null (caller defaults), provider default used if set', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'local', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1' })
    expect(m.getRayuModelContextWindow('totally-unknown-xyz')).toBeNull()
    m._resetRayuConfigCache()
    m.upsertProvider({ id: 'local', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1', contextWindow: 320_000 })
    expect(m.getRayuModelContextWindow('totally-unknown-xyz')).toBe(320_000)
  })

  test('getContextWindowForModel reflects the openai-compatible model', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1' })
    const { getContextWindowForModel } = await import('../src/utils/context.ts')
    expect(getContextWindowForModel('deepseek-ai/deepseek-v4-flash')).toBe(1_000_000)
  })
})

describe('curated context windows + default-model guard', () => {
  test('newly added model families resolve a known context (no null/unknown)', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1' })
    const cases: Array<[string, number]> = [
      ['gpt-5', 128_000],
      ['gpt-5-mini', 128_000],
      ['o4-mini', 128_000],
      ['meta/llama-3.2-11b-vision-instruct', 131_072],
      ['openai/gpt-oss-120b', 131_072],
      ['z-ai/glm-5.1', 131_072],
      ['minimaxai/minimax-m2.7', 1_000_000],
      ['qwen/qwen3.5-397b-a17b', 131_072],
      ['qwen/qwen3-coder-480b-a35b-instruct', 256_000],
      ['stepfun-ai/step-3.7-flash', 256_000],
    ]
    for (const [model, ctx] of cases) {
      expect(m.getRayuModelContextWindow(model)).toBe(ctx)
    }
    // gpt-4o must NOT be misread by the o-series rule
    expect(m.getRayuModelContextWindow('gpt-4o')).toBe(128_000)
  })

  test('getValidDefaultModel falls back when default is not in the catalog', async () => {
    const m = await fresh()
    // Doubleword-style mismatch: saved default not present in fetchedModels
    expect(
      m.getValidDefaultModel({
        id: 'doubleword', kind: 'openai-compatible', baseURL: 'https://x/v1',
        defaultModel: 'moonshotai/kimi-k2-6',
        fetchedModels: ['Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3.5-9B', 'moonshotai/Kimi-K2.6'],
      }),
    ).toBe('Qwen/Qwen3.5-9B') // first chat-capable (skips the embedding model)
  })

  test('getValidDefaultModel keeps a valid default and tolerates empty catalog', async () => {
    const m = await fresh()
    expect(
      m.getValidDefaultModel({ id: 'p', kind: 'openai-compatible', defaultModel: 'a', fetchedModels: ['a', 'b'] }),
    ).toBe('a')
    expect(
      m.getValidDefaultModel({ id: 'p', kind: 'openai-compatible', defaultModel: 'meta/llama-3.3-70b-instruct' }),
    ).toBe('meta/llama-3.3-70b-instruct')
  })
})
