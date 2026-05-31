import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'

let dir: string, server: any, port: number
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-models-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'meta/llama-3.3-70b-instruct' },
        { id: 'nvidia/llama-3.1-nemotron-70b-instruct' },
        { id: 'mistralai/mixtral-8x22b-instruct-v0.1' },
      ]}))
    } else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>(r => server.listen(0, () => r()))
  port = server.address().port
})
afterEach(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.RAYU_CONFIG_DIR })

describe('live model fetch', () => {
  test('fetchProviderModels returns sorted ids from /v1/models', async () => {
    const m = await import('/home/rayu/rayu-cli/claude-code/src/utils/rayuConfig.ts')
    m._resetRayuConfigCache()
    const ids = await m.fetchProviderModels({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: `http://localhost:${port}/v1` })
    expect(ids).toContain('meta/llama-3.3-70b-instruct')
    expect(ids).toContain('nvidia/llama-3.1-nemotron-70b-instruct')
    expect(ids.length).toBe(3)
  })
  test('refreshActiveProviderModels caches into config + picker lists all', async () => {
    const m = await import('/home/rayu/rayu-cli/claude-code/src/utils/rayuConfig.ts')
    m._resetRayuConfigCache()
    m.upsertProvider({ id: 'nvidia', kind: 'openai-compatible', apiKey: 'k', baseURL: `http://localhost:${port}/v1`, defaultModel: 'meta/llama-3.3-70b-instruct' })
    const fetched = await m.refreshActiveProviderModels()
    expect(fetched.length).toBe(3)
    const opts = m.getActiveProviderModelOptions()
    expect(opts.map(o => o.value).sort()).toContain('mistralai/mixtral-8x22b-instruct-v0.1')
    expect(opts.length).toBe(3)
  })
})
