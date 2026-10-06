import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webBridge from '../src/commands/web-bridge.js'
import {
  _setRayuFetchForTesting,
  getRayuStudioBaseUrl,
  getRayuStudioRemoteUrl,
  writeRayuSession,
} from '../src/services/rayuAuth/rayuSession.js'
import type { LocalJSXCommandContext } from '../src/types/command.js'
import { stopGuestPairing } from '../src/webBridge/guestPairing.js'

const savedStudioUrl = process.env.RAYU_STUDIO_URL
const savedWebUrl = process.env.RAYU_WEB_URL
const savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
const savedFetch = globalThis.fetch
let temporaryAuthDir: string | undefined

afterEach(() => {
  stopGuestPairing()
  globalThis.fetch = savedFetch
  _setRayuFetchForTesting(null)

  if (savedStudioUrl === undefined) delete process.env.RAYU_STUDIO_URL
  else process.env.RAYU_STUDIO_URL = savedStudioUrl

  if (savedWebUrl === undefined) delete process.env.RAYU_WEB_URL
  else process.env.RAYU_WEB_URL = savedWebUrl

  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir

  if (temporaryAuthDir) rmSync(temporaryAuthDir, { recursive: true, force: true })
  temporaryAuthDir = undefined
})

describe('standalone Studio Web Bridge link', () => {
  test('uses the production Studio remote page for a production web URL', () => {
    delete process.env.RAYU_STUDIO_URL
    process.env.RAYU_WEB_URL = 'https://rayucode.com'

    expect(getRayuStudioBaseUrl()).toBe('https://studio.rayucode.com')
    expect(getRayuStudioRemoteUrl()).toBe('https://studio.rayucode.com/remote')
  })

  test('uses the local Studio port when the web app is local', () => {
    delete process.env.RAYU_STUDIO_URL
    process.env.RAYU_WEB_URL = 'http://127.0.0.1:3000/'

    expect(getRayuStudioRemoteUrl()).toBe('http://127.0.0.1:5173/remote')
  })

  test('honors an explicit Studio URL without doubling slashes', () => {
    process.env.RAYU_STUDIO_URL = 'https://studio.example.test/'
    process.env.RAYU_WEB_URL = 'https://rayucode.com'

    expect(getRayuStudioRemoteUrl()).toBe('https://studio.example.test/remote')
  })

  test('connected command output points to standalone Studio', async () => {
    process.env.RAYU_STUDIO_URL = 'https://studio.example.test'

    const { call } = await webBridge.load()
    const context = {
      getAppState: () => ({ webBridgeActive: true, webBridgeConnection: 'connected' }),
    } as unknown as LocalJSXCommandContext

    const status = await call('status', context)
    const alreadyConnected = await call('', context)

    expect(status).toEqual({
      type: 'text',
      value: 'Web bridge: connected\nOpen https://studio.example.test/remote to drive this session.',
    })
    expect(alreadyConnected).toEqual({
      type: 'text',
      value: 'Web bridge is already connected.\nOpen https://studio.example.test/remote to drive this session.',
    })
  })

  test('offers QR pairing when the account login cannot be refreshed', async () => {
    temporaryAuthDir = mkdtempSync(join(tmpdir(), 'rayu-bridge-auth-'))
    process.env.RAYU_AUTH_CONFIG_DIR = temporaryAuthDir
    writeRayuSession({
      accessToken: 'expired-access-token',
      refreshToken: 'invalid-refresh-token',
      expiresAt: Date.now() - 60_000,
      user: { id: 2, email: null, displayName: null, avatarUrl: null, role: 'user' },
    })
    _setRayuFetchForTesting(async () => new Response('Invalid refresh token', { status: 401 }))
    globalThis.fetch = (async (_input, init) => {
      const path = String(_input)
      if (path.endsWith('/begin')) {
        return new Response(JSON.stringify({
          id: 'pairing-1234567890',
          challenge: 'challenge_abcdefghijklmnopqrstuvwxyz123456',
          verifier: 'verifier_abcdefghijklmnopqrstuvwxyz123456',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }), { status: 201 })
      }
      if (path.endsWith('/poll')) return new Response(JSON.stringify({ status: 'pending' }))
      if (path.endsWith('/cancel')) return new Response(null, { status: 201 })
      throw new Error(`Unexpected request: ${String(init?.method)}`)
    }) as typeof fetch

    let changed = false
    const context = {
      getAppState: () => ({ webBridgeActive: false }),
      setAppState: () => {
        changed = true
      },
    } as unknown as LocalJSXCommandContext
    const { call } = await webBridge.load()

    const result = await call('', context)

    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Scan this QR code')
      expect(result.value).toContain('/remote?pair=challenge_')
    }
    expect(changed).toBe(false)
    const status = await call('status', context)
    if (status.type === 'text') expect(status.value).toContain('Waiting for Studio approval')
  })
})
