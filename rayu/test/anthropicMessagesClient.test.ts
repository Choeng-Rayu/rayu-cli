import { describe, expect, test } from 'bun:test'
import { createAnthropicMessagesClient } from '../src/services/api/anthropicMessagesClient.ts'

// The unified Anthropic Messages builder. Every provider that speaks the native
// Anthropic Messages wire format is constructed here — first-party Anthropic,
// anthropic-compatible BYO-key endpoints (LongCat, Ollama Cloud), rayu-hosted,
// and (from Task 5/8/9) Claude on Bedrock / Azure / Vertex. Only the auth mode,
// the endpoint and the first-party flag differ.
//
// These tests pin the SECURITY invariants: credentials/endpoint always win over
// transport options, `apiKey` is pinned null for third-party Bearer auth so a
// stray ANTHROPIC_API_KEY can never leak, and first-party-only headers stay
// first-party.

describe('anthropic-compatible (Bearer) providers', () => {
  test('uses the provider baseURL + Bearer authToken with no x-api-key leak', () => {
    const client = createAnthropicMessagesClient({
      maxRetries: 2,
      auth: { mode: 'bearer', keys: ['lc-secret'] },
      baseURL: 'https://api.longcat.chat/anthropic',
    })
    // Custom endpoint, not first-party api.anthropic.com. The Anthropic SDK
    // appends /v1/messages → https://api.longcat.chat/anthropic/v1/messages.
    expect(client.baseURL).toBe('https://api.longcat.chat/anthropic')
    // Bearer auth: authToken set → `Authorization: Bearer lc-secret`. apiKey is
    // pinned null so there's no `x-api-key` header.
    expect(client.authToken).toBe('lc-secret')
    expect(client.apiKey).toBeNull()
    expect(client.maxRetries).toBe(2)
  })

  test('a stray ANTHROPIC_API_KEY is never sent to a third-party host', () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak'
    try {
      const client = createAnthropicMessagesClient({
        maxRetries: 1,
        auth: { mode: 'bearer', keys: ['lc-secret'] },
        baseURL: 'https://api.longcat.chat/anthropic',
      })
      expect(client.apiKey).toBeNull()
      expect(client.authToken).toBe('lc-secret')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })

  test('blank keys are filtered and the first surviving key becomes the authToken', () => {
    const client = createAnthropicMessagesClient({
      maxRetries: 1,
      auth: { mode: 'bearer', keys: ['  ', 'real-key', 'second'] },
      baseURL: 'https://ollama.com',
    })
    expect(client.authToken).toBe('real-key')
  })

  test('applies the shared transport timeout (API_TIMEOUT_MS)', () => {
    const prev = process.env.API_TIMEOUT_MS
    process.env.API_TIMEOUT_MS = '123456'
    try {
      const client = createAnthropicMessagesClient({
        maxRetries: 3,
        auth: { mode: 'bearer', keys: ['lc-secret'] },
        baseURL: 'https://api.longcat.chat/anthropic',
      })
      expect(client.timeout).toBe(123456)
      // Auth + endpoint stay authoritative alongside the transport.
      expect(client.apiKey).toBeNull()
      expect(client.authToken).toBe('lc-secret')
      expect(client.baseURL).toBe('https://api.longcat.chat/anthropic')
    } finally {
      if (prev === undefined) delete process.env.API_TIMEOUT_MS
      else process.env.API_TIMEOUT_MS = prev
    }
  })
})

describe('first-party vs third-party header gating', () => {
  /** Capture the headers of the first outgoing request. */
  function captureFetch(sink: Array<Record<string, string>>): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      const h: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v
      })
      sink.push(h)
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  async function headersFor(
    opts: Parameters<typeof createAnthropicMessagesClient>[0],
  ): Promise<Record<string, string>> {
    const seen: Array<Record<string, string>> = []
    const client = createAnthropicMessagesClient({
      ...opts,
      fetchOverride: captureFetch(seen),
    })
    await client.messages
      .create({
        model: 'test-model',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .catch(() => undefined)
    expect(seen.length).toBeGreaterThan(0)
    return seen[0]!
  }

  test('ANTHROPIC_CUSTOM_HEADERS and the session id are FIRST-PARTY only', async () => {
    const prev = process.env.ANTHROPIC_CUSTOM_HEADERS
    // The documented corporate-proxy use case: a credential in a custom header.
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer corp-token'
    try {
      const tp = await headersFor({
        maxRetries: 0,
        auth: { mode: 'bearer', keys: ['lc-secret'] },
        baseURL: 'https://api.longcat.chat/anthropic',
      })
      // SECURITY: forwarding a first-party Authorization credential to LongCat
      // would leak it to that host. subprocessEnv.ts already treats this env var
      // as auth material (scrubbed alongside ANTHROPIC_API_KEY). The provider's
      // OWN Bearer key is what must appear here.
      expect(tp['authorization']).toBe('Bearer lc-secret')
      expect(tp['x-claude-code-session-id']).toBeUndefined()
      // Non-identifying client headers are still sent.
      expect(tp['x-app']).toBe('cli')
      expect(typeof tp['user-agent']).toBe('string')

      const fp = await headersFor({
        maxRetries: 0,
        firstParty: true,
        auth: { mode: 'x-api-key', apiKey: 'sk-ant-test' },
      })
      expect(fp['authorization']).toBe('Bearer corp-token')
      expect(typeof fp['x-claude-code-session-id']).toBe('string')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
      else process.env.ANTHROPIC_CUSTOM_HEADERS = prev
    }
  })

  test('the x-api-key header is only ever sent with first-party auth', async () => {
    const tp = await headersFor({
      maxRetries: 0,
      auth: { mode: 'bearer', keys: ['lc-secret'] },
      baseURL: 'https://api.longcat.chat/anthropic',
    })
    expect(tp['x-api-key']).toBeUndefined()

    const fp = await headersFor({
      maxRetries: 0,
      firstParty: true,
      auth: { mode: 'x-api-key', apiKey: 'sk-ant-test' },
    })
    expect(fp['x-api-key']).toBe('sk-ant-test')
  })

  test('x-client-request-id is injected for first-party only', async () => {
    const tp = await headersFor({
      maxRetries: 0,
      auth: { mode: 'bearer', keys: ['lc'] },
      baseURL: 'https://api.longcat.chat/anthropic',
    })
    // Previously this leaked, because buildFetch() derived "is first party" from
    // getAPIProvider() === 'anthropic' && !isOpenAICompatibleActive() &&
    // isFirstPartyAnthropicBaseUrl() — all true for a kind:'anthropic-compatible'
    // provider (ANTHROPIC_BASE_URL unset ⇒ the last check returns true).
    expect(tp['x-client-request-id']).toBeUndefined()

    const fp = await headersFor({
      maxRetries: 0,
      firstParty: true,
      auth: { mode: 'x-api-key', apiKey: 'sk-ant-test' },
    })
    expect(typeof fp['x-client-request-id']).toBe('string')
  })
})

describe('custom-fetch (JWT / OAuth) providers', () => {
  test('rayu-hosted style: the credential comes from the fetch wrapper, not apiKey', async () => {
    let sawAuth: string | null = null
    const jwtFetch = (async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer rayu-jwt')
      sawAuth = headers.get('Authorization')
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const client = createAnthropicMessagesClient({
      maxRetries: 0,
      auth: { mode: 'custom-fetch', fetch: jwtFetch },
      baseURL: 'https://gw.example.test/anthropic',
    })
    expect(client.baseURL).toBe('https://gw.example.test/anthropic')
    // Placeholder only — never a real credential.
    expect(client.apiKey).toBe('rayu')
    await client.messages
      .create({
        model: 'deepseek-chat',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .catch(() => undefined)
    expect<string | null>(sawAuth).toBe('Bearer rayu-jwt')
  })
})
