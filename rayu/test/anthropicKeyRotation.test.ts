import { describe, expect, test } from 'bun:test'
import { makeKeyRotatingFetch } from '../src/services/api/anthropicCompatibleClient.ts'

// Ollama Cloud is kind:'anthropic-compatible' (native Anthropic SDK path), so
// its multi-key rate-limit failover lives in the fetch layer, not the OpenAI
// adapter. makeKeyRotatingFetch rewrites Authorization: Bearer per attempt and
// rotates to the next key on a rotatable status (429/402/401/403).
const keyOf = (init: RequestInit | undefined): string =>
  (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '')

describe('makeKeyRotatingFetch (anthropic-compatible multi-key failover)', () => {
  test('429 on the first key rotates to the second and returns its 200', async () => {
    const used: string[] = []
    const base = (async (_url: unknown, init: RequestInit) => {
      const k = keyOf(init)
      used.push(k)
      return new Response('', { status: k === 'k1' ? 429 : 200 })
    }) as unknown as typeof fetch
    const f = makeKeyRotatingFetch(['k1', 'k2'], base)
    const resp = await f('https://ollama.com/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer k1' },
    })
    expect(resp.status).toBe(200)
    expect(used).toEqual(['k1', 'k2'])
  })

  test('all keys rate-limited -> returns the last 429 after trying every key', async () => {
    const used: string[] = []
    const base = (async (_url: unknown, init: RequestInit) => {
      used.push(keyOf(init))
      return new Response('', { status: 429 })
    }) as unknown as typeof fetch
    const f = makeKeyRotatingFetch(['k1', 'k2', 'k3'], base)
    const resp = await f('https://x', { headers: {} })
    expect(resp.status).toBe(429)
    expect(used).toEqual(['k1', 'k2', 'k3'])
  })

  test('402 / 401 / 403 also rotate to the next key', async () => {
    for (const status of [402, 401, 403]) {
      const used: string[] = []
      const base = (async (_url: unknown, init: RequestInit) => {
        const k = keyOf(init)
        used.push(k)
        return new Response('', { status: k === 'a' ? status : 200 })
      }) as unknown as typeof fetch
      const f = makeKeyRotatingFetch(['a', 'b'], base)
      const resp = await f('https://x', { headers: {} })
      expect(resp.status).toBe(200)
      expect(used).toEqual(['a', 'b'])
    }
  })

  test('a non-rotatable status (400) does NOT rotate — first key only', async () => {
    const used: string[] = []
    const base = (async (_url: unknown, init: RequestInit) => {
      used.push(keyOf(init))
      return new Response('', { status: 400 })
    }) as unknown as typeof fetch
    const f = makeKeyRotatingFetch(['k1', 'k2'], base)
    const resp = await f('https://x', { headers: {} })
    expect(resp.status).toBe(400)
    expect(used).toEqual(['k1'])
  })

  test('sticky: after rotating once, the next request starts from the working key', async () => {
    const used: string[] = []
    const base = (async (_url: unknown, init: RequestInit) => {
      const k = keyOf(init)
      used.push(k)
      return new Response('', { status: k === 'k1' ? 429 : 200 }) // k1 always limited
    }) as unknown as typeof fetch
    const f = makeKeyRotatingFetch(['k1', 'k2'], base)
    await f('https://x', { headers: {} })
    await f('https://x', { headers: {} })
    // req1: k1(429) -> k2(ok); req2 starts straight at k2.
    expect(used).toEqual(['k1', 'k2', 'k2'])
  })

  test('overwrites the Authorization header with the current key', async () => {
    let seen = ''
    const base = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const f = makeKeyRotatingFetch(['real-key'], base)
    await f('https://x', { headers: { Authorization: 'Bearer stale' } })
    expect(seen).toBe('Bearer real-key')
  })
})
