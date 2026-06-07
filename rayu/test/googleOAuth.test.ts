import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-goauth-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const m = await import('../src/services/oauth/googleOAuth.ts')
  m._setOAuthClientFactoryForTesting(null)
})

describe('googleOAuth token store', () => {
  test('write + read round-trips and file is 0600', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    m.writeGeminiOAuthStore({ refresh_token: 'rt', access_token: 'at', expiry_date: 123 })
    expect(m.readGeminiOAuthStore()?.refresh_token).toBe('rt')
    expect(m.hasGeminiOAuthLogin()).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'gemini-oauth.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test('logout removes the store', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    m.writeGeminiOAuthStore({ refresh_token: 'rt' })
    m.logoutGeminiOAuth()
    expect(m.hasGeminiOAuthLogin()).toBe(false)
    expect(existsSync(join(dir, 'gemini-oauth.json'))).toBe(false)
  })

  test('hasGeminiOAuthLogin is false with no store', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    expect(m.hasGeminiOAuthLogin()).toBe(false)
  })
})

describe('parseAuthCodeFromUrl', () => {
  test('extracts code and state', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    expect(m.parseAuthCodeFromUrl('/?code=abc&state=xyz')).toEqual({
      code: 'abc',
      error: undefined,
      state: 'xyz',
    })
  })
  test('extracts error', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    expect(m.parseAuthCodeFromUrl('/?error=access_denied').error).toBe('access_denied')
  })
  test('returns empty for non-redirect paths', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    expect(m.parseAuthCodeFromUrl('/favicon.ico')).toEqual({
      code: undefined,
      error: undefined,
      state: undefined,
    })
  })
})

describe('getGeminiOAuthAccessToken', () => {
  test('returns null when not logged in', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    expect(await m.getGeminiOAuthAccessToken()).toBeNull()
  })

  test('reuses a still-valid cached access token without refreshing', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    m.writeGeminiOAuthStore({
      refresh_token: 'rt',
      access_token: 'cached',
      expiry_date: Date.now() + 60 * 60 * 1000,
    })
    let refreshed = false
    m._setOAuthClientFactoryForTesting(() => ({
      generateAuthUrl: () => '',
      getToken: async () => ({ tokens: {} }),
      setCredentials: () => {},
      getAccessToken: async () => {
        refreshed = true
        return { token: 'new' }
      },
      credentials: {},
    }))
    const r = await m.getGeminiOAuthAccessToken()
    expect(r?.token).toBe('cached')
    expect(refreshed).toBe(false)
  })

  test('refreshes from the refresh token when the access token is stale', async () => {
    const m = await import('../src/services/oauth/googleOAuth.ts')
    m.writeGeminiOAuthStore({
      refresh_token: 'rt',
      access_token: 'old',
      expiry_date: Date.now() + 60 * 1000, // inside refresh skew
    })
    const newExpiry = Date.now() + 60 * 60 * 1000
    m._setOAuthClientFactoryForTesting(() => ({
      generateAuthUrl: () => '',
      getToken: async () => ({ tokens: {} }),
      setCredentials: () => {},
      getAccessToken: async () => ({ token: 'refreshed' }),
      credentials: { expiry_date: newExpiry },
    }))
    const r = await m.getGeminiOAuthAccessToken()
    expect(r?.token).toBe('refreshed')
    // persisted back to the store
    expect(m.readGeminiOAuthStore()?.access_token).toBe('refreshed')
  })
})
