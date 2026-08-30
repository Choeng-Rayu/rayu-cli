/**
 * This session's IPC listener: the thing that makes a RAYU session addressable
 * by other local RAYU processes.
 *
 * Started once per REPL session. The Telegram bridge leader dials in to hand
 * over a prompt or to run a lifecycle operation; this session pushes permission
 * requests and streamed output back over the same connection.
 *
 * HANDLERS ARE REGISTERED, NOT HARDCODED. The listener has to start early (at
 * session registration, so a session is addressable as soon as it exists), but
 * the code that knows how to answer a prompt or a permission decision lives in
 * the bridge and loads later. A registry inverts that dependency: this module
 * knows nothing about Telegram, and the bridge adds its handlers when it starts
 * without the bootstrap path having to import it.
 */

import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { updateTelegramSessionInfo } from '../utils/concurrentSessions.js'
import { generateIpcToken } from './protocol.js'
import { startIpcServer, type IpcServerHandle } from './server.js'

/** Answers one request type. Throwing rejects the caller's promise. */
export type SessionIpcHandler = (
  payload: unknown,
) => Promise<unknown> | unknown

/** Receives one notification type. */
export type SessionIpcNotifyHandler = (payload: unknown) => void

const requestHandlers = new Map<string, SessionIpcHandler>()
const notifyHandlers = new Map<string, SessionIpcNotifyHandler>()

let handle: IpcServerHandle | null = null
let token: string | null = null
let starting: Promise<void> | null = null

/**
 * Register a handler for an inbound request type. Returns an unregister fn.
 * Later registrations for the same type replace earlier ones, so a bridge
 * restart re-binding its handlers is not an error.
 */
export function registerIpcHandler(
  type: string,
  handler: SessionIpcHandler,
): () => void {
  requestHandlers.set(type, handler)
  return () => {
    if (requestHandlers.get(type) === handler) requestHandlers.delete(type)
  }
}

/** Register a handler for an inbound notification type. */
export function registerIpcNotifyHandler(
  type: string,
  handler: SessionIpcNotifyHandler,
): () => void {
  notifyHandlers.set(type, handler)
  return () => {
    if (notifyHandlers.get(type) === handler) notifyHandlers.delete(type)
  }
}

/**
 * Bind this session's listener and publish its address + token to the session
 * registry so the leader can find it.
 *
 * Idempotent and never throws: a session that cannot bind must still be fully
 * usable at the terminal. It simply won't be remotely addressable, and the
 * absence of `ipcAddress` in its registry entry is what tells the router so.
 */
export async function startSessionIpc(): Promise<void> {
  if (handle) return
  if (starting) return starting

  starting = (async () => {
    const sessionToken = generateIpcToken()
    try {
      const started = await startIpcServer({
        token: sessionToken,
        onRequest: async (type, payload) => {
          const handler = requestHandlers.get(type)
          if (!handler) throw new Error(`no handler for ipc request: ${type}`)
          return handler(payload)
        },
        onNotify: (type, payload) => {
          notifyHandlers.get(type)?.(payload)
        },
      })
      handle = started
      token = sessionToken
      await updateTelegramSessionInfo({
        ipcAddress: started.address,
        ipcToken: sessionToken,
      })
      registerCleanup(async () => {
        await stopSessionIpc()
      })
      logForDebugging(`[ipc] session listening on ${started.address}`)
    } catch (e) {
      // Not fatal — see the doc comment. Log and leave the registry entry
      // without an address so the router treats this session as local-only.
      logForDebugging(`[ipc] session listener failed: ${errorMessage(e)}`)
    } finally {
      starting = null
    }
  })()

  return starting
}

/** Close the listener and clear the published address. */
export async function stopSessionIpc(): Promise<void> {
  const current = handle
  handle = null
  token = null
  if (!current) return
  try {
    await current.close()
  } catch {
    // best effort
  }
}

/** This session's IPC coordinates, or null when the listener isn't up. */
export function getSessionIpcInfo(): { address: string; token: string } | null {
  if (!handle || !token) return null
  return { address: handle.address, token }
}

/**
 * Push a notification to every process currently connected to this session
 * (in practice, the bridge leader). Used for streaming output and permission
 * requests that originate here.
 */
export function notifyIpcPeers(type: string, payload?: unknown): void {
  handle?.broadcast(type, payload)
}

/** True when at least one peer (i.e. the leader) is connected right now. */
export function hasIpcPeers(): boolean {
  return (handle?.connections().length ?? 0) > 0
}
