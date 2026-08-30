/**
 * LEADER side of cross-process Telegram bridging.
 *
 * Maintains ONE persistent IPC connection to the attached session and translates
 * between it and the leader's Telegram transport.
 *
 * WHY PERSISTENT. Prompt delivery alone could dial-per-message, but permission
 * cards and streamed output flow the OTHER way — from the session back to the
 * chat, unprompted. There has to be a live channel for the session to push on,
 * so the leader holds the connection open and re-targets it on `/switch`.
 *
 * WHY THERE IS NO CARD-RENDERING CODE HERE. A remote permission request is handed
 * straight to the leader's OWN BridgePermissionCallbacks — the same object that
 * serves its own session. Everything that behaviour depends on therefore applies
 * unchanged to remote requests: the inline keyboard, the "Always allow" omission
 * for interaction tools, the AskUserQuestion interview, the plan-approval card,
 * and the typed y/n fallback. Re-implementing any of it here would have been a
 * second copy destined to drift.
 */

import type { IpcConnection } from '../ipc/connection.js'
import { connectIpc } from '../ipc/client.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { SessionRecord } from '../utils/concurrentSessions.js'
import { readSessionRecords } from '../utils/concurrentSessions.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { clearAttachment, writeAttachment } from './telegramAttach.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  IPC_ACTIVITY,
  IPC_ATTACH,
  IPC_DETACH,
  IPC_PERMISSION_CANCEL,
  IPC_PERMISSION_DECISION,
  IPC_PERMISSION_REQUEST,
  IPC_STREAM_DELTA,
  IPC_STREAM_END,
  IPC_STREAM_START,
  IPC_STREAM_THINKING,
} from './telegramRemoteBridge.js'
import type { WrappedMessage } from './formatActivity.js'

/**
 * What the link needs from the bridge to mirror a remote session's turn. These
 * are the bridge handle's own methods, so remote turns render identically to
 * local ones.
 */
export interface LeaderLinkHooks {
  permissionCallbacks: BridgePermissionCallbacks
  startTurn: () => void
  onTextDelta: (delta: string) => void
  onThinkingDelta: (delta: string) => void
  endTurn: () => Promise<void>
  pushActivity: (messages: WrappedMessage[]) => void
  /**
   * Send a plain notice to the linked chat. Needed because session loss is
   * detected here, and silently dropping the chat's target would leave the user
   * typing into a void.
   */
  notifyChat: (text: string) => void
}

interface ActiveLink {
  sessionId: string
  pid: number
  connection: IpcConnection
}

let hooks: LeaderLinkHooks | null = null
let link: ActiveLink | null = null
/** Unsubscribes for decision handlers currently registered on the leader. */
const decisionUnsubscribes = new Map<string, () => void>()

/** Install the bridge's mirroring hooks. Called once when the bridge starts. */
export function setLeaderLinkHooks(next: LeaderLinkHooks | null): void {
  hooks = next
  if (!next) void closeLeaderLink()
}

/** The session id currently linked over IPC, if any. */
export function linkedSessionId(): string | undefined {
  return link?.sessionId
}

/**
 * Ensure a live link to `record`, replacing any link to a different session.
 *
 * Returns the connection, or null when the session could not be reached — the
 * caller reports that rather than queueing into the void.
 */
export async function ensureLeaderLink(
  record: SessionRecord,
): Promise<IpcConnection | null> {
  if (link && link.sessionId === record.sessionId && !link.connection.isClosed) {
    return link.connection
  }
  await closeLeaderLink()

  if (!record.ipcAddress || !record.ipcToken) return null

  try {
    const connection = await connectIpc({
      address: record.ipcAddress,
      token: record.ipcToken,
      onNotify: (type, payload) => handleSessionNotify(type, payload),
      onClose: () => {
        // Only clear if this is still the current link — a switch may have
        // already replaced it, and clearing then would drop the new one.
        if (link?.sessionId === record.sessionId) {
          link = null
          void handleAttachedSessionLost(record)
        }
      },
    })
    link = { sessionId: record.sessionId, pid: record.pid, connection }
    // Tell the session it is driving the chat so it installs its forwarding
    // permission callbacks. Fire-and-forget: a session too old to know this
    // request still receives prompts, it just can't surface permission cards.
    connection.notify(IPC_ATTACH, {})
    logForDebugging(`[telegram-leader] linked to session ${record.sessionId}`)
    return connection
  } catch (e) {
    logForDebugging(`[telegram-leader] link failed: ${errorMessage(e)}`)
    return null
  }
}

/** Tear down the current link, telling the session it is no longer attached. */
export async function closeLeaderLink(): Promise<void> {
  const current = link
  link = null
  for (const unsubscribe of decisionUnsubscribes.values()) unsubscribe()
  decisionUnsubscribes.clear()
  if (!current) return
  try {
    if (!current.connection.isClosed) current.connection.notify(IPC_DETACH, {})
    current.connection.destroy()
  } catch {
    // best effort
  }
}

/**
 * The attached session's socket closed.
 *
 * Distinguishes a CLOSED session from a dropped connection to a session that is
 * still alive: only the former should change what the chat is pointed at. A
 * transient socket error must not silently move the user's chat to a different
 * project directory — the next prompt simply re-dials.
 */
async function handleAttachedSessionLost(record: SessionRecord): Promise<void> {
  if (isProcessRunning(record.pid)) return

  const title = record.name?.trim() || record.cwd || `pid ${record.pid}`
  const survivors = (await readSessionRecords()).filter(
    r => r.sessionId !== record.sessionId && r.ipcAddress && r.ipcToken,
  )

  if (survivors.length === 1) {
    const next = survivors[0]!
    writeAttachment({
      sessionId: next.sessionId,
      pid: next.pid,
      cwd: next.cwd,
      attachedAt: Date.now(),
    })
    hooks?.notifyChat(
      `🔌 ${title} closed.\n\n➡️ Now driving the only remaining session: ${next.name?.trim() || next.cwd}`,
    )
    return
  }

  // Zero or several survivors: do NOT guess. Clear the pointer so the next
  // prompt reports "not attached" with instructions instead of going somewhere
  // the user did not choose.
  clearAttachment()
  hooks?.notifyChat(
    survivors.length === 0
      ? `🔌 ${title} closed. No rayu-cli sessions are open.`
      : `🔌 ${title} closed. ${survivors.length} sessions remain — send /sessions, then /switch <n>.`,
  )
}

/** Route one inbound notification from the attached session. */
function handleSessionNotify(type: string, payload: unknown): void {
  if (!hooks) return
  switch (type) {
    case IPC_PERMISSION_REQUEST:
      handleRemotePermissionRequest(payload)
      return
    case IPC_PERMISSION_CANCEL: {
      const requestId = readRequestId(payload)
      if (!requestId) return
      decisionUnsubscribes.get(requestId)?.()
      decisionUnsubscribes.delete(requestId)
      hooks.permissionCallbacks.cancelRequest(requestId)
      return
    }
    case IPC_STREAM_START:
      hooks.startTurn()
      return
    case IPC_STREAM_DELTA: {
      const delta = (payload as { delta?: unknown } | null)?.delta
      if (typeof delta === 'string') hooks.onTextDelta(delta)
      return
    }
    case IPC_STREAM_THINKING:
      // The bridge only needs to know thinking HAPPENED (it shows 💭); the
      // content is deliberately never transported.
      hooks.onThinkingDelta(' ')
      return
    case IPC_STREAM_END:
      void hooks.endTurn()
      return
    case IPC_ACTIVITY: {
      const messages = (payload as { messages?: unknown } | null)?.messages
      if (Array.isArray(messages)) {
        hooks.pushActivity(messages as WrappedMessage[])
      }
      return
    }
    default:
      // Unknown type — a newer session build talking to an older leader.
      logForDebugging(`[telegram-leader] ignoring unknown notify: ${type}`)
  }
}

function readRequestId(payload: unknown): string | undefined {
  const id = (payload as { requestId?: unknown } | null)?.requestId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Render a remote session's permission request through the leader's own
 * callbacks, and pipe the decision back to that session.
 */
function handleRemotePermissionRequest(payload: unknown): void {
  if (!hooks || !link) return
  if (typeof payload !== 'object' || payload === null) return
  const { requestId, toolName, input, toolUseId, description } = payload as {
    requestId?: unknown
    toolName?: unknown
    input?: unknown
    toolUseId?: unknown
    description?: unknown
  }
  if (typeof requestId !== 'string' || typeof toolName !== 'string') return

  const connection = link.connection
  // Register BEFORE sending: the user could tap the card before this returns,
  // and an unregistered decision would be dropped.
  const unsubscribe = hooks.permissionCallbacks.onResponse(
    requestId,
    response => {
      decisionUnsubscribes.get(requestId)?.()
      decisionUnsubscribes.delete(requestId)
      if (!connection.isClosed) {
        connection.notify(IPC_PERMISSION_DECISION, { requestId, response })
      }
    },
  )
  decisionUnsubscribes.set(requestId, unsubscribe)

  hooks.permissionCallbacks.sendRequest(
    requestId,
    toolName,
    (typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {}),
    typeof toolUseId === 'string' ? toolUseId : '',
    typeof description === 'string' ? description : '',
  )
}
