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
import { randomUUID } from 'node:crypto'
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
  IPC_TASK_MESSAGE,
  IPC_SIDE_QUESTION,
  IPC_TASK_SNAPSHOT,
  IPC_TASK_STATE_CHANGED,
  IPC_TASK_STOP,
  IPC_CAPABILITIES,
  IPC_CONVERSATION_SNAPSHOT,
  IPC_RUNTIME_SNAPSHOT,
  IPC_RUNTIME_ACTION,
  IPC_RUNTIME_STATE_CHANGED,
  type AttachedRuntimeCapabilities,
} from '../../shared/attachChannels.js'
import type {
  AttachedConversationSnapshot,
  RuntimeAction,
  RuntimeActionResponse,
  RuntimeStateSnapshot,
} from '../../shared/attachProtocol.js'
import type { AttachTargetFrame } from '../../shared/connectProtocol.js'
import type {
  BackgroundTaskView,
  PromptDeliveryView,
} from '../../shared/webviewProtocol.js'

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
  onTaskSnapshot?: (tasks: BackgroundTaskView[]) => void
  onTaskEvent?: (event: Record<string, unknown>) => void
  onTaskUnsupported?: (message: string) => void
  /**
   * Initial conversation history replay from the attached CLI.
   * Called once after capability negotiation when the CLI supports
   * `conversationSnapshot`.  Each `messages` item is the same shape as
   * `onActivity`'s argument.
   */
  onConversationSnapshot?: (messages: unknown[]) => void
  /**
   * Initial runtime state snapshot from the attached CLI.
   * Called once after capability negotiation when the CLI supports
   * `runtimeSnapshot`.
   */
  onRuntimeSnapshot?: (snapshot: RuntimeStateSnapshot) => void
  /**
   * A push notification that the CLI's runtime state changed.
   * The payload is the same shape as `onRuntimeSnapshot`.
   */
  onRuntimeStateChanged?: (snapshot: RuntimeStateSnapshot) => void
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
  /** What this attached CLI answered on `IPC_CAPABILITIES`, or `null` if it predates it. */
  capabilities: AttachedRuntimeCapabilities | null
  /**
   * Queue a prompt in the attached session. Resolves with the operation id used to
   * correlate this specific submission with its later mirrored-activity echo, once
   * the CLI has queued it. Two prompts with identical text sent close together are
   * otherwise indistinguishable to `applyMirroredActivity`'s FIFO.
   */
  submitPrompt: (text: string, delivery?: PromptDeliveryView) => Promise<string>
  askSideQuestion: (question: string) => Promise<string>
  /** Answer a permission request the attached session raised. */
  respondPermission: (requestId: string, response: unknown) => void
  stopTask: (taskId: string) => Promise<void>
  sendTaskMessage: (taskId: string, text: string) => Promise<void>
  /**
   * Send a typed runtime action to the attached CLI.
   * Resolves with the response once the CLI acknowledges it.
   * Only available when `capabilities.features.configurationActions` is true.
   */
  sendRuntimeAction: (action: RuntimeAction) => Promise<RuntimeActionResponse>
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

  // Capability negotiation happens FIRST and unconditionally: every other
  // `rayucode:*` request below is meaningless until this settles, because an
  // older CLI has no handler for it at all rather than a "not supported" answer.
  // A rejection here is not an error — it IS the fallback signal.
  const capabilities = await requestAttachedCapabilities(connection)

  // Snapshot before relying on notifications: tasks may have started before attach.
  try {
    const snapshot = await connection.request(IPC_TASK_SNAPSHOT, {}) as {
      version?: unknown
      tasks?: unknown
    }
    if (snapshot.version === 1 && Array.isArray(snapshot.tasks)) {
      callbacks.onTaskSnapshot?.(snapshot.tasks as BackgroundTaskView[])
    } else {
      callbacks.onTaskUnsupported?.('The attached CLI returned an incompatible task snapshot.')
    }
  } catch {
    // Version skew is capability-local. Chat mirroring remains fully attached.
    callbacks.onTaskUnsupported?.(
      'This CLI version does not support live background-task inspection.',
    )
  }

  // ── Task 12: Conversation snapshot ─────────────────────────────────────────
  // Replay existing transcript so the panel can show history that predates this
  // attachment.  Gated on the capability flag so older CLIs are unaffected.
  if (capabilities?.features.conversationSnapshot && callbacks.onConversationSnapshot) {
    try {
      const convSnapshot = await connection.request(
        IPC_CONVERSATION_SNAPSHOT,
        {},
      ) as AttachedConversationSnapshot
      if (convSnapshot?.version === 1 && Array.isArray(convSnapshot.messages)) {
        callbacks.onConversationSnapshot(convSnapshot.messages)
      }
    } catch {
      // Older CLI or capability mismatch — no history replay, but still attached.
    }
  }

  // ── Task 15: Runtime snapshot ───────────────────────────────────────────────
  // Pull the initial configuration state so the panel can show model, permission
  // mode, MCP status, etc. without waiting for a state-change push.
  if (capabilities?.features.runtimeSnapshot && callbacks.onRuntimeSnapshot) {
    try {
      const runtimeSnapshot = await connection.request(
        IPC_RUNTIME_SNAPSHOT,
        {},
      ) as RuntimeStateSnapshot
      if (runtimeSnapshot?.version === 1) {
        callbacks.onRuntimeSnapshot(runtimeSnapshot)
      }
    } catch {
      // Non-fatal: the panel will receive a push notification on the next state
      // change and can catch up then.
    }
  }

  return {
    pid: target.pid,
    sessionId: target.sessionId,
    capabilities,
    submitPrompt: async (text, delivery = 'normal') => {
      // A request rather than a notification: the ack proves the session QUEUED it. The
      // answer arrives separately as mirror traffic, so this resolving does not mean the
      // turn is done.
      const operationId = randomUUID()
      await connection.request(IPC_PROMPT, {
        value: text,
        mode: 'prompt',
        operationId,
        ...(delivery === 'steer'
          ? { priority: 'now' }
          : delivery === 'queue'
            ? { priority: 'next' }
            : {}),
      })
      return operationId
    },
    askSideQuestion: async question => {
      const result = await connection.request(IPC_SIDE_QUESTION, { question }) as {
        response?: unknown
      }
      if (typeof result.response !== 'string') {
        throw new Error('The attached CLI returned an invalid side-question response.')
      }
      return result.response
    },
    respondPermission: (requestId, response) => {
      connection.notify(IPC_PERMISSION_DECISION, { requestId, response })
    },
    stopTask: async taskId => {
      await connection.request(IPC_TASK_STOP, { taskId })
    },
    sendTaskMessage: async (taskId, text) => {
      await connection.request(IPC_TASK_MESSAGE, { taskId, text })
    },
    // ── Task 14: Runtime action ───────────────────────────────────────────────
    sendRuntimeAction: async (action: RuntimeAction): Promise<RuntimeActionResponse> => {
      const requestId = randomUUID()
      const result = await connection.request(IPC_RUNTIME_ACTION, { requestId, action })
      return (result as RuntimeActionResponse) ?? { requestId, success: false, error: 'No response.' }
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
    case IPC_TASK_STATE_CHANGED: {
      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>
        if (record.version === 1 && Array.isArray(record.tasks)) {
          callbacks.onTaskSnapshot?.(record.tasks as BackgroundTaskView[])
        } else {
          callbacks.onTaskEvent?.(record)
        }
      }
      return
    }
    // ── Task 15: Runtime state change push notification ─────────────────────
    case IPC_RUNTIME_STATE_CHANGED: {
      if (
        callbacks.onRuntimeStateChanged &&
        payload &&
        typeof payload === 'object' &&
        (payload as { version?: unknown }).version === 1
      ) {
        callbacks.onRuntimeStateChanged(payload as RuntimeStateSnapshot)
      }
      return
    }
    default:
      // An unknown channel is skipped, never fatal. The CLI and the extension are
      // separately installable, so a newer CLI adding a channel must not break
      // attachment — the same version-tolerance rule the control client follows.
      return
  }
}

/**
 * Ask the attached CLI what it supports. `null` means the CLI predates capability
 * negotiation entirely — every `features` flag on this path is then treated as
 * `false` by the caller, since there is nothing to distinguish "doesn't support it"
 * from "doesn't know I asked".
 */
async function requestAttachedCapabilities(
  connection: IpcConnection,
): Promise<AttachedRuntimeCapabilities | null> {
  try {
    const response = await connection.request(IPC_CAPABILITIES, {})
    return isAttachedRuntimeCapabilities(response) ? response : null
  } catch {
    return null
  }
}

function isAttachedRuntimeCapabilities(value: unknown): value is AttachedRuntimeCapabilities {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.protocolVersion !== 'number') return false
  const features = record.features
  return Boolean(features) && typeof features === 'object'
}

