import { notifyGatewayConfigChanged } from './gatewayNotify'

// The gateway serves config from a 30s snapshot, so without this notice an admin's
// save is invisible to real traffic for up to half a minute — which looks exactly
// like a save that did not work. It is best-effort: the gateway's own timer is the
// safety net, so nothing in the dashboard may break when this call does.

const originalFetch = globalThis.fetch

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('notifyGatewayConfigChanged', () => {
  it('posts the reason with the admin token and reports the refresh', async () => {
    let seenUrl = ''
    let seenAuth: string | null = null
    let seenBody = ''
    mockFetch((url, init) => {
      seenUrl = url
      seenAuth = new Headers(init?.headers).get('Authorization')
      seenBody = String(init?.body ?? '')
      return jsonResponse({ ok: true, reloaded: true, broadcast: true })
    })

    await expect(notifyGatewayConfigChanged('admin-jwt', 'models')).resolves.toBe(true)
    expect(seenUrl).toContain('/v1/_reload')
    expect(seenAuth).toBe('Bearer admin-jwt')
    expect(JSON.parse(seenBody)).toEqual({ reason: 'models' })
  })

  it('includes a user id when a change affects one account', async () => {
    let seenBody = ''
    mockFetch((_url, init) => {
      seenBody = String(init?.body ?? '')
      return jsonResponse({ reloaded: true })
    })

    await notifyGatewayConfigChanged('admin-jwt', 'plans', 42)
    expect(JSON.parse(seenBody)).toEqual({ reason: 'plans', userId: 42 })
  })

  it('never throws and reports false when the gateway cannot be reached', async () => {
    mockFetch(() => {
      throw new Error('Failed to fetch')
    })
    await expect(notifyGatewayConfigChanged('admin-jwt', 'keys')).resolves.toBe(false)
  })

  it('reports false on a refusal or a failed refresh', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'admin only' } }, 403))
    await expect(notifyGatewayConfigChanged('admin-jwt')).resolves.toBe(false)

    mockFetch(() => jsonResponse({ ok: false, reloaded: false, message: 'database down' }))
    await expect(notifyGatewayConfigChanged('admin-jwt')).resolves.toBe(false)
  })

  it('does nothing without a token', async () => {
    let called = false
    mockFetch(() => {
      called = true
      return jsonResponse({})
    })
    await expect(notifyGatewayConfigChanged(null)).resolves.toBe(false)
    await expect(notifyGatewayConfigChanged(undefined)).resolves.toBe(false)
    await expect(notifyGatewayConfigChanged('')).resolves.toBe(false)
    expect(called).toBe(false)
  })
})
