/**
 * Attaching the panel to a CLI session running in this workspace.
 *
 * ── THIS REUSES THE CLI'S OWN CROSS-PROCESS BRIDGE ─────────────────────────────
 *
 * The CLI already has a mechanism for driving one session from another interface: the
 * per-session IPC listener in `src/ipc/sessionServer.ts`, plus the mirroring channels in
 * `src/telegram/telegramRemoteBridge.ts`. Telegram uses it to render a session's turns in
 * a chat and send decisions back. The panel is a second interface on the same channels —
 * not a new mechanism.
 *
 * Discovery is `readSessionRecords()` from `utils/concurrentSessions.ts`, the same
 * registry `/sessions` reads. Each record carries `ipcAddress` and `ipcToken`.
 *
 * ── WHY BOTH INTERFACES CAN BE ATTACHED AT ONCE ────────────────────────────────
 *
 * `notifyIpcPeers` broadcasts to every connected peer, so the mirror traffic already
 * fans out; nothing had to change for the panel to receive it alongside Telegram.
 *
 * Approvals resolve exactly once because the session deletes the pending decision handler
 * before invoking it, so a second decision for the same request id finds nothing. The one
 * missing piece was telling the OTHER interfaces that a request had been answered — added
 * as `IPC_PERMISSION_RESOLVED`, which this client honours by dismissing the card.
 *
 * ── SECURITY: THE TOKEN NEVER LEAVES THE HOST ──────────────────────────────────
 *
 * `concurrentSessions.ts` states it plainly: holding `ipcToken` is sufficient to drive a
 * session over IPC, which is why the sessions directory is 0700. It is read here, passed
 * straight to `connectIpc`, and never placed in a view model, a message to the webview,
 * or an error string. `AttachableSessionView` has no field that could carry one.
 */
import { connectIpc } from '../../../ipc/client.js'
import type { IpcConnection } from '../../../ipc/connection.js'
import {
  IPC_ACTIVITY,
  IPC_ATTACH,
  IPC_DETACH,
  IPC_PERMISSION_CANCEL,
  IPC_PERMISSION_DECISION,
  IPC_PERMISSION_REQUEST,
  IPC_PERMISSION_RESOLVED,
  IPC_PROMPT,
  IPC_STREAM_DELTA,
  IPC_STREAM_END,
  IPC_STREAM_START,
  IPC_STREAM_THINKING,
} from '../../shared/attachChannels.js'
import type { AttachTargetFrame } from '../../shared/connectProtocol.js'

/**
 * A CLI session the panel could attach to.
 *
 * Deliberately carries no address and no token — only what the user needs to choose.
 */
export interface AttachableSessionView {
  pid: number
  sessionId: string
  /** User-visible label from `/name`, when set. */
  name?: string
  cwd: string
  status?: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  startedAt: number
}

export interface AttachmentCallbacks {
  /** A turn started streaming in the CLI. */
  onStreamStart: () => void
  onStreamDelta: (delta: string) => void
  /** The model is thinking. Content is deliberately never sent over this channel. */
  onStreamThinking: () => void
  onStreamEnd: () => void
  /** Completed messages, in the engine's own wire shape. */
  onActivity: (messages: unknown[]) => void
  onPermissionRequest: (request: {
    requestId: string
    toolName: string
    input: unknown
    toolUseId?: string
    description?: string
  }) => void
  /** The request was withdrawn, or answered somewhere else. Dismiss the card. */
  onPermissionDismiss: (requestId: string) => void
  /** The CLI process went away. */
  onClosed: () => void
}

/**
 * Strip a discovered target down to what the user needs to choose.
 *
 * This is the boundary the IPC token does not cross: the returned shape has no field that
 * could carry one, so the webview cannot receive it even by accident.
 */
export function toAttachableView(target: AttachTargetFrame): AttachableSessionView {
  return {
    pid: target.pid,
    sessionId: target.sessionId,
    name: target.name,
    cwd: target.cwd,
    status:
      target.status === 'busy' || target.status === 'idle' || target.status === 'waiting'
        ? target.status
        : undefined,
    waitingFor: target.waitingFor,
    startedAt: target.startedAt,
  }
}

export interface CliAttachment {
  pid: number
  sessionId: string
  /** Queue a prompt in the attached session. Resolves once the session has queued it. */
  submitPrompt: (text: string) => Promise<void>
  /** Answer a permission request the attached session raised. */
  respondPermission: (requestId: string, response: unknown) => void
  detach: () => void
}

/**
 * Attach to a CLI session and mirror it.
 *
 * Returns `null` when the session cannot be reached — usually because it exited between
 * being listed and being dialled. That is reported to the caller rather than thrown so a
 * stale list entry is an ordinary outcome, not an error.
 */
export async function attachToCliSession(
  target: AttachTargetFrame,
  callbacks: AttachmentCallbacks,
): Promise<CliAttachment | null> {
  let connection: IpcConnection
  try {
    connection = await connectIpc({
      address: target.ipcAddress,
      token: target.ipcToken,
      onNotify: (type, payload) => routeNotification(type, payload, callbacks),
      onClose: callbacks.onClosed,
    })
  } catch {
    return null
  }

  // Tell the session an interface is attached. This is what installs its forwarding
  // permission callbacks, so cards raised in the CLI reach this panel.
  connection.notify(IPC_ATTACH)

  return {
    pid: target.pid,
    sessionId: target.sessionId,
    submitPrompt: async text => {
      // A request rather than a notification: the ack proves the session QUEUED it. The
      // answer arrives separately as mirror traffic, so this resolving does not mean the
      // turn is done.
      await connection.request(IPC_PROMPT, { value: text, mode: 'prompt' })
    },
    respondPermission: (requestId, response) => {
      connection.notify(IPC_PERMISSION_DECISION, { requestId, response })
    },
    detach: () => {
      try {
        // Detach explicitly so the session stops forwarding and drops its pending
        // decision handlers, rather than waiting for the socket to notice.
        connection.notify(IPC_DETACH)
      } catch {
        // Connection already gone; nothing to tell.
      }
      connection.destroy()
    },
  }
}

function routeNotification(
  type: string,
  payload: unknown,
  callbacks: AttachmentCallbacks,
): void {
  switch (type) {
    case IPC_STREAM_START:
      callbacks.onStreamStart()
      return
    case IPC_STREAM_DELTA: {
      const delta = (payload as { delta?: unknown } | null)?.delta
      if (typeof delta === 'string') callbacks.onStreamDelta(delta)
      return
    }
    case IPC_STREAM_THINKING:
      callbacks.onStreamThinking()
      return
    case IPC_STREAM_END:
      callbacks.onStreamEnd()
      return
    case IPC_ACTIVITY: {
      const messages = (payload as { messages?: unknown } | null)?.messages
      if (Array.isArray(messages)) callbacks.onActivity(messages)
      return
    }
    case IPC_PERMISSION_REQUEST: {
      const request = payload as Record<string, unknown> | null
      if (
        request &&
        typeof request.requestId === 'string' &&
        typeof request.toolName === 'string'
      ) {
        callbacks.onPermissionRequest({
          requestId: request.requestId,
          toolName: request.toolName,
          input: request.input,
          toolUseId:
            typeof request.toolUseId === 'string' ? request.toolUseId : undefined,
          description:
            typeof request.description === 'string' ? request.description : undefined,
        })
      }
      return
    }
    // Withdrawn and answered-elsewhere both mean "remove the card". They are distinct
    // channels because only one implies the tool is now running, but this end treats
    // them the same: either way the user must not be left with a dead choice.
    case IPC_PERMISSION_CANCEL:
    case IPC_PERMISSION_RESOLVED: {
      const requestId = (payload as { requestId?: unknown } | null)?.requestId
      if (typeof requestId === 'string') callbacks.onPermissionDismiss(requestId)
      return
    }
    default:
      // An unknown channel is skipped, never fatal. The CLI and the extension are
      // separately installable, so a newer CLI adding a channel must not break
      // attachment — the same version-tolerance rule the control client follows.
      return
  }
}
