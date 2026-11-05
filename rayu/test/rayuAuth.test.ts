import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let dir: string
const originalConfigDir = process.env.RAYU_CONFIG_DIR
const originalAuthConfigDir = process.env.RAYU_AUTH_CONFIG_DIR
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-auth-'))
  process.env.RAYU_CONFIG_DIR = dir
  // Auth storage has higher precedence than RAYU_CONFIG_DIR. Isolate both so
  // these tests can never read or mutate the developer's VS Code session.
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  delete process.env.USE_RAYU_OAUTH
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = originalConfigDir
  if (originalAuthConfigDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = originalAuthConfigDir
  delete process.env.USE_RAYU_OAUTH
  const m = await import('../src/services/rayuAuth/rayuSession.ts')
  m._setRayuFetchForTesting(null)
})

const sampleSession = {
  accessToken: 'at',
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

describe('rayuSession store', () => {
  test('write + read round-trips and file is 0600', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession(sampleSession)
    expect(m.readRayuSession()?.accessToken).toBe('at')
    expect(m.hasRayuSession()).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'rayu-auth.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test('clear removes the session', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession(sampleSession)
    m.clearRayuSession()
    expect(m.hasRayuSession()).toBe(false)
    expect(existsSync(join(dir, 'rayu-auth.json'))).toBe(false)
  })
})

describe('USE_RAYU_OAUTH flag + login gate', () => {
  test('flag defaults to false (current behavior preserved)', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    expect(m.isUseRayuOAuthEnabled()).toBe(false)
  })

  test('gate is null when flag is off, even without a session', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    expect(m.rayuLoginGateMessage()).toBeNull()
  })

  test('gate blocks when flag on and not signed in', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    expect(m.rayuLoginGateMessage()).toContain('/login')
  })

  test('gate allows when flag on and signed in', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession(sampleSession)
    expect(m.rayuLoginGateMessage()).toBeNull()
  })
})

describe('buildCliLoginUrl', () => {
  test('builds the website cli-login url with port + state', async () => {
    const m = await import('../src/services/rayuAuth/rayuLogin.ts')
    const url = new URL(m.buildCliLoginUrl('http://localhost:3000/', 52431, 'st8'))
    expect(url.pathname).toBe('/cli-login')
    expect(url.searchParams.get('port')).toBe('52431')
    expect(url.searchParams.get('state')).toBe('st8')
  })
})

describe('getValidRayuAccessToken', () => {
  test('returns null when not logged in', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    expect(await m.getValidRayuAccessToken()).toBeNull()
  })

  test('returns the cached token when not expired', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession(sampleSession)
    let called = false
    m._setRayuFetchForTesting(async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({}) }
    })
    expect(await m.getValidRayuAccessToken()).toBe('at')
    expect(called).toBe(false)
  })

  test('refreshes when the access token is expired', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({ ...sampleSession, expiresAt: Date.now() - 1000 })
    m._setRayuFetchForTesting(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    }))
    expect(await m.getValidRayuAccessToken()).toBe('new-at')
    expect(m.readRayuSession()?.accessToken).toBe('new-at')
  })

  test('a transient refresh failure keeps the session for the next try', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({ ...sampleSession, expiresAt: Date.now() - 1000 })
    m._setRayuFetchForTesting(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }))
    expect(await m.getValidRayuAccessToken()).toBeNull()
    expect(m.readRayuSession()?.accessToken).toBe('at')
    expect(m.rayuLoginGateMessage()).toBeNull()
  })

  test('a refused refresh clears the dead session so /login is not blocked', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({ ...sampleSession, expiresAt: Date.now() - 1000 })
    m._setRayuFetchForTesting(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }))
    expect(await m.getValidRayuAccessToken()).toBeNull()
    expect(m.readRayuSession()).toBeNull()
    expect(m.hasRayuSession()).toBe(false)
    expect(m.rayuLoginGateMessage()).toContain('/login')
  })

  test('an expired session with no refresh token is not usable', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({
      ...sampleSession,
      refreshToken: '',
      expiresAt: Date.now() - 1000,
    })
    expect(m.hasRayuSession()).toBe(true)
    expect(m.hasUsableRayuSession()).toBe(false)
  })

  test('refreshRayuAccessToken reuses a token renewed by another process', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({
      ...sampleSession,
      accessToken: 'fresh-at',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    let called = false
    m._setRayuFetchForTesting(async () => {
      called = true
      return { ok: true, status: 200, json: async () => ({}) }
    })
    expect(await m.refreshRayuAccessToken('stale-at')).toBe('fresh-at')
    expect(called).toBe(false)
  })

  test('a sign-in that lands mid-refresh is not overwritten', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({ ...sampleSession, expiresAt: Date.now() - 1000 })

    let releaseFetch!: (value: unknown) => void
    m._setRayuFetchForTesting(
      () => new Promise(resolve => (releaseFetch = resolve)) as never,
    )

    const pending = m.getValidRayuAccessToken()
    // Meanwhile the user signs in again (or another process renews the session).
    m.writeRayuSession({
      ...sampleSession,
      accessToken: 'other-at',
      refreshToken: 'other-rt',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    releaseFetch({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'stale-refreshed',
        refreshToken: 'stale-rt',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    })

    expect(await pending).toBe('other-at')
    expect(m.readRayuSession()?.accessToken).toBe('other-at')
    expect(m.readRayuSession()?.refreshToken).toBe('other-rt')
  })

  test('a refused refresh does not delete a session written meanwhile', async () => {
    process.env.USE_RAYU_OAUTH = 'true'
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    m.writeRayuSession({ ...sampleSession, expiresAt: Date.now() - 1000 })

    let releaseFetch!: (value: unknown) => void
    m._setRayuFetchForTesting(
      () => new Promise(resolve => (releaseFetch = resolve)) as never,
    )

    const pending = m.getValidRayuAccessToken()
    m.writeRayuSession({
      ...sampleSession,
      accessToken: 'other-at',
      refreshToken: 'other-rt',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    releaseFetch({ ok: false, status: 401, json: async () => ({}) })

    expect(await pending).toBe('other-at')
    expect(m.readRayuSession()?.accessToken).toBe('other-at')
    expect(m.rayuLoginGateMessage()).toBeNull()
  })
})

describe('recordRayuUsageBestEffort', () => {
  test('never throws when not logged in', async () => {
    const m = await import('../src/services/rayuAuth/rayuSession.ts')
    await expect(
      m.recordRayuUsageBestEffort('anthropic', 'claude'),
    ).resolves.toBeUndefined()
  })
})
