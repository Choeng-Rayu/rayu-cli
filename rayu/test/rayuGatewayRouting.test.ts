import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-gw-'))
  process.env.RAYU_CONFIG_DIR = dir
  delete process.env.USE_RAYU_OAUTH
  delete process.env.RAYU_GATEWAY_URL
  delete process.env.RAYU_ROUTE_VIA_GATEWAY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  delete process.env.RAYU_GATEWAY_URL
  delete process.env.RAYU_ROUTE_VIA_GATEWAY
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider = (over: Record<string, unknown> = {}): any => ({
  id: 'nvidia',
  kind: 'openai-compatible',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: 'nv-key',
  ...over,
})

async function signIn() {
  const sess = await import('../src/services/rayuAuth/rayuSession.ts')
  sess.writeRayuSession({
    accessToken: 'rayu-jwt',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3600_000,
    user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'user' },
  })
}

type Call = { url: string; init: RequestInit | undefined }
function makeInner(
  behavior: (url: string, init: RequestInit | undefined, n: number) => Response,
) {
  const calls: Call[] = []
  const fn = (async (url: unknown, init: RequestInit | undefined) => {
    calls.push({ url: String(url), init })
    return behavior(String(url), init, calls.length)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const ORIGINAL = 'https://integrate.api.nvidia.com/v1/chat/completions'

describe('shouldRouteViaGateway', () => {
  test('flag OFF -> false even when signed in', async () => {
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(false)
  })

  test('flag ON but not signed in -> false', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(false)
  })

  test('flag ON + signed in + openai-compatible public -> true', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(true)
  })

  test('RAYU_ROUTE_VIA_GATEWAY=false -> direct even with OAuth on + signed in', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_ROUTE_VIA_GATEWAY = 'false'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(false)
  })

  test('anthropic with no explicit baseURL -> true (uses default host)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(
      m.shouldRouteViaGateway(provider({ id: 'anthropic', kind: 'anthropic', baseURL: undefined })),
    ).toBe(true)
  })

  test('OAuth-only / hosted kinds stay direct -> false', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    for (const kind of ['genai', 'kiro', 'copilot', 'rayu-hosted']) {
      expect(m.shouldRouteViaGateway(provider({ kind, baseURL: undefined }))).toBe(false)
    }
  })

  test('gemini-vertex (OAuth bearer, native fetch) -> true', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(
      m.shouldRouteViaGateway(provider({ id: 'gemini-vertex', kind: 'vertex', baseURL: undefined })),
    ).toBe(true)
  })

  test('bedrock: only bedrockApi=anthropic WITH a bearer key routes', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    // bedrock-anthropic in bearer-token mode -> routes
    expect(
      m.shouldRouteViaGateway(
        provider({ id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'bearer', baseURL: undefined }),
      ),
    ).toBe(true)
    // Converse (AWS SDK: SigV4 + event-stream, no fetch hook) -> never routes
    expect(
      m.shouldRouteViaGateway(
        provider({ id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse', apiKey: 'x', baseURL: undefined }),
      ),
    ).toBe(false)
    // anthropic-on-bedrock without a key (would be SigV4) -> not routed
    expect(
      m.shouldRouteViaGateway(
        provider({ id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: undefined, baseURL: undefined }),
      ),
    ).toBe(false)
  })

  test('local / private upstream -> false (gateway cannot reach it)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider({ baseURL: 'http://localhost:11434/v1' }))).toBe(false)
    expect(m.shouldRouteViaGateway(provider({ baseURL: 'http://127.0.0.1:1234/v1' }))).toBe(false)
    expect(m.shouldRouteViaGateway(provider({ baseURL: 'http://192.168.1.5:8000/v1' }))).toBe(false)
  })
})

describe('makeGatewayRoutingFetch', () => {
  test('re-points to the gateway proxy with identity + upstream + preserved provider key', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.com'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () => new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    const f = m.makeGatewayRoutingFetch(provider(), fn)
    await f(ORIGINAL, {
      method: 'POST',
      headers: { Authorization: 'Bearer nv-key', 'Content-Type': 'application/json' },
      body: '{"model":"x"}',
    })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://gw.example.com/v1/proxy')
    const h = new Headers(calls[0].init?.headers)
    expect(h.get('X-Rayu-Token')).toBe('rayu-jwt')
    expect(h.get('X-Rayu-Upstream-URL')).toBe(ORIGINAL)
    expect(h.get('X-Rayu-Provider')).toBe('nvidia')
    expect(h.get('Authorization')).toBe('Bearer nv-key') // provider key forwarded
  })

  test('returns the gateway response as-is when it carries the proxied marker', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () => new Response('gw-ok', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1) // no fallback
    expect(await res.text()).toBe('gw-ok')
  })

  test('surfaces a daily-limit 429 (X-Rayu-Limit) instead of falling back to direct', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () =>
        new Response('{"reason":"daily_turn_limit"}', {
          status: 429,
          headers: { 'x-rayu-limit': 'daily_turn_limit' }, // no x-rayu-proxied
        }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1) // MUST NOT fall back to a direct provider call
    expect(res.status).toBe(429)
    expect(await res.text()).toContain('daily_turn_limit')
  })

  test('fail-safe to DIRECT when the response lacks the proxied marker (old gateway 404 / redirect)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url) =>
      url.endsWith('/v1/proxy')
        ? new Response('404 page not found', { status: 404 }) // no x-rayu-proxied
        : new Response('direct-ok', { status: 200 }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(2)
    expect(calls[1].url).toBe(ORIGINAL) // fell back to the provider directly
    expect(await res.text()).toBe('direct-ok')
  })

  test('fail-safe to DIRECT when the gateway is unreachable', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url, _i, n) => {
      if (url.endsWith('/v1/proxy') && n === 1) throw new Error('ECONNREFUSED')
      return new Response('direct-ok', { status: 200 })
    })
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(2)
    expect(calls[1].url).toBe(ORIGINAL)
    expect(await res.text()).toBe('direct-ok')
  })

  test('passthrough (no gateway) when routing is disabled', async () => {
    // Flag off -> wrapper must call the provider directly, never the gateway.
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(() => new Response('ok', { status: 200 }))
    await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(ORIGINAL)
  })
})
