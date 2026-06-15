import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { DOUBLEWORD_MODELS } from '../src/utils/curatedProviderModels.ts'

let dir: string, server: any, port: number, modelsBody: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-dw-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  // Real Doubleword returns an EMPTY catalog from /v1/models.
  modelsBody = JSON.stringify({ object: 'list', data: [] })
  server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(modelsBody)
    } else {
      res.writeHead(404)
      res.end('{}')
    }
  })
  await new Promise<void>(r => server.listen(0, () => r()))
  port = server.address().port
})
afterEach(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

describe('Doubleword curated catalog', () => {
  test('contains the preset default + smallFast and only canonical org/Model ids', () => {
    expect(DOUBLEWORD_MODELS).toContain('moonshotai/Kimi-K2.6')
    expect(DOUBLEWORD_MODELS).toContain('Qwen/Qwen3.5-9B')
    expect(DOUBLEWORD_MODELS.length).toBe(17)
    for (const id of DOUBLEWORD_MODELS) expect(id).toMatch(/^[\w.-]+\/[\w.-]+$/)
  })

  test('excludes async/batch-only, OCR and embedding models', () => {
    const excluded = [
      'Qwen/Qwen3.5-4B',
      'Qwen/Qwen3.5-9B-dottxt',
      'Qwen/Qwen3.5-35B-A3B-FP8-dottxt',
      'Qwen/Qwen3.5-397B-A17B-FP8-dottxt',
      'Qwen/Qwen3-Embedding-8B',
    ]
    for (const id of excluded) expect(DOUBLEWORD_MODELS).not.toContain(id)
    expect(DOUBLEWORD_MODELS.some(id => /ocr/i.test(id))).toBe(false)
    expect(DOUBLEWORD_MODELS.some(id => /embedding/i.test(id))).toBe(false)
    expect(DOUBLEWORD_MODELS.some(id => /dottxt/i.test(id))).toBe(false)
  })

  test('fetchProviderModels returns the full curated catalog when /models is empty', async () => {
    const m = await import('../src/utils/rayuConfig')
    m._resetRayuConfigCache()
    const ids = await m.fetchProviderModels({
      id: 'doubleword',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: `http://localhost:${port}/v1`,
    })
    expect(ids.length).toBe(DOUBLEWORD_MODELS.length)
    expect(ids).toContain('moonshotai/Kimi-K2.6')
    expect(ids).toContain('Qwen/Qwen3-VL-30B-A3B-Instruct-FP8')
    expect(ids).toEqual([...ids].sort()) // returned sorted
  })

  test('merges live /models ids with the curated catalog (union, deduped)', async () => {
    modelsBody = JSON.stringify({
      object: 'list',
      data: [{ id: 'moonshotai/Kimi-K2.6' }, { id: 'some/new-model' }],
    })
    const m = await import('../src/utils/rayuConfig')
    m._resetRayuConfigCache()
    const ids = await m.fetchProviderModels({
      id: 'doubleword',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: `http://localhost:${port}/v1`,
    })
    expect(ids).toContain('some/new-model') // live-only id preserved
    expect(ids.filter(x => x === 'moonshotai/Kimi-K2.6').length).toBe(1) // deduped
    expect(ids.length).toBe(DOUBLEWORD_MODELS.length + 1)
  })

  test('a non-curated provider is unaffected (empty /models → no models)', async () => {
    const m = await import('../src/utils/rayuConfig')
    m._resetRayuConfigCache()
    const ids = await m.fetchProviderModels({
      id: 'nvidia',
      kind: 'openai-compatible',
      apiKey: 'k',
      baseURL: `http://localhost:${port}/v1`,
    })
    expect(ids.length).toBe(0)
  })
})
