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
  delete process.env.RAYU_GATEWAY_CALLBACK
  delete process.env.RAYU_PAID_PLAN_P2P
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.USE_RAYU_OAUTH
  delete process.env.RAYU_GATEWAY_URL
  delete process.env.RAYU_ROUTE_VIA_GATEWAY
  delete process.env.RAYU_GATEWAY_CALLBACK
  delete process.env.RAYU_PAID_PLAN_P2P
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

  test('bedrock: a bearer-key provider routes; without a key it does not', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    // Bedrock in bearer-token mode -> routes. Both of its surfaces are now
    // fetch-based (Claude via the Anthropic Messages invoke endpoints, the rest
    // via bedrock-mantle), so the old Converse/AWS-SDK exclusion is obsolete.
    expect(
      m.shouldRouteViaGateway(
        provider({ id: 'bedrock', kind: 'bedrock', apiKey: 'bearer', baseURL: undefined }),
      ),
    ).toBe(true)
    // No key means SigV4 credentials, which have no fetch hook -> not routed.
    expect(
      m.shouldRouteViaGateway(
        provider({ id: 'bedrock', kind: 'bedrock', apiKey: undefined, baseURL: undefined }),
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

describe('shouldRouteViaGateway: paid-plan peer-to-peer bypass (RAYU_PAID_PLAN_P2P)', () => {
  afterEach(async () => {
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    ent._resetRayuEntitlementsForTesting()
  })

  const entitlementsWithPlan = (code: string) => ({
    plan: { code, name: code, priceCents: 0, availability: 'active' },
    maxDailyTurns: null,
    features: {},
  })

  test('DEFAULT (RAYU_PAID_PLAN_P2P unset): Basic plan still routes through the gateway', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(true)
  })

  test('DEFAULT (RAYU_PAID_PLAN_P2P unset): pro/pro_plus/max also still route through the gateway', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    for (const code of ['pro', 'pro_plus', 'max', 'enterprise']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ent._setRayuEntitlementsForTesting(entitlementsWithPlan(code) as any)
      expect(m.shouldRouteViaGateway(provider())).toBe(true)
    }
  })

  test('RAYU_PAID_PLAN_P2P=false explicitly: same as default, Basic routes through the gateway', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'false'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(true)
  })

  test('RAYU_PAID_PLAN_P2P=true + Basic plan cached -> false (direct, peer-to-peer)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(false)
  })

  test('RAYU_PAID_PLAN_P2P=true + pro/pro_plus/max cached -> false (direct)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    for (const code of ['pro', 'pro_plus', 'max', 'enterprise']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ent._setRayuEntitlementsForTesting(entitlementsWithPlan(code) as any)
      expect(m.shouldRouteViaGateway(provider())).toBe(false)
    }
  })

  test('RAYU_PAID_PLAN_P2P=true + Free plan cached -> true (Free ALWAYS routes through the gateway)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('free') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(true)
  })

  test('RAYU_PAID_PLAN_P2P=true + no entitlements cached yet -> true (fails closed, keeps the gateway hop)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    ent._setRayuEntitlementsForTesting(null)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(true)
  })

  test('RAYU_PAID_PLAN_P2P=true + rayu-hosted provider kind stays on the gateway (never P2P — it needs the gateway for its own billing)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(
      m.shouldRouteViaGateway(provider({ kind: 'rayu-hosted', baseURL: undefined })),
    ).toBe(false)
  })

  test('RAYU_ROUTE_VIA_GATEWAY=false takes precedence over the plan flag (direct regardless)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_ROUTE_VIA_GATEWAY = 'false'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('free') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider())).toBe(false)
  })

  test('RAYU_PAID_PLAN_P2P=true: Basic bypass respects other preconditions (local upstream stays direct anyway; OAuth-only kind still excluded)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    expect(m.shouldRouteViaGateway(provider({ kind: 'kiro', baseURL: undefined }))).toBe(false)
  })

  test('end-to-end: DEFAULT (flag unset) still sends a Basic user through the gateway proxy', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.com'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () => new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://gw.example.com/v1/proxy') // still went via the gateway
    expect(await res.text()).toBe('{}')
  })

  test('end-to-end: RAYU_PAID_PLAN_P2P=true sends the request straight to the provider for a Basic user', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_PAID_PLAN_P2P = 'true'
    process.env.RAYU_GATEWAY_URL = 'https://gw.example.com'
    await signIn()
    const ent = await import('../src/services/rayuAuth/rayuEntitlements.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ent._setRayuEntitlementsForTesting(entitlementsWithPlan('basic') as any)
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(() => new Response('direct-ok', { status: 200 }))
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(ORIGINAL) // never touched the gateway
    expect(await res.text()).toBe('direct-ok')
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

  test('RAYU_GATEWAY_CALLBACK=true: fail-safe to DIRECT when the response lacks the proxied marker (old gateway 404 / redirect)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_CALLBACK = 'true'
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

  test('RAYU_GATEWAY_CALLBACK=true: fail-safe to DIRECT when the gateway is unreachable', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_CALLBACK = 'true'
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

  test('RAYU_GATEWAY_CALLBACK=false: NO direct fallback on a non-proxied gateway response (fail closed)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_CALLBACK = 'false'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url) =>
      url.endsWith('/v1/proxy')
        ? new Response('404 page not found', { status: 404 }) // no x-rayu-proxied
        : new Response('direct-ok', { status: 200 }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1) // did NOT fall back to a direct provider call
    expect(res.status).toBe(404) // surfaced the gateway response instead
  })

  test('RAYU_GATEWAY_CALLBACK=false: gateway unreachable rethrows (no direct fallback)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    process.env.RAYU_GATEWAY_CALLBACK = 'false'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url) => {
      if (url.endsWith('/v1/proxy')) throw new Error('ECONNREFUSED')
      return new Response('direct-ok', { status: 200 })
    })
    await expect(
      m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' }),
    ).rejects.toThrow('ECONNREFUSED')
    expect(calls.length).toBe(1) // no direct fallback
  })

  test('DEFAULT (no RAYU_GATEWAY_CALLBACK): NO direct fallback on a non-proxied gateway response (fail closed by default)', async () => {
    // No RAYU_GATEWAY_CALLBACK set -> the new default is fail closed.
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url) =>
      url.endsWith('/v1/proxy')
        ? new Response('404 page not found', { status: 404 }) // no x-rayu-proxied
        : new Response('direct-ok', { status: 200 }),
    )
    const res = await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' })
    expect(calls.length).toBe(1) // did NOT fall back to a direct provider call
    expect(res.status).toBe(404) // surfaced the gateway response instead
  })

  test('DEFAULT (no RAYU_GATEWAY_CALLBACK): gateway unreachable rethrows (fail closed by default)', async () => {
    // No RAYU_GATEWAY_CALLBACK set -> the new default is fail closed.
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner((url) => {
      if (url.endsWith('/v1/proxy')) throw new Error('ECONNREFUSED')
      return new Response('direct-ok', { status: 200 })
    })
    await expect(
      m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, { method: 'POST' }),
    ).rejects.toThrow('ECONNREFUSED')
    expect(calls.length).toBe(1) // no direct fallback
  })
})

describe('makeGatewayRoutingFetch: request-identity + model-metadata headers (Task 2)', () => {
  const BEDROCK_URL =
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-6-v1/invoke-with-response-stream'

  test('openai-compatible: sets request-id, logical-id, resolved + canonical from body; backfills intended', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () => new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, {
      method: 'POST',
      headers: { Authorization: 'Bearer nv-key', 'Content-Type': 'application/json' },
      body: '{"model":"gpt-x"}',
    })
    const h = new Headers(calls[0].init?.headers)
    expect(h.get('x-rayu-request-id')).toBeTruthy()
    // No caller logical id -> backfilled to the request id.
    expect(h.get('x-rayu-logical-request-id')).toBe(h.get('x-rayu-request-id'))
    expect(h.get('x-rayu-resolved-model')).toBe('gpt-x')
    expect(h.get('x-rayu-canonical-model')).toBe('gpt-x')
    // intended backfilled from canonical when the caller didn't provide it.
    expect(h.get('x-rayu-intended-model')).toBe('gpt-x')
  })

  test('bedrock: resolved model is parsed from the URL path (body has no model)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const bedrock = provider({
      id: 'bedrock-anthropic',
      kind: 'bedrock',
      bedrockApi: 'anthropic',
      apiKey: 'bearer',
      baseURL: undefined,
    })
    const { fn, calls } = makeInner(
      () => new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    await m.makeGatewayRoutingFetch(bedrock, fn)(BEDROCK_URL, {
      method: 'POST',
      body: '{"max_tokens":1,"messages":[],"anthropic_version":"bedrock-2023-05-31"}',
    })
    const h = new Headers(calls[0].init?.headers)
    expect(h.get('x-rayu-upstream-url')).toBe(BEDROCK_URL)
    expect(h.get('x-rayu-resolved-model')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(h.get('x-rayu-canonical-model')).toBe('claude-opus-4-6')
  })

  test('caller-provided intended + query-source + logical id are preserved (attribution)', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    await signIn()
    const m = await import('../src/services/api/rayuHosted/gatewayRouting.ts')
    const { fn, calls } = makeInner(
      () => new Response('{}', { status: 200, headers: { 'x-rayu-proxied': '1' } }),
    )
    await m.makeGatewayRoutingFetch(provider(), fn)(ORIGINAL, {
      method: 'POST',
      headers: {
        'x-rayu-intended-model': 'claude-sonnet-4-6',
        'x-rayu-query-source': 'agent:custom',
        'x-rayu-logical-request-id': 'LID-123',
      },
      body: '{"model":"gpt-x"}',
    })
    const h = new Headers(calls[0].init?.headers)
    expect(h.get('x-rayu-intended-model')).toBe('claude-sonnet-4-6')
    expect(h.get('x-rayu-query-source')).toBe('agent:custom')
    expect(h.get('x-rayu-logical-request-id')).toBe('LID-123')
    // resolved still reflects the ACTUAL wire model, independent of intended.
    expect(h.get('x-rayu-resolved-model')).toBe('gpt-x')
  })
})
