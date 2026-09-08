/**
 * SESSION side of cross-process Telegram bridging.
 *
 * When the user attaches the chat to a session that is NOT the bridge leader,
 * that session has no Telegram transport of its own — in hosted mode it does not
 * even have a bot token. So it forwards over IPC instead:
 *
 *   this session  --notify-->  leader  --renders-->  Telegram
 *   this session  <--notify--  leader  <--taps----   Telegram
 *
 * Permission prompts map onto the existing BridgePermissionCallbacks contract
 * without adapting anything: that interface is already
 * fire-request-then-await-callback shaped (`sendRequest` + `onResponse`), which
 * is exactly what a notification-based transport provides. No timeouts are
 * introduced, because a human can legitimately leave a permission card unanswered
 * for a long time — the pending handler simply lives until a decision arrives or
 * the connection drops.
 */

import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import { isBridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { notifyIpcPeers } from '../ipc/sessionServer.js'
import { createSignal } from '../utils/signal.js'
import { logForDebugging } from '../utils/debug.js'

/** Session → leader. */
export const IPC_PERMISSION_REQUEST = 'telegram:permission-request'
export const IPC_PERMISSION_CANCEL = 'telegram:permission-cancel'
/**
 * A pending request has been decided, so every attached interface should remove its
 * copy of the card.
 *
 * ── WHY THIS IS SEPARATE FROM `CANCEL` ─────────────────────────────────────────
 *
 * `CANCEL` means the REPL withdrew the request (the tool call went away). This means a
 * human answered it. Both require the card to disappear, but only this one implies the
 * tool is now proceeding, and conflating them would report an abandoned request as an
 * approved one.
 *
 * Needed because more than one interface can be attached at a time — the Telegram chat
 * and the editor panel can both be showing the same card. `pendingDecisions` already
 * guarantees the decision is applied ONCE (the handler is deleted before it runs, so a
 * second decision for the same id finds nothing), but without this broadcast the other
 * interfaces would keep displaying a card whose outcome is already settled, and a second
 * click there would silently do nothing.
 */
export const IPC_PERMISSION_RESOLVED = 'telegram:permission-resolved'
export const IPC_STREAM_START = 'telegram:stream-start'
export const IPC_STREAM_DELTA = 'telegram:stream-delta'
export const IPC_STREAM_THINKING = 'telegram:stream-thinking'
export const IPC_STREAM_END = 'telegram:stream-end'
export const IPC_ACTIVITY = 'telegram:activity'

/** Leader → session. */
export const IPC_PERMISSION_DECISION = 'telegram:permission-decision'
export const IPC_ATTACH = 'telegram:attach'
export const IPC_DETACH = 'telegram:detach'

/** Pending decision handlers, keyed by the REPL's permission request id. */
const pendingDecisions = new Map<
  string,
  (response: BridgePermissionResponse) => void
>()

/**
 * BridgePermissionCallbacks that forward to the bridge leader.
 *
 * Shape note: `sendResponse` is a no-op here for the same reason it is in the
 * in-process Telegram implementation — decisions arrive asynchronously from the
 * chat, not from the REPL, so there is nothing for the REPL to "send".
 */
function createRemotePermissionCallbacks(): BridgePermissionCallbacks {
  return {
    sendRequest(requestId, toolName, input, toolUseId, description) {
      notifyIpcPeers(IPC_PERMISSION_REQUEST, {
        requestId,
        toolName,
        input,
        toolUseId,
        description,
      })
    },

    sendResponse() {
      // Decisions come from the chat via IPC_PERMISSION_DECISION.
    },

    cancelRequest(requestId) {
      pendingDecisions.delete(requestId)
      notifyIpcPeers(IPC_PERMISSION_CANCEL, { requestId })
    },

    onResponse(requestId, handler) {
      pendingDecisions.set(requestId, handler)
      return () => {
        pendingDecisions.delete(requestId)
      }
    },
  }
}

/**
 * Apply a decision that arrived from the leader.
 *
 * Validates with the existing `isBridgePermissionResponse` predicate rather than
 * casting: this value decides whether a tool RUNS, so a malformed payload from a
 * version-skewed peer must be dropped, not coerced into an allow.
 */
export function applyRemotePermissionDecision(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) return
  const { requestId, response } = payload as {
    requestId?: unknown
    response?: unknown
  }
  if (typeof requestId !== 'string') return
  if (!isBridgePermissionResponse(response)) {
    logForDebugging(
      '[telegram-remote] dropped a permission decision with an invalid shape',
    )
    return
  }
  const handler = pendingDecisions.get(requestId)
  if (!handler) return
  pendingDecisions.delete(requestId)
  // Announce BEFORE running the handler. The handler releases the blocked tool call,
  // which can produce output immediately; telling the interfaces first means none of
  // them is still offering a choice for a request that is already proceeding.
  //
  // Deleting the pending entry above is what makes the decision idempotent, so this
  // broadcast reaching the interface that just decided is harmless — it removes a card
  // that interface has already dismissed.
  notifyIpcPeers(IPC_PERMISSION_RESOLVED, { requestId })
  handler(response)
}

// ---- Remote-attached state -------------------------------------------------
// A module store rather than AppState: the IPC handlers that flip this are plain
// module code with no React context. useTelegramBridge subscribes and mirrors it
// into AppState, which is where useCanUseTool reads permission callbacks from.

let remoteCallbacks: BridgePermissionCallbacks | undefined
const attachedPeers = new Set<string>()
const remoteChanged = createSignal()

export const subscribeToRemoteBridge = remoteChanged.subscribe

/** The forwarding callbacks while this session is remotely attached. */
export function getRemotePermissionCallbacks():
  | BridgePermissionCallbacks
  | undefined {
  return remoteCallbacks
}

/** True while the bridge leader has this session attached to the chat. */
export function isRemotelyAttached(): boolean {
  return remoteCallbacks !== undefined
}

/**
 * Called by the IPC attach/detach handlers. On detach, every pending decision
 * handler is dropped: the cards they belong to are gone from the chat, so a
 * decision can never arrive and leaving them would leak a tool call waiting
 * forever.
 */
export function setRemotelyAttached(attached: boolean, peerId = 'legacy'): void {
  if (attached) attachedPeers.add(peerId)
  else attachedPeers.delete(peerId)
  const next = attachedPeers.size > 0 ? (remoteCallbacks ?? createRemotePermissionCallbacks()) : undefined
  if (next === remoteCallbacks) return
  if (!next) pendingDecisions.clear()
  remoteCallbacks = next
  remoteChanged.emit()
}

// ---- Outbound mirroring ----------------------------------------------------

/** Tell the leader a new assistant turn is streaming. */
export function remoteStreamStart(): void {
  notifyIpcPeers(IPC_STREAM_START)
}

/** Forward one streamed text delta. */
export function remoteStreamDelta(delta: string): void {
  notifyIpcPeers(IPC_STREAM_DELTA, { delta })
}

/** Forward the fact that the model is thinking (content is never sent). */
export function remoteStreamThinking(): void {
  notifyIpcPeers(IPC_STREAM_THINKING)
}

/** Tell the leader the turn is complete so it can finalize the mirror. */
export function remoteStreamEnd(): void {
  notifyIpcPeers(IPC_STREAM_END)
}

/**
 * Forward completed messages for the activity summary.
 *
 * Passed as already-serializable message objects; the leader runs the same
 * formatActivity rendering it uses for its own turns, so remote and local turns
 * are indistinguishable in the chat.
 */
export function remoteActivity(messages: unknown[]): void {
  notifyIpcPeers(IPC_ACTIVITY, { messages })
}
