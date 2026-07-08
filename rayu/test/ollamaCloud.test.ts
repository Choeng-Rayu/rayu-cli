import { afterEach, describe, expect, test } from 'bun:test'
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_PROVIDER_ID,
  fetchOllamaCloudModelContexts,
  fetchOllamaCloudModels,
} from '../src/services/api/ollamaCloud.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type StubResp = { status?: number; body?: unknown }
function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubResp): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    const { status = 200, body = {} } = handler(url, init) ?? {}
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }) as typeof fetch
}

describe('ollama cloud constants', () => {
  test('stable id + cloud base url', () => {
    expect(OLLAMA_CLOUD_PROVIDER_ID).toBe('ollama-cloud')
    expect(OLLAMA_CLOUD_BASE_URL).toBe('https://ollama.com')
  })
})

describe('fetchOllamaCloudModels', () => {
  test('lists the account models from /v1/models and sends the Bearer key', async () => {
    let authHeader: string | undefined
    let hitUrl: string | undefined
    stubFetch((url, init) => {
      if (url.endsWith('/v1/models')) {
        hitUrl = url
        authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization
        return { body: { data: [{ id: 'qwen3-coder:cloud' }, { id: 'gpt-oss:120b-cloud' }] } }
      }
      return { status: 404 }
    })
    const models = await fetchOllamaCloudModels('key-123', OLLAMA_CLOUD_BASE_URL)
    expect(hitUrl).toBe('https://ollama.com/v1/models')
    expect(authHeader).toBe('Bearer key-123')
    expect(models).toEqual(['gpt-oss:120b-cloud', 'qwen3-coder:cloud']) // deduped + sorted
  })

  test('falls back to native /api/tags when /v1/models is empty', async () => {
    stubFetch(url => {
      if (url.endsWith('/v1/models')) return { body: { data: [] } }
      if (url.endsWith('/api/tags'))
        return { body: { models: [{ model: 'glm-4.7:cloud' }, { name: 'minimax-m2.1:cloud' }] } }
      return { status: 404 }
    })
    const models = await fetchOllamaCloudModels('key')
    expect(models).toEqual(['glm-4.7:cloud', 'minimax-m2.1:cloud'])
  })

  test('returns [] when both endpoints fail (caller keeps the preset default)', async () => {
    stubFetch(() => ({ status: 500 }))
    expect(await fetchOllamaCloudModels('key')).toEqual([])
  })
})

describe('fetchOllamaCloudModelContexts', () => {
  test('parses the arch-prefixed context_length from /api/show per model', async () => {
    stubFetch((url, init) => {
      if (!url.endsWith('/api/show')) return { status: 404 }
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      const isQwen = model.startsWith('qwen')
      const arch = isQwen ? 'qwen3' : 'gptoss'
      return {
        body: {
          model_info: {
            'general.architecture': arch,
            [`${arch}.context_length`]: isQwen ? 262144 : 131072,
          },
        },
      }
    })
    const ctx = await fetchOllamaCloudModelContexts('key', OLLAMA_CLOUD_BASE_URL, [
      'qwen3-coder:cloud',
      'gpt-oss:120b-cloud',
    ])
    expect(ctx['qwen3-coder:cloud']).toBe(262144)
    expect(ctx['gpt-oss:120b-cloud']).toBe(131072)
  })

  test('omits models whose /api/show fails — the known-model table is the fallback', async () => {
    stubFetch(url => (url.endsWith('/api/show') ? { status: 500 } : { status: 404 }))
    const ctx = await fetchOllamaCloudModelContexts('key', undefined, ['x:cloud'])
    expect(ctx).toEqual({})
  })
})
