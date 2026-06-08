import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-gemlogin-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.GEMINI_OAUTH_CLIENT_ID = 'cid'
  process.env.GEMINI_OAUTH_CLIENT_SECRET = 'csec'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj-x'
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.GEMINI_OAUTH_CLIENT_ID
  delete process.env.GEMINI_OAUTH_CLIENT_SECRET
  delete process.env.GOOGLE_CLOUD_PROJECT
  const m = await import('../src/services/oauth/geminiLogin.ts')
  m._setOAuthClientFactoryForTesting(null)
})

describe('geminiLogin token store', () => {
  test('write + read round-trips and file is 0600', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    m.writeGeminiLoginStore({ refresh_token: 'rt', project_id: 'proj-x' })
    expect(m.hasGeminiLogin()).toBe(true)
    expect(m.getGeminiLoginProject()).toBe('proj-x')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'gemini-login.json')).mode & 0o777).toBe(0o600)
    }
  })

  test('logout removes the store', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    m.writeGeminiLoginStore({ refresh_token: 'rt' })
    m.logoutGeminiLogin()
    expect(m.hasGeminiLogin()).toBe(false)
    expect(existsSync(join(dir, 'gemini-login.json'))).toBe(false)
  })
})

describe('parseAuthCodeFromUrl', () => {
  test('extracts code / error', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    expect(m.parseAuthCodeFromUrl('/?code=abc').code).toBe('abc')
    expect(m.parseAuthCodeFromUrl('/?error=denied').error).toBe('denied')
    expect(m.parseAuthCodeFromUrl('/favicon.ico')).toEqual({ code: undefined, error: undefined })
  })
})

describe('getGeminiLoginAccessToken', () => {
  test('returns null when not logged in', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    expect(await m.getGeminiLoginAccessToken()).toBeNull()
  })

  test('reuses a valid cached token without refreshing', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    m.writeGeminiLoginStore({
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
    expect((await m.getGeminiLoginAccessToken())?.token).toBe('cached')
    expect(refreshed).toBe(false)
  })

  test('refreshes from the refresh token when stale', async () => {
    const m = await import('../src/services/oauth/geminiLogin.ts')
    m.writeGeminiLoginStore({
      refresh_token: 'rt',
      access_token: 'old',
      expiry_date: Date.now() + 60 * 1000,
    })
    const newExpiry = Date.now() + 60 * 60 * 1000
    m._setOAuthClientFactoryForTesting(() => ({
      generateAuthUrl: () => '',
      getToken: async () => ({ tokens: {} }),
      setCredentials: () => {},
      getAccessToken: async () => ({ token: 'refreshed' }),
      credentials: { expiry_date: newExpiry },
    }))
    expect((await m.getGeminiLoginAccessToken())?.token).toBe('refreshed')
    expect(m.readGeminiLoginStore()?.access_token).toBe('refreshed')
  })
})
