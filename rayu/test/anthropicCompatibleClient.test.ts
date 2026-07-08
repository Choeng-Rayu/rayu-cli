import { describe, expect, test } from 'bun:test'
import { createAnthropicCompatibleClient } from '../src/services/api/anthropicCompatibleClient.ts'

describe('anthropic-compatible client (LongCat)', () => {
  test('builds a native Anthropic client with the provider baseURL + Bearer authToken (no x-api-key leak)', () => {
    const client = createAnthropicCompatibleClient(
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc-secret',
        baseURL: 'https://api.longcat.chat/anthropic',
        defaultModel: 'LongCat-2.0',
      },
      2,
    )
    // Custom endpoint, not first-party api.anthropic.com. The Anthropic SDK
    // appends /v1/messages → https://api.longcat.chat/anthropic/v1/messages.
    expect(client.baseURL).toBe('https://api.longcat.chat/anthropic')
    // Bearer auth: authToken set → `Authorization: Bearer lc-secret`. apiKey is
    // pinned null so there's no `x-api-key` header and a stray ANTHROPIC_API_KEY
    // in the environment is never leaked to the third-party host.
    expect(client.authToken).toBe('lc-secret')
    expect(client.apiKey).toBeNull()
  })

  test('honors ANTHROPIC_API_KEY-free auth even when that env var is set', () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak'
    try {
      const client = createAnthropicCompatibleClient(
        {
          id: 'longcat',
          kind: 'anthropic-compatible',
          apiKey: 'lc-secret',
          baseURL: 'https://api.longcat.chat/anthropic',
        },
        1,
      )
      // apiKey stays null (not the env key) → no x-api-key sent to LongCat.
      expect(client.apiKey).toBeNull()
      expect(client.authToken).toBe('lc-secret')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  test('applies the shared first-party transport (timeout) but keeps auth + baseURL authoritative', () => {
    const client = createAnthropicCompatibleClient(
      {
        id: 'longcat',
        kind: 'anthropic-compatible',
        apiKey: 'lc-secret',
        baseURL: 'https://api.longcat.chat/anthropic',
      },
      3,
      {
        // Mirrors what client.ts passes (the first-party Anthropic transport). A
        // transport apiKey/baseURL must NOT override the authoritative auth/endpoint.
        timeout: 123456,
        defaultHeaders: { 'User-Agent': 'rayu-test/1' },
        apiKey: 'should-be-ignored',
        baseURL: 'https://evil.example',
      },
    )
    expect(client.timeout).toBe(123456)
    expect(client.apiKey).toBeNull()
    expect(client.authToken).toBe('lc-secret')
    expect(client.baseURL).toBe('https://api.longcat.chat/anthropic')
  })
})
