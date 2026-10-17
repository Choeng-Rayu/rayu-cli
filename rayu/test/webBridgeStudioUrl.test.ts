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

  test.each([
    { argument: '', expired: true },
    { argument: 'pair', expired: false },
  ])('offers QR pairing with argument "$argument" and expired login $expired', async ({ argument, expired }) => {
    temporaryAuthDir = mkdtempSync(join(tmpdir(), 'rayu-bridge-auth-'))
    process.env.RAYU_AUTH_CONFIG_DIR = temporaryAuthDir
    writeRayuSession({
      accessToken: 'expired-access-token',
      refreshToken: 'invalid-refresh-token',
      expiresAt: Date.now() + (expired ? -60_000 : 3_600_000),
      user: { id: 2, email: null, displayName: null, avatarUrl: null, role: 'user' },
    })
    _setRayuFetchForTesting(async () => new Response('Invalid refresh token', { status: 401 }))
    let cancelled: unknown
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
      if (path.endsWith('/cancel')) {
        cancelled = JSON.parse(String(init?.body))
        return new Response(null, { status: 201 })
      }
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

    const result = await call(argument, context)

    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Scan this QR code')
      expect(result.value).toContain('/remote?pair=challenge_')
      expect(result.value).toContain('QR code expires at')
      expect(result.value).not.toContain('verifier_')
    }
    expect(changed).toBe(false)
    const status = await call('status', context)
    if (status.type === 'text') expect(status.value).toContain('Waiting for Studio approval')
    await call('off', context)
    expect(cancelled).toEqual({
      id: 'pairing-1234567890',
      verifier: 'verifier_abcdefghijklmnopqrstuvwxyz123456',
    })
    const stopped = await call('status', context)
    if (stopped.type === 'text') expect(stopped.value).toContain('disconnected')
  })

  test('keeps the account connection and advertises the QR alternative', async () => {
    temporaryAuthDir = mkdtempSync(join(tmpdir(), 'rayu-bridge-auth-'))
    process.env.RAYU_AUTH_CONFIG_DIR = temporaryAuthDir
    writeRayuSession({
      accessToken: 'valid-account-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 2, email: null, displayName: null, avatarUrl: null, role: 'user' },
    })
    globalThis.fetch = (async () => {
      throw new Error('Account connection must not start QR pairing')
    }) as unknown as typeof fetch
    let nextState: Record<string, unknown> = { webBridgeActive: false }
    const context = {
      getAppState: () => nextState,
      setAppState: (update: (state: typeof nextState) => typeof nextState) => {
        nextState = update(nextState)
      },
    } as unknown as LocalJSXCommandContext
    const { call } = await webBridge.load()
    const result = await call('', context)

    expect(nextState).toMatchObject({ webBridgeActive: true, webBridgeConnection: 'connecting' })
    if (result.type === 'text') expect(result.value).toContain('/web-bridge pair')
  })

  test('explains how to switch an active account connection to QR pairing', async () => {
    const { call } = await webBridge.load()
    const context = {
      getAppState: () => ({ webBridgeActive: true, webBridgeConnection: 'connected' }),
    } as unknown as LocalJSXCommandContext
    const result = await call('pair', context)

    if (result.type === 'text') {
      expect(result.value).toContain('/web-bridge off')
      expect(result.value).toContain('/web-bridge pair')
    }
  })
})
