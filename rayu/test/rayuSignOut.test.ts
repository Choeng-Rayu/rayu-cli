/**
 * Signing out of Rayu (`signOutRayu`), shared by the terminal's /logout and Rayucode:
 * every cache a sign-in leaves behind is cleared, and the API key only when asked.
 * Also the device identity's read-only peek, which the Account section relies on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { signOutRayu } from '../src/services/rayuAuth/rayuSignOut.js'
import { _resetRayuConfigCache } from '../src/utils/rayuConfig.js'
import { _resetDeviceIdentityCache, isValidDeviceId, peekDeviceIdentity } from '../src/utils/deviceIdentity.js'

const saved = { auth: process.env.RAYU_AUTH_CONFIG_DIR, config: process.env.RAYU_CONFIG_DIR, oauth: process.env.USE_RAYU_OAUTH }
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-signout-'))
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.RAYU_CONFIG_DIR = dir
  process.env.USE_RAYU_OAUTH = 'true'
  _resetRayuConfigCache()
  _resetDeviceIdentityCache()
})

afterEach(() => {
  for (const [key, name] of [['auth', 'RAYU_AUTH_CONFIG_DIR'], ['config', 'RAYU_CONFIG_DIR'], ['oauth', 'USE_RAYU_OAUTH']] as const) {
    if (saved[key] === undefined) delete process.env[name]
    else process.env[name] = saved[key]
  }
  _resetRayuConfigCache()
  _resetDeviceIdentityCache()
  rmSync(dir, { recursive: true, force: true })
})

function signIn(): void {
  writeFileSync(join(dir, 'rayu-auth.json'), JSON.stringify({
    accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
    user: { id: 1, email: null, displayName: null, avatarUrl: null, role: 'user' },
  }))
  writeFileSync(join(dir, 'rayu-entitlements.json'), '{}')
  writeFileSync(join(dir, 'rayu-media-models.json'), '{}')
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({
    activeProvider: 'rayu',
    providers: [
      { id: 'rayu-hosted', kind: 'rayu-hosted', baseURL: 'http://127.0.0.1:9/anthropic', defaultModel: 'm' },
      { id: 'rayu', kind: 'anthropic-compatible', baseURL: 'http://127.0.0.1:9', apiKey: 'rayu_sk_live_test', defaultModel: 'm' },
    ],
  }), { mode: 0o600 })
  _resetRayuConfigCache()
}

const providerIds = (): string[] =>
  (JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8')) as { providers: Array<{ id: string }> }).providers.map(p => p.id)

describe('signOutRayu', () => {
  test('keeping the API key: the account and its caches go, the key stays (Rayucode)', () => {
    signIn()
    expect(signOutRayu({ removeApiKey: false })).toEqual({ hadSession: true, hadApiKey: true, removedApiKey: false })
    for (const file of ['rayu-auth.json', 'rayu-entitlements.json', 'rayu-media-models.json']) {
      expect(existsSync(join(dir, file))).toBe(false)
    }
    expect(providerIds()).toEqual(['rayu'])
  })

  test('removing the API key too: the clean break /logout makes', () => {
    signIn()
    expect(signOutRayu({ removeApiKey: true })).toEqual({ hadSession: true, hadApiKey: true, removedApiKey: true })
    expect(providerIds()).toEqual([])
  })

  test('with nothing signed in there is nothing to do', () => {
    expect(signOutRayu({ removeApiKey: true })).toEqual({ hadSession: false, hadApiKey: false, removedApiKey: false })
  })
})

describe('/logout', () => {
  test('keeps its messages', async () => {
    const { call } = await import('../src/commands/logout/logout.js')
    expect(await call()).toEqual({ type: 'text', value: 'You are not signed in to Rayu.' })
    signIn()
    const result = await call()
    expect(result).toEqual({
      type: 'text',
      value: 'Signed out of Rayu (cleared account session and API key). Run /login to sign in again, or /connect → Rayu to use a different API key.',
    })
  })
})

describe('device identity', () => {
  test('peeking never creates an identity; it reads one the CLI made', () => {
    expect(peekDeviceIdentity()).toBeNull()
    expect(existsSync(join(dir, 'device.json'))).toBe(false)
    writeFileSync(join(dir, 'device.json'), JSON.stringify({ deviceId: 'Ab3_-dEf9GhIjKlMnOpQrS', deviceName: 'box', createdAt: 1 }))
    expect(peekDeviceIdentity()?.deviceId).toBe('Ab3_-dEf9GhIjKlMnOpQrS')
  })

  test.each([
    ['Ab3_-dEf9GhIjKlMnOpQrS', true],
    ['short', false],
    ['../users/1', false],
    ['a'.repeat(65), false],
    [42, false],
  ])('%p is a device id: %p', (value, valid) => {
    expect(isValidDeviceId(value)).toBe(valid)
  })
})
