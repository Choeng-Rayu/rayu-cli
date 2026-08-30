/**
 * Client side of the local inter-session IPC.
 *
 * Used by the bridge leader to reach a session's listener. Connections are
 * short-lived by design: the leader dials when it has something to deliver and
 * lets the socket close afterwards, so a session that exits between messages is
 * detected as a connect failure rather than as a silently dead socket.
 */

import { connect, type Socket } from 'net'
import { IpcConnection, type NotifyHandler, type RequestHandler } from './connection.js'

export interface IpcClientOptions {
  address: string
  token: string
  onRequest?: RequestHandler
  onNotify?: NotifyHandler
  onClose?: () => void
  /** How long to wait for the socket to come up. */
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000

/**
 * Dial a session's IPC address.
 *
 * Rejects — rather than retrying — when the peer is gone: the caller (the
 * router) needs to know a target session is unreachable so it can tell the user,
 * not silently queue for a process that has exited.
 */
export function connectIpc(options: IpcClientOptions): Promise<IpcConnection> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  return new Promise<IpcConnection>((resolve, reject) => {
    let settled = false
    const socket: Socket = connect(options.address)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`ipc connect timed out: ${options.address}`))
    }, timeoutMs)
    try {
      ;(timer as unknown as { unref(): void }).unref()
    } catch {
      // ignore
    }

    socket.once('error', (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    })

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(
        new IpcConnection({
          socket,
          token: options.token,
          ...(options.onRequest ? { onRequest: options.onRequest } : {}),
          ...(options.onNotify ? { onNotify: options.onNotify } : {}),
          ...(options.onClose ? { onClose: options.onClose } : {}),
          ...(options.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
        }),
      )
    })
  })
}

/**
 * Dial, run one exchange, and close.
 *
 * The common shape for the router: deliver a prompt, get an ack, hang up. Always
 * closes, including on failure, so a refused peer cannot leak a socket.
 */
export async function withIpcConnection<T>(
  options: IpcClientOptions,
  fn: (connection: IpcConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectIpc(options)
  try {
    return await fn(connection)
  } finally {
    connection.destroy()
  }
}
