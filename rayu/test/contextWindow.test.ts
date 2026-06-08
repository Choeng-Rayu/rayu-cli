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
