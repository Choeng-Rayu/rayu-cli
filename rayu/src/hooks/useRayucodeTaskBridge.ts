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
import { saveTaskHistory } from '../utils/task/taskHistory.js'
import {
  IPC_TASK_MESSAGE,
  IPC_TASK_SNAPSHOT,
  IPC_TASK_STATE_CHANGED,
  IPC_TASK_STOP,
} from '../vscode/shared/attachChannels.js'
import { projectTaskState } from '../vscode/shared/taskProjection.js'

/** Expose the live CLI task owner to authenticated local Rayucode attachments. */
export function useRayucodeTaskBridge(): void {
  const store = useAppStateStore()

  useEffect(() => {
    const unregisterSnapshot = registerIpcHandler(IPC_TASK_SNAPSHOT, () => ({
      version: 1,
      tasks: Object.values(store.getState().tasks ?? {}).map(task =>
        projectTaskState(getSessionId(), task as TaskState),
      ),
    }))

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
      unregisterSnapshot()
      unregisterStop()
      unregisterMessage()
      unsubscribeEvents()
      unsubscribeStore()
    }
  }, [store])
}

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
