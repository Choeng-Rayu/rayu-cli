// A rejected but locally-unexpired Rayu access token must be renewed once and
// the request replayed. Before this, the 401 surfaced as an auth error and the
// dead session stayed on disk, so /login short-circuited and users had to run
// /logout before /login to recover (typically noticed right after an update).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
const originalConfigDir = process.env.RAYU_CONFIG_DIR
const originalAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
const originalFetch = globalThis.fetch

const session = {
  accessToken: 'old-at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 60 * 60 * 1000,
  user: {
    id: 1,
    email: 'u@example.com',
    displayName: 'U',
    avatarUrl: null,
    role: 'user',
  },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-hosted-auth-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.USE_RAYU_OAUTH = 'true'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = originalConfigDir
  if (originalAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = originalAuthConfigDir
  delete process.env.USE_RAYU_OAUTH
})

function gatewayUrl(): string {
  return 'https://gateway.rayucode.com/anthropic/v1/messages'
}

describe('makeRayuHostedFetch 401 recovery', () => {
  test('renews the access token once and replays the request', async () => {
    const auth = await import('../src/services/rayuAuth/rayuSession.ts')
    const { makeRayuHostedFetch } = await import(
      '../src/services/api/rayuHosted/rayuHostedAuth.ts'
    )
    auth.writeRayuSession(session)

    let refreshes = 0
    auth._setRayuFetchForTesting(async () => {
      refreshes += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: 'new-at',
          refreshToken: 'new-rt',
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
      }
    })

    const seen: string[] = []
    const requestIds: string[] = []
    const logicalIds: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      // The hosted-access pre-flight may fetch entitlements in the background;
      // only gateway calls are under test here.
      if (!url.startsWith('https://gateway.rayucode.com/')) {
        return new Response('{}', { status: 200 })
      }
      const headers = new Headers(init?.headers)
      seen.push(headers.get('Authorization') ?? '')
      requestIds.push(headers.get('x-rayu-request-id') ?? '')
      logicalIds.push(headers.get('x-rayu-logical-request-id') ?? '')
      return new Response(seen.length === 1 ? 'unauthorized' : 'ok', {
        status: seen.length === 1 ? 401 : 200,
      })
    }) as typeof fetch

    const fetchHosted = makeRayuHostedFetch()
    const res = await fetchHosted(gatewayUrl(), {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-1017-cloud' }),
    })

    expect(res.status).toBe(200)
    expect(refreshes).toBe(1)
    expect(seen).toEqual(['Bearer old-at', 'Bearer new-at'])
    expect(auth.readRayuSession()?.accessToken).toBe('new-at')
    // The replay is the same LOGICAL request (one billable turn) but a new
    // physical attempt — the two ids exist for exactly this distinction.
    expect(requestIds[0]).not.toBe(requestIds[1])
    expect(logicalIds[0]).toBe(logicalIds[1])
    expect(logicalIds[0]).toBe(requestIds[0])
  })

  test('a definitive refresh refusal clears the session for /login', async () => {
    const auth = await import('../src/services/rayuAuth/rayuSession.ts')
    const { makeRayuHostedFetch } = await import(
      '../src/services/api/rayuHosted/rayuHostedAuth.ts'
    )
    auth.writeRayuSession(session)

    auth._setRayuFetchForTesting(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))

    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new Response(
        String(input).startsWith('https://gateway.rayucode.com/')
          ? 'unauthorized'
          : '{}',
        {
          status: String(input).startsWith('https://gateway.rayucode.com/')
            ? 401
            : 200,
        },
      )) as typeof fetch

    const fetchHosted = makeRayuHostedFetch()
    await expect(
      fetchHosted(gatewayUrl(), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    ).rejects.toThrow('/login')

    expect(auth.readRayuSession()).toBeNull()
    expect(auth.hasRayuSession()).toBe(false)
  })

  test('a transient refresh failure keeps the session and asks to retry', async () => {
    const auth = await import('../src/services/rayuAuth/rayuSession.ts')
    const { makeRayuHostedFetch } = await import(
      '../src/services/api/rayuHosted/rayuHostedAuth.ts'
    )
    auth.writeRayuSession(session)

    auth._setRayuFetchForTesting(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }))

    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new Response(
        String(input).startsWith('https://gateway.rayucode.com/')
          ? 'unauthorized'
          : '{}',
        {
          status: String(input).startsWith('https://gateway.rayucode.com/')
            ? 401
            : 200,
        },
      )) as typeof fetch

    const fetchHosted = makeRayuHostedFetch()
    await expect(
      fetchHosted(gatewayUrl(), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    ).rejects.toThrow('Check your connection')

    // Not a logout: the refresh token may still be valid on the next try.
    expect(auth.hasRayuSession()).toBe(true)
  })
})
