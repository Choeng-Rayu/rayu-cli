/**
 * The IPC listener a RAYU session runs so other local sessions can reach it.
 *
 * One server per session, addressed by pid (see paths.ts). The bridge leader
 * connects in to hand over prompts; the session pushes permission requests and
 * streamed output back over the same connection.
 */

import { createServer, type Server, type Socket } from 'net'
import { chmodSync, unlinkSync } from 'fs'
import { connect as netConnect } from 'net'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  IpcConnection,
  type NotifyHandler,
  type RequestHandler,
} from './connection.js'
import { ipcAddressForPid, isUnlinkableAddress, isWindowsIpc } from './paths.js'

export interface IpcServerOptions {
  /** Shared secret every frame must carry. */
  token: string
  onRequest?: RequestHandler
  onNotify?: NotifyHandler
  /** Address override. Defaults to this process's pid-derived address. */
  address?: string
}

export interface IpcServerHandle {
  address: string
  /** Live peer connections, for pushing notifications outward. */
  connections: () => IpcConnection[]
  /** Broadcast a notification to every connected peer. */
  broadcast: (type: string, payload?: unknown) => void
  close: () => Promise<void>
}

/**
 * Is something alive on this address?
 *
 * Used to tell a genuinely-in-use address from a stale socket file left behind
 * by a SIGKILLed session. A refused connection means the file is an orphan and
 * can be removed; a successful one means a live peer owns it and we must not.
 */
async function isAddressLive(address: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const probe = netConnect(address)
    const settle = (live: boolean): void => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(live)
    }
    probe.once('connect', () => settle(true))
    probe.once('error', () => settle(false))
    // A peer that accepts but never speaks should not hang startup.
    const timer = setTimeout(() => settle(false), 500)
    try {
      ;(timer as unknown as { unref(): void }).unref()
    } catch {
      // ignore
    }
  })
}

/** Start listening. Reclaims a stale address; refuses to steal a live one. */
export async function startIpcServer(
  options: IpcServerOptions,
): Promise<IpcServerHandle> {
  const address = options.address ?? ipcAddressForPid(process.pid)
  const connections = new Set<IpcConnection>()

  const server: Server = createServer((socket: Socket) => {
    const connection = new IpcConnection({
      socket,
      token: options.token,
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
      ...(options.onNotify ? { onNotify: options.onNotify } : {}),
      onClose: () => connections.delete(connection),
      onReject: reason =>
        logForDebugging(`[ipc] rejected frame from peer: ${reason}`),
    })
    connections.add(connection)
  })

  await listenReclaiming(server, address)

  // Restrict the socket to the owning user. No-op on Windows, where the pipe
  // has no usable ACL — hence the mandatory per-frame token.
  if (!isWindowsIpc()) {
    try {
      chmodSync(address, 0o600)
    } catch {
      // Non-fatal: the token still authenticates every frame.
    }
  }

  return {
    address,
    connections: () => [...connections],
    broadcast: (type, payload) => {
      for (const connection of connections) connection.notify(type, payload)
    },
    close: async () => {
      for (const connection of connections) connection.destroy()
      connections.clear()
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (isUnlinkableAddress(address)) {
        try {
          unlinkSync(address)
        } catch {
          // already gone
        }
      }
    },
  }
}

/**
 * Bind, reclaiming the address once if it turns out to be a stale socket file.
 *
 * Without this, a session killed with SIGKILL (no cleanup handler runs) would
 * leave a file that permanently blocks the next session with the same pid from
 * listening — and pid reuse is routine.
 */
async function listenReclaiming(server: Server, address: string): Promise<void> {
  try {
    await listenOnce(server, address)
    return
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EADDRINUSE') throw e
  }

  if (await isAddressLive(address)) {
    throw new Error(`ipc address already in use by a live session: ${address}`)
  }
  if (isUnlinkableAddress(address)) {
    try {
      unlinkSync(address)
    } catch (e) {
      logForDebugging(`[ipc] could not unlink stale socket: ${errorMessage(e)}`)
    }
  }
  await listenOnce(server, address)
}

function listenOnce(server: Server, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      server.removeListener('listening', onListening)
      reject(e)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(address)
  })
}
