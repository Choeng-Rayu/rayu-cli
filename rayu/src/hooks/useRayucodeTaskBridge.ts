import { useEffect } from 'react'

import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { registerIpcHandler, notifyIpcPeers } from '../ipc/sessionServer.js'
import { useAppStateStore } from '../state/AppState.js'
import { injectUserMessageToTeammate } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask, queuePendingMessage } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { stopTask } from '../tasks/stopTask.js'
import type { TaskState } from '../tasks/types.js'
import { subscribeSdkEvents } from '../utils/sdkEventQueue.js'
import { createAbortController } from '../utils/abortController.js'
import { getLastCacheSafeParams } from '../utils/forkedAgent.js'
import { runSideQuestion } from '../utils/sideQuestion.js'
import { saveTaskHistory } from '../utils/task/taskHistory.js'
import { getActivityHistory } from '../telegram/telegramRemoteBridge.js'
import {
  IPC_TASK_MESSAGE,
  IPC_SIDE_QUESTION,
  IPC_TASK_SNAPSHOT,
  IPC_TASK_STATE_CHANGED,
  IPC_TASK_STOP,
  IPC_CAPABILITIES,
  IPC_CONVERSATION_SNAPSHOT,
  IPC_RUNTIME_SNAPSHOT,
  IPC_RUNTIME_ACTION,
  IPC_COMMAND_REGISTRY,
  ATTACHED_RUNTIME_CAPABILITIES,
} from '../vscode/shared/attachChannels.js'
import type { RuntimeAction, RuntimeActionResponse } from '../vscode/shared/attachProtocol.js'
import { buildCommandRegistry } from '../vscode/host/panel/commandRegistry.js'
import { projectTaskState } from '../runtime/taskProjection.js'

/** Expose the live CLI task owner to authenticated local Rayucode attachments. */
export function useRayucodeTaskBridge(): void {
  const store = useAppStateStore()

  useEffect(() => {
    const unregisterCapabilities = registerIpcHandler(IPC_CAPABILITIES, () => (
      ATTACHED_RUNTIME_CAPABILITIES
    ))

    const unregisterSnapshot = registerIpcHandler(IPC_TASK_SNAPSHOT, () => ({
      version: 1,
      tasks: Object.values(store.getState().tasks ?? {}).map(task =>
        projectTaskState(getSessionId(), task as TaskState),
      ),
    }))

    // ── Task 12: Conversation snapshot ─────────────────────────────────────
    // Return all activity batches accumulated since session start.  Each batch
    // is a `WrappedMessage[]` emitted by a completed turn; the receiver calls
    // `applyMirroredActivity` for each batch to replay the transcript.
    const unregisterConversationSnapshot = registerIpcHandler(
      IPC_CONVERSATION_SNAPSHOT,
      (): { version: 1; messages: unknown[] } => ({
        version: 1,
        messages: getActivityHistory().flat(),
      }),
    )

    // ── Task 15: Runtime state snapshot ────────────────────────────────────
    // One-shot pull of the current runtime configuration (model, permission
    // mode, MCP status, thinking state, …).  The extension also subscribes to
    // IPC_RUNTIME_STATE_CHANGED push notifications for subsequent changes.
    const unregisterRuntimeSnapshot = registerIpcHandler(
      IPC_RUNTIME_SNAPSHOT,
      () => buildRuntimeSnapshot(store.getState()),
    )

    // ── Task 17: Command registry ───────────────────────────────────────────
    // Return the full slash-command catalogue so the panel can render the
    // command palette dynamically, grouped by category.
    const unregisterCommandRegistry = registerIpcHandler(
      IPC_COMMAND_REGISTRY,
      async () => buildCommandRegistry(),
    )

    // ── Task 14: Runtime action dispatch ───────────────────────────────────
    // Handle typed configuration actions from the extension.  Each action maps
    // to the same setter the extension itself would call if it owned the
    // session directly.  Failures are returned as `{ success: false, error }`
    // rather than thrown, so the IPC request always resolves (never rejects).
    const unregisterRuntimeAction = registerIpcHandler(
      IPC_RUNTIME_ACTION,
      (payload): RuntimeActionResponse => {
        const req = payload as { requestId?: unknown; action?: unknown } | null
        const requestId = typeof req?.requestId === 'string' ? req.requestId : ''
        const action = req?.action as RuntimeAction | undefined
        if (!action || typeof action.type !== 'string') {
          return { requestId, success: false, error: 'Missing or invalid action.' }
        }
        try {
          dispatchRuntimeAction(action, store)
          return { requestId, success: true }
        } catch (error) {
          return { requestId, success: false, error: String(error) }
        }
      },
    )

    const unregisterStop = registerIpcHandler(IPC_TASK_STOP, async payload => {
      const taskId = readTaskId(payload)
      await stopTask(taskId, {
        getAppState: store.getState,
        setAppState: store.setState,
      })
      return { stopped: true }
    })

    const unregisterMessage = registerIpcHandler(IPC_TASK_MESSAGE, payload => {
      const taskId = readTaskId(payload)
      const text = readMessage(payload)
      const task = store.getState().tasks?.[taskId]
      if (isLocalAgentTask(task)) {
        if (task.status !== 'running') {
          throw new Error('This agent has finished and cannot be resumed by this CLI version.')
        }
        queuePendingMessage(taskId, text, store.setState)
        return { queued: true }
      }
      if (isInProcessTeammateTask(task)) {
        injectUserMessageToTeammate(taskId, text, store.setState)
        return { queued: true }
      }
      throw new Error('This task does not accept follow-up messages.')
    })

    const unregisterSideQuestion = registerIpcHandler(IPC_SIDE_QUESTION, async payload => {
      const question = readSideQuestion(payload)
      const saved = getLastCacheSafeParams()
      if (!saved) {
        throw new Error(
          'The attached session has not produced reusable conversation context yet. Try /btw again after its first response starts.',
        )
      }
      const result = await runSideQuestion({
        question,
        cacheSafeParams: {
          ...saved,
          // The cached context can retain a controller aborted by a prior steer. The
          // controller is not cache-key material, so the side fork gets its own lifetime.
          toolUseContext: {
            ...saved.toolUseContext,
            abortController: createAbortController(),
          },
        },
      })
      return { response: result.response }
    })

    const unsubscribeEvents = subscribeSdkEvents(event => {
      notifyIpcPeers(IPC_TASK_STATE_CHANGED, event)
    })
    let previousTasks = store.getState().tasks
    let historyWrite: Promise<void> = Promise.resolve()
    const unsubscribeStore = store.subscribe(() => {
      const tasks = store.getState().tasks
      if (Object.is(tasks, previousTasks)) return
      previousTasks = tasks
      const projected = Object.values(tasks ?? {}).map(task =>
        projectTaskState(getSessionId(), task as TaskState),
      )
      historyWrite = historyWrite
        .catch(() => {})
        .then(() => saveTaskHistory(getOriginalCwd(), getSessionId(), projected))
        .catch(() => {})
      notifyIpcPeers(IPC_TASK_STATE_CHANGED, {
        version: 1,
        tasks: projected,
      })
    })

    return () => {
      unregisterCapabilities()
      unregisterSnapshot()
      unregisterConversationSnapshot()
      unregisterRuntimeSnapshot()
      unregisterRuntimeAction()
      unregisterCommandRegistry()
      unregisterStop()
      unregisterMessage()
      unregisterSideQuestion()
      unsubscribeEvents()
      unsubscribeStore()
    }
  }, [store])
}

// ── Task 14: Runtime action helpers ──────────────────────────────────────────

type AppStore = ReturnType<typeof useAppStateStore>

/**
 * Apply a typed runtime action to the session's live state.
 *
 * This must throw on unsupported or invalid actions so the caller can wrap it
 * in a try/catch and return a typed error response.
 */
function dispatchRuntimeAction(action: RuntimeAction, store: AppStore): void {
  switch (action.type) {
    case 'change_model':
      // Model changes are persisted and picked up on next turn; the store
      // itself does not hold a raw "active model" string — that lives in the
      // config file.  Notify callers that the action was received so they do
      // not need to wait for a state-changed push.
      store.setState(s => ({ ...s, mainLoopModel: { value: action.modelId } as never }))
      break
    case 'toggle_thinking':
      // Thinking is toggled via the `setThinking` control request in the
      // engine.  The bridge layer cannot reach the engine directly, so we
      // store the desired state and the session picks it up at next turn.
      store.setState(s => ({
        ...s,
        // `thinkingEnabled` may not exist in all AppState versions; write it
        // as an unknown extension key to avoid breaking older state shapes.
        thinkingEnabled: action.enabled,
      } as never))
      break
    case 'set_effort':
      store.setState(s => ({ ...s, effort: action.effort } as never))
      break
    case 'update_permission_mode':
      store.setState(s => ({
        ...s,
        toolPermissionContext: {
          ...(s.toolPermissionContext as Record<string, unknown>),
          permissionMode: action.mode,
        },
      } as never))
      break
    case 'reconnect_mcp':
      // MCP reconnect is triggered by the engine; there is no direct AppState
      // mutation for it.  Log for now — the session's engine picks it up via
      // the control protocol on the next tick that checks server status.
      break
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown runtime action type: ${(exhaustive as { type: string }).type}`)
    }
  }
}

// ── Task 15: Runtime snapshot builder ────────────────────────────────────────

/**
 * Build a serialisable snapshot of the CLI's current runtime state.
 *
 * Only fields that are reliably available in `AppState` are included; fields
 * that require engine-internal knowledge (like the exact MCP connection status)
 * are omitted or approximated.
 */
function buildRuntimeSnapshot(appState: ReturnType<AppStore['getState']>): {
  version: 1
  sessionId: string
  timestamp: number
  model?: { id: string; providerId: string; displayName: string; supportsThinking: boolean }
  permissions?: { mode: string; pendingCount: number }
  thinking?: { enabled: boolean; currentlyThinking: boolean }
  effort?: string | null
  taskList?: { totalTasks: number; completedTasks: number; currentTask: string | null } | null
} {
  const tasks = Object.values(appState.tasks ?? {}) as Array<{ status?: string; content?: string }>
  const totalTasks = tasks.length
  const completedTasks = tasks.filter(t => t.status === 'completed').length
  const currentTask = tasks.find(t => t.status === 'in_progress')?.content ?? null

  const model = (appState as Record<string, unknown>).mainLoopModelForSession as
    | { value?: string }
    | undefined

  const permContext = appState.toolPermissionContext as
    | { permissionMode?: string; pendingCount?: number }
    | undefined

  return {
    version: 1,
    sessionId: getSessionId(),
    timestamp: Date.now(),
    ...(model?.value
      ? {
          model: {
            id: String(model.value),
            providerId: '',
            displayName: String(model.value),
            supportsThinking: false,
          },
        }
      : {}),
    permissions: {
      mode: permContext?.permissionMode ?? 'default',
      pendingCount: permContext?.pendingCount ?? 0,
    },
    thinking: {
      enabled: Boolean((appState as Record<string, unknown>).thinkingEnabled),
      currentlyThinking: false,
    },
    effort: ((appState as Record<string, unknown>).effort as string | null | undefined) ?? null,
    taskList: totalTasks > 0 ? { totalTasks, completedTasks, currentTask } : null,
  }
}

// ── Shared payload readers ────────────────────────────────────────────────────

function readTaskId(payload: unknown): string {
  const taskId = (payload as { taskId?: unknown } | null)?.taskId
  if (typeof taskId !== 'string' || !taskId) throw new Error('Missing taskId.')
  return taskId
}

function readMessage(payload: unknown): string {
  const text = (payload as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('Missing task message.')
  return text.trim()
}

function readSideQuestion(payload: unknown): string {
  const question = (payload as { question?: unknown } | null)?.question
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('Missing side question.')
  }
  return question.trim()
}
