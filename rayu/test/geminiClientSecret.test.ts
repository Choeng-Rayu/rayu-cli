import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  loadGeminiOAuthClient,
  parseClientSecretJson,
} from '../src/services/oauth/geminiClientSecret.ts'

const ENV = [
  'GEMINI_OAUTH_CLIENT_ID',
  'GEMINI_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLOUD_PROJECT',
  'GEMINI_OAUTH_PROJECT_ID',
  'GEMINI_OAUTH_CLIENT_FILE',
]
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('parseClientSecretJson', () => {
  test('parses the installed (Desktop) shape', () => {
    const c = parseClientSecretJson(
      JSON.stringify({ installed: { client_id: 'id-i', client_secret: 'sec-i', project_id: 'proj-i' } }),
    )
    expect(c).toEqual({ clientId: 'id-i', clientSecret: 'sec-i', projectId: 'proj-i' })
  })
  test('parses the web shape', () => {
    const c = parseClientSecretJson(
      JSON.stringify({ web: { client_id: 'id-w', client_secret: 'sec-w', project_id: 'proj-w' } }),
    )
    expect(c).toEqual({ clientId: 'id-w', clientSecret: 'sec-w', projectId: 'proj-w' })
  })
  test('prefers installed over web', () => {
    const c = parseClientSecretJson(
      JSON.stringify({
        installed: { client_id: 'id-i', client_secret: 'sec-i' },
        web: { client_id: 'id-w', client_secret: 'sec-w' },
      }),
    )
    expect(c?.clientId).toBe('id-i')
  })
  test('returns null on malformed / incomplete json', () => {
    expect(parseClientSecretJson('not json')).toBeNull()
    expect(parseClientSecretJson(JSON.stringify({ installed: { client_id: 'x' } }))).toBeNull()
  })
})

describe('loadGeminiOAuthClient', () => {
  test('env credentials take precedence', () => {
    process.env.GEMINI_OAUTH_CLIENT_ID = 'env-id'
    process.env.GEMINI_OAUTH_CLIENT_SECRET = 'env-secret'
    process.env.GOOGLE_CLOUD_PROJECT = 'env-proj'
    expect(loadGeminiOAuthClient()).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
      projectId: 'env-proj',
    })
  })
  test('falls back to the public gemini-cli client when nothing is configured', () => {
    process.env.GEMINI_OAUTH_CLIENT_FILE = '/nonexistent/client_secret.json'
    const c = loadGeminiOAuthClient()
    // Assert via shape (not the full literal) so this file doesn't embed the
    // Google-OAuth-pattern string that secret scanners flag.
    expect(c?.clientId).toMatch(/^681255809395-.+\.apps\.googleusercontent\.com$/)
    expect(c?.clientId).toContain('apps.googleusercontent')
    expect(c?.clientSecret?.startsWith('GOCSPX')).toBe(true)
    expect((c?.clientSecret?.length ?? 0)).toBeGreaterThan(20)
  })
})
