import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-search-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
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

function filter(all: { providerId: string; model: string }[], query: string) {
  const q = query.toLowerCase().trim()
  if (!q) return all
  const terms = q.split(/\s+/)
  return all.filter(o =>
    terms.every(t => `${o.providerId} ${o.model}`.toLowerCase().includes(t)),
  )
}

describe('searchable cross-provider model selection', () => {
  test('aggregates models across all configured providers, active first', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1', fetchedModels: ['meta/llama-3.3-70b-instruct', 'google/codegemma-7b'] })
    m.upsertProvider({ id: 'deepseek', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://y/v1', fetchedModels: ['deepseek-chat', 'deepseek-reasoner'] })
    m.setActiveProvider('deepseek')
    const all = m.getAllProviderModelOptions()
    expect(all.length).toBe(4)
    expect(all[0].providerId).toBe('deepseek')
    expect(all.map(o => o.model)).toContain('meta/llama-3.3-70b-instruct')
  })

  test('search filters by model id and by provider, multi-term AND', async () => {
    const m = await fresh()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://x/v1', fetchedModels: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v4-flash'] })
    m.upsertProvider({ id: 'deepseek', kind: 'openai-compatible', apiKey: 'k', baseURL: 'https://y/v1', fetchedModels: ['deepseek-chat'] })
    const all = m.getAllProviderModelOptions()
    expect(filter(all, 'llama').length).toBe(1)
    expect(filter(all, 'deepseek').length).toBe(2) // nvidia's deepseek-v4-flash + deepseek/deepseek-chat
    expect(filter(all, 'nvidia deepseek').map(o => o.model)).toEqual(['deepseek-ai/deepseek-v4-flash'])
    expect(filter(all, 'nomatch-xyz').length).toBe(0)
  })

  test('decodeModelChoice round-trips provider+model', async () => {
    await fresh()
    const { decodeModelChoice } = await import('../src/components/SearchableModelPicker.tsx')
    const { RAYU_MODEL_SEP } = await import('../src/utils/rayuConfig.ts')
    expect(decodeModelChoice(`nvidia${RAYU_MODEL_SEP}meta/llama-3.3-70b-instruct`)).toEqual({ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' })
  })
})
