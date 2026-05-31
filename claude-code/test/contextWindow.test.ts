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
