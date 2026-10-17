import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sockets: Array<EventEmitter & { connected: boolean; auth: unknown; disconnect: () => void; io: EventEmitter }> = []
const io = mock((_url: string, options: { auth: unknown }) => {
  const socket = Object.assign(new EventEmitter(), {
    connected: false, auth: options.auth, io: new EventEmitter(),
    disconnect: mock(() => { socket.connected = false }),
    connect: mock(() => undefined),
  })
  sockets.push(socket)
  return socket
})
mock.module('socket.io-client', () => ({ io }))

let received: (message: unknown) => void = () => {}
let disposed: () => void = () => {}
const panel = {
  webview: {
    html: '', postMessage: mock(async (_message: unknown) => true),
    onDidReceiveMessage: (callback: typeof received) => { received = callback; return { dispose() {} } },
  },
  dispose: () => disposed(),
  onDidDispose: (callback: () => void) => { disposed = callback },
}
const openExternal = mock(async (_url: unknown) => true)
const writeText = mock(async (_text: string) => undefined)
mock.module('vscode', () => ({
  window: { createWebviewPanel: () => panel }, ViewColumn: { Active: 1 },
  env: { openExternal, clipboard: { writeText } }, Uri: { parse: (url: string) => url },
}))

const { WebBridgeClient } = await import('../src/webBridge/client/client.js')
const { beginGuestPairing, guestPairingStatus, getWebBridgeToken, stopGuestPairing } = await import('../src/webBridge/guestPairing.js')
const { showBridgePairingPanel } = await import('../src/vscode/host/webBridge/pairingPanel.js')
const { writeRayuSession } = await import('../src/services/rayuAuth/rayuSession.js')
const savedFetch = globalThis.fetch
const savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
const worker = { machineId: 'machine_123', hostname: 'host', cwd: '/work', sessionLabel: 'CLI', pid: 123 }
const clients: InstanceType<typeof WebBridgeClient>[] = []
let directory: string | undefined
let authDirectory: string

beforeEach(() => {
  authDirectory = mkdtempSync(join(tmpdir(), 'rayu-pairing-auth-'))
  process.env.RAYU_AUTH_CONFIG_DIR = authDirectory
})

function challengeResponse() {
  return Response.json({ id: 'pairing_123456', verifier: 'verifier_abcdefghijklmnopqrstuvwxyz123456',
    challenge: 'challenge_abcdefghijklmnopqrstuvwxyz123456', expiresAt: new Date(Date.now() + 300_000).toISOString() })
}

afterEach(() => {
  panel.dispose()
  stopGuestPairing()
  for (const client of clients.splice(0)) client.stop()
  globalThis.fetch = savedFetch
  sockets.length = 0
  io.mockClear()
  openExternal.mockClear()
  writeText.mockClear()
  panel.webview.postMessage.mockClear()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
  rmSync(authDirectory, { recursive: true, force: true })
  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
})

describe('pairing cancellation', () => {
  test('deduplicates QR issuance and cancels a response arriving after off', async () => {
    const issued = Promise.withResolvers<Response>()
    const requests: string[] = []
    globalThis.fetch = (async (input) => {
      requests.push(String(input))
      return String(input).endsWith('/begin') ? issued.promise : new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const approved = mock(() => {})
    const first = beginGuestPairing(approved, () => {}, worker)
    const repeated = beginGuestPairing(approved, () => {}, worker)
    expect(guestPairingStatus()?.status).toBe('starting')
    expect(first).toBe(repeated)
    stopGuestPairing()
    issued.resolve(challengeResponse())
    await expect(first).rejects.toThrow('cancelled')
    expect(requests.filter(path => path.endsWith('/begin'))).toHaveLength(1)
    expect(requests.filter(path => path.endsWith('/cancel'))).toHaveLength(1)
    expect(approved).not.toHaveBeenCalled()
    expect(guestPairingStatus()).toBeNull()
  })

  test('never returns a late refresh token after pairing is cancelled', async () => {
    const approval = Promise.withResolvers<void>()
    const refresh = Promise.withResolvers<Response>()
    let polls = 0
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/begin')) return challengeResponse()
      if (String(input).endsWith('/poll')) {
        if (++polls > 1) return refresh.promise
        return Response.json({ status: 'approved', token: 'worker-token', expiresAt: Date.now() + 30_000 })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await beginGuestPairing(() => approval.resolve(), () => {}, worker)
    await approval.promise
    const pending = getWebBridgeToken()
    stopGuestPairing()
    refresh.resolve(Response.json({ status: 'approved', token: 'late-worker-token' }))
    expect(await pending).toBeNull()
    expect(polls).toBe(2)
  })

  test('keeps a revoked pairing failed rather than silently connecting a different account', async () => {
    writeRayuSession({ accessToken: 'other-account-token', refreshToken: 'other-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 2, email: null, displayName: null, avatarUrl: null, role: 'user' } })
    const approval = Promise.withResolvers<void>()
    let polls = 0
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/begin')) return challengeResponse()
      if (String(input).endsWith('/poll')) return ++polls === 1
        ? Response.json({ status: 'approved', token: 'worker-token', expiresAt: Date.now() + 30_000 })
        : new Response(null, { status: 400 })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await beginGuestPairing(() => approval.resolve(), () => {}, worker)
    await approval.promise
    expect(await getWebBridgeToken()).toBeNull()
    expect(guestPairingStatus()?.status).toBe('error')
    expect(await getWebBridgeToken()).toBeNull()
  })

  test.each([{ expiresAt: 'bad-date' }, { challenge: 'tiny' }])('rejects a malformed QR challenge: %j', async (invalid) => {
    const payload = await challengeResponse().json()
    globalThis.fetch = (async () => Response.json({ ...payload, ...invalid })) as unknown as typeof fetch
    await expect(beginGuestPairing(() => {}, () => {}, worker)).rejects.toThrow('invalid pairing challenge')
    expect(guestPairingStatus()).toBeNull()
  })
})

describe('shared CLI and VS Code transport', () => {
  function client(getToken: () => Promise<string | null>) {
    const instance = new WebBridgeClient({ apiBaseUrl: 'https://api.example.test/api', getToken,
      hello: worker, handlers: { onPrompt() {}, onDecision() {}, onInterrupt() {} } })
    clients.push(instance)
    return instance
  }

  test('off prevents an in-flight connection from opening a socket', async () => {
    const token = Promise.withResolvers<string>()
    const instance = client(() => token.promise)
    const opening = instance.connect()
    instance.stop()
    token.resolve('account-token')
    expect(await opening).toBe(false)
    expect(io).not.toHaveBeenCalled()
    expect(instance.connectionState).toBe('idle')
  })

  test('concurrent connection requests open one socket', async () => {
    const token = Promise.withResolvers<string>()
    const instance = client(() => token.promise)
    const first = instance.connect()
    const repeated = instance.connect()
    token.resolve('account-token')
    expect(await first).toBe(true)
    expect(await repeated).toBe(true)
    expect(io).toHaveBeenCalledTimes(1)
  })

  test('waits for fresh credentials before sending a reconnect handshake', async () => {
    const token = Promise.withResolvers<string>()
    let lookups = 0
    const instance = client(() => ++lookups === 1 ? Promise.resolve('old-token') : token.promise)
    await instance.connect()
    const done = mock((_credentials: object) => {})
    const auth = sockets[0]!.auth as (callback: typeof done) => void
    auth(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    token.resolve('fresh-token')
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toHaveBeenCalledWith({ token: 'fresh-token' })
  })
})

describe('native VS Code pairing panel', () => {
  let engine: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rayu-pairing-panel-'))
    engine = join(directory, 'qr.cjs')
    writeFileSync(engine, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({image:'data:image/png;base64,aGVsbG8='})))")
  })

  test('uses themed controls, fixed destinations and a nonce, and closing cancels pairing', async () => {
    globalThis.fetch = (async (input) => String(input).endsWith('/begin')
      ? challengeResponse() : new Response(null, { status: 204 })) as unknown as typeof fetch
    const pairing = await beginGuestPairing(() => {}, () => {}, worker)
    await showBridgePairingPanel(engine, pairing.url, pairing.expiresAt)
    received({ type: 'ready' })
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ waiting: true, approved: false }))
    expect(panel.webview.html).toContain('var(--vscode-button-background)')
    const nonce = /script-src 'nonce-([a-f0-9]+)'/.exec(panel.webview.html)?.[1]
    expect(nonce).toBeDefined()
    expect(panel.webview.html).toContain(`<script nonce="${nonce}">`)
    received({ type: 'copy', url: 'https://attacker.example' })
    expect(writeText).toHaveBeenCalledWith(pairing.url)
    received({ type: 'open', url: 'https://attacker.example' })
    expect(openExternal).toHaveBeenCalledWith(pairing.url)
    received({ type: 'close' })
    expect(guestPairingStatus()).toBeNull()
  })

  test('shows approval and opens Remote without replaying the consumed QR challenge', async () => {
    const approved = Promise.withResolvers<void>()
    globalThis.fetch = (async (input) => String(input).endsWith('/begin') ? challengeResponse()
      : String(input).endsWith('/poll') ? Response.json({ status: 'approved', token: 'worker-token' })
        : new Response(null, { status: 204 })) as unknown as typeof fetch
    const pairing = await beginGuestPairing(() => approved.resolve(), () => {}, worker)
    await showBridgePairingPanel(engine, pairing.url, pairing.expiresAt)
    await approved.promise
    received({ type: 'ready' })
    expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ waiting: false, approved: true }))
    received({ type: 'open' })
    expect(openExternal.mock.calls[0]![0]).not.toContain('pair=')
    received({ type: 'close' })
    expect(guestPairingStatus()?.status).toBe('connected')
  })
})
