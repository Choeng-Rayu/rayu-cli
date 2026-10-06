/**
 * The editor connection refuses unauthenticated peers at the HTTP upgrade.
 *
 * The port is on 127.0.0.1, which every local user — and every web page in a local
 * browser — can reach. The lockfile token is the only access control, so a peer
 * without it must never become a WebSocket at all.
 *
 * Drives `ideSocket.ts` (the socket half of `ideServer.ts`) directly, so no global
 * `vscode` module mock is needed — Bun's `mock.module` is process-wide and would leak
 * into other test files.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import WebSocket, { type WebSocketServer } from 'ws'

import {
  listenOnEphemeralPort,
} from '../src/vscode/host/ide/ideSocket.js'

const token = randomBytes(32).toString('hex')
let server: WebSocketServer
let port = 0

beforeAll(async () => {
  server = await listenOnEphemeralPort(token)
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  server.on('connection', socket => {
    socket.on('message', raw => socket.send(`echo:${String(raw)}`))
  })
})

afterAll(() => {
  server.close()
})

/** Resolve with the upgrade's HTTP status, or 101 when it became a WebSocket. */
function upgradeStatus(headers: Record<string, string>, path = '/'): Promise<number> {
  return new Promise(resolve => {
    // A raw upgrade rather than a WebSocket client, so the refusal's HTTP status is
    // observable directly instead of through a client library's error mapping.
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    })
    req.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve(101)
    })
    req.on('response', response => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', () => resolve(0))
    req.end()
  })
}

test('no token, or a wrong one, is refused before the upgrade', async () => {
  expect(port).toBeGreaterThan(0)
  expect(await upgradeStatus({})).toBe(401)
  expect(await upgradeStatus({ 'X-Claude-Code-Ide-Authorization': 'wrong' })).toBe(401)
  // Same length as the real token, so only the constant-time comparison can reject it.
  const sameLength = 'f'.repeat(token.length)
  expect(await upgradeStatus({ 'X-Claude-Code-Ide-Authorization': sameLength })).toBe(401)
  expect(await upgradeStatus({}, `/?token=${sameLength}`)).toBe(401)
})

test('the CLI header, the Rayu header and the query token are all accepted', async () => {
  expect(await upgradeStatus({ 'X-Claude-Code-Ide-Authorization': token })).toBe(101)
  expect(await upgradeStatus({ 'X-Rayu-Ide-Auth': token })).toBe(101)
  expect(await upgradeStatus({}, `/?token=${token}`)).toBe(101)
})

test('an authorised peer can exchange messages, including a whole large file', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { 'X-Claude-Code-Ide-Authorization': token },
  })
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  const next = () =>
    new Promise<string>((resolve, reject) => {
      socket.once('message', raw => resolve(String(raw)))
      socket.once('close', code => reject(new Error(`closed with ${code}`)))
    })

  socket.send('ping')
  expect(await next()).toBe('echo:ping')
  // The terminal CLI's `openDiff` carries the whole edited file. A frame cap below that
  // would close the connection (1009) instead of letting the server answer.
  const large = 'x'.repeat(2 * 1024 * 1024)
  socket.send(large)
  expect((await next()).length).toBe('echo:'.length + large.length)
  socket.close()
})
