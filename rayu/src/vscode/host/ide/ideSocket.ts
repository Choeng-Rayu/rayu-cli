/**
 * The editor connection's socket: bind, and authenticate every upgrade.
 *
 * Split from `ideServer.ts` so the access control is testable without the `vscode`
 * API — it is the part of that module a regression would make dangerous.
 *
 * The port is on 127.0.0.1, which every local user and every page in a local browser
 * can reach, so the lockfile token is the ONLY access control. It is checked on the
 * HTTP upgrade itself: a peer without it gets a 401 and never becomes a WebSocket, so
 * it cannot hold a socket open or stream frames at the extension host.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { WebSocketServer } from 'ws'

/**
 * Whether an upgrade request carries this server's token.
 *
 * The token may arrive as a header (what the CLI's WebSocket transport sends) or as a
 * query parameter, so both are accepted. Compared in constant time so the comparison
 * does not leak how much of a guess matched.
 */
export function isAuthorizedUpgrade(request: IncomingMessage, authToken: string): boolean {
  const header =
    request.headers['x-claude-code-ide-authorization'] ?? request.headers['x-rayu-ide-auth']
  let provided = Array.isArray(header) ? header[0] : header
  if (provided === undefined) {
    try {
      provided =
        new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
    } catch {
      return false
    }
  }
  if (typeof provided !== 'string') return false
  const expected = Buffer.from(authToken)
  const actual = Buffer.from(provided)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Bind an ephemeral 127.0.0.1 port and resolve once listening.
 *
 * `WebSocketServer` reports bind failures via the `error` event, not a throw, so the
 * promise has to bridge both.
 */
export function listenOnEphemeralPort(authToken: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    // 127.0.0.1 explicitly: the default would accept connections from the network.
    //
    // No tighter `maxPayload` than the library default: an authorised terminal CLI sends
    // `openDiff` with the WHOLE edited file (`useDiffInIDE`), and a frame over a lower cap
    // closes the connection (1009) instead of getting a JSON-RPC error. Unauthorised
    // peers never get to send a frame at all — `verifyClient` refuses their upgrade.
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ req }) => isAuthorizedUpgrade(req, authToken),
    })
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}
