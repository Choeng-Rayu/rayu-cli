import { afterEach, describe, expect, test } from 'bun:test'
import {
  COPILOT_BASE_URL,
  COPILOT_EDITOR_HEADERS,
  exchangeForCopilotToken,
  fetchCopilotModels,
  getCopilotToken,
  invalidateCopilotToken,
  makeCopilotFetch,
} from '../src/services/api/copilot/copilotAuth.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('copilot token exchange + cache', () => {
  test('reuses a still-valid cached token (single exchange)', async () => {
    const gh = `gh-valid-${Math.random()}`
    let calls = 0
    const now = Math.floor(Date.now() / 1000)
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ token: `tok-${calls}`, expires_at: now + 3600 })
    }) as unknown as typeof fetch
    expect(await getCopilotToken(gh)).toBe('tok-1')
    expect(await getCopilotToken(gh)).toBe('tok-1')
    expect(calls).toBe(1)
    invalidateCopilotToken(gh)
  })

  test('refreshes when the cached token is within the expiry skew', async () => {
    const gh = `gh-skew-${Math.random()}`
    let calls = 0
    const now = Math.floor(Date.now() / 1000)
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ token: `tok-${calls}`, expires_at: now + 10 })
    }) as unknown as typeof fetch
    expect(await getCopilotToken(gh)).toBe('tok-1')
    expect(await getCopilotToken(gh)).toBe('tok-2') // near-expiry → re-exchange
    expect(calls).toBe(2)
    invalidateCopilotToken(gh)
  })

  test('throws a helpful error when the account lacks Copilot access', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ message: 'no copilot' }, 403)) as unknown as typeof fetch
    await expect(exchangeForCopilotToken('gh-bad')).rejects.toThrow(
      /Copilot token exchange failed/,
    )
  })
})

describe('makeCopilotFetch', () => {
  test('injects Bearer token + editor headers and retries once on 401', async () => {
    const gh = `gh-fetch-${Math.random()}`
    const now = Math.floor(Date.now() / 1000)
    const apiUrl = `${COPILOT_BASE_URL}/chat/completions`
    let apiCalls = 0
    const seen: Headers[] = []
    globalThis.fetch = (async (url: unknown, init: { headers?: HeadersInit } = {}) => {
      if (String(url) === COPILOT_TOKEN_URL) {
        return jsonResponse({ token: 'cop-tok', expires_at: now + 3600 })
      }
      if (String(url) === apiUrl) {
        apiCalls++
        seen.push(new Headers(init.headers))
        return new Response('{}', { status: apiCalls === 1 ? 401 : 200 })
      }
      throw new Error(`unexpected url ${String(url)}`)
    }) as unknown as typeof fetch

    const res = await makeCopilotFetch(gh)(apiUrl, { headers: {} })
    expect(res.status).toBe(200)
    expect(apiCalls).toBe(2) // 401 → invalidate → retry
    expect(seen[0]!.get('Authorization')).toBe('Bearer cop-tok')
    expect(seen[0]!.get('Copilot-Integration-Id')).toBe(
      COPILOT_EDITOR_HEADERS['Copilot-Integration-Id'],
    )
    invalidateCopilotToken(gh)
  })
})

describe('fetchCopilotModels', () => {
  test('keeps picker-enabled chat models, drops embeddings + disabled, sorted', async () => {
    const gh = `gh-models-${Math.random()}`
    const now = Math.floor(Date.now() / 1000)
    globalThis.fetch = (async (url: unknown) => {
      if (String(url) === COPILOT_TOKEN_URL) {
        return jsonResponse({ token: 'cop-tok', expires_at: now + 3600 })
      }
      if (String(url) === `${COPILOT_BASE_URL}/models`) {
        return jsonResponse({
          data: [
            { id: 'gpt-4o', model_picker_enabled: true },
            { id: 'text-embedding-3', capabilities: { type: 'embeddings' } },
            { id: 'claude-hidden', model_picker_enabled: false },
            { id: 'gpt-4.1' },
          ],
        })
      }
      throw new Error(`unexpected url ${String(url)}`)
    }) as unknown as typeof fetch
    expect(await fetchCopilotModels(gh)).toEqual(['gpt-4.1', 'gpt-4o'])
    invalidateCopilotToken(gh)
  })

  test('returns [] without a GitHub token', async () => {
    expect(await fetchCopilotModels(undefined)).toEqual([])
  })
})
