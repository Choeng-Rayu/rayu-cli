/**
 * Fan normalized events out into the sinks RAYU already has.
 *
 * Deliberately additive: this file writes *into* `AppState`, the message queue,
 * the SDK queue and `TaskOutput`. It does not introduce a parallel notification
 * path, because anything that bypassed those would be invisible to `/status`,
 * the background-task indicator, `TaskOutputTool` and SDK consumers.
 *
 * Five sinks, wired by `installEventSinks`:
 *
 *   1. **Disk log** — every event, for crash forensics (`eventLog.ts`).
 *   2. **TaskOutput** — human-readable text via `appendTaskOutput`, so
 *      `<output-file>` in a notification points at real content and the
 *      existing `getTaskOutputDelta` / `outputOffset` machinery works unchanged.
 *   3. **AppState** — keeps the `ExternalAgentTaskState` current for the UI.
 *   4. **Model queue** — `enqueuePendingNotification`, *selectively* (below).
 *   5. **SDK queue** — `enqueueSdkEvent`, mapped onto its existing variants.
 *
 * ## Why the model sink is selective
 *
 * A streaming agent emits token deltas continuously. Enqueuing each one as a
 * `<task-notification>` would flood the model's queue and burn its context on
 * text it can already read from the output file on demand. So deltas go to the
 * UI, the log and `TaskOutput` only; the model is notified on events it must
 * actually *act* on — completion, failure, disconnect, permission requests and
 * errors. `shouldNotifyModel` is the single place that decision lives.
 *
 * ## Two protocol details that are easy to get wrong
 *
 *   - A `<status>` tag is a **terminal** signal to `src/cli/print.ts`; an
 *     unrecognized value falls through to `completed` and falsely closes the
 *     task for SDK consumers. Progress notifications are therefore emitted
 *     **without** a `<status>` tag, matching the stall-watchdog note in
 *     `LocalShellTask.tsx`.
 *   - `SdkEvent` is a closed union. This file maps onto its existing
 *     `task_progress` / `task_notification` variants rather than adding a
 *     variant, which would change a shared type every SDK consumer parses.
 */

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
} from '../../constants/xml.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { SetAppState } from '../../Task.js'
import { isExternalAgentTask } from '../../tasks/ExternalAgentTask/guards.js'
import type { ExternalAgentTaskState } from '../../tasks/ExternalAgentTask/guards.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import { appendTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'
import { appendEvent } from './eventLog.js'
import { subscribeToEvents } from './eventBus.js'
import {
  type ExternalAgentEvent,
  isTerminalEventType,
  type ExternalTaskState,
} from './types.js'

/** Prefix identifying an external-agent summary to the UI collapse transform. */
export const EXTERNAL_AGENT_SUMMARY_PREFIX = 'External agent '

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Human-readable line for the task output file, or null when the event carries
 * no text worth persisting (pure state transitions).
 *
 * Tool output is passed through verbatim; everything else is labelled so a
 * reader can tell agent prose from tool stdout from a file edit.
 */
export function renderEventForOutput(event: ExternalAgentEvent): string | null {
  switch (event.type) {
    case 'agent_message':
      return event.text
    case 'agent_thinking':
      return event.delta ? null : `[thinking] ${event.text}\n`
    case 'tool_started':
      return `\n[tool] ${event.toolName}${event.summary ? `: ${event.summary}` : ''}\n`
    case 'tool_output':
      return event.chunk
    case 'file_changed':
      return `[file ${event.change}] ${event.path}\n`
    case 'permission_requested':
      return `\n[permission] ${event.description}\n`
    case 'task_failed':
      return `\n[failed] ${event.message}\n`
    case 'agent_error':
      return `\n[error] ${event.message}\n`
    case 'agent_disconnected':
      return `\n[disconnected] ${event.reason}\n`
    case 'task_completed':
      return event.summary ? `\n[completed] ${event.summary}\n` : '\n[completed]\n'
    case 'agent_started':
    case 'agent_idle':
      return null
  }
}

/** One-line summary for notifications and the UI. */
function summarize(event: ExternalAgentEvent): string {
  switch (event.type) {
    case 'task_completed':
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} completed its task${event.summary ? `: ${event.summary}` : ''}`
    case 'task_failed':
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} failed: ${event.message}`
    case 'agent_disconnected':
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} disconnected (${event.reason})`
    case 'permission_requested':
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} is waiting for permission: ${event.description}`
    case 'agent_error':
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} reported an error: ${event.message}`
    default:
      return `${EXTERNAL_AGENT_SUMMARY_PREFIX}${event.agentId} — ${event.type}`
  }
}

/**
 * Terminal status for the `<status>` tag, or null when the event is progress.
 *
 * Returning null is the signal to omit the tag entirely — see the header note
 * about `print.ts` treating any `<status>` as terminal.
 */
function terminalStatus(
  event: ExternalAgentEvent,
): 'completed' | 'failed' | 'killed' | null {
  switch (event.type) {
    case 'task_completed':
      return 'completed'
    case 'task_failed':
      return 'failed'
    case 'agent_disconnected':
      return event.reason === 'shutdown' ? 'killed' : 'failed'
    default:
      return null
  }
}

/**
 * Whether this event warrants interrupting the model.
 *
 * See "Why the model sink is selective". Streaming text is excluded on purpose:
 * it is available in the output file, and enqueuing it would consume context
 * the model did not ask for.
 */
export function shouldNotifyModel(event: ExternalAgentEvent): boolean {
  return (
    isTerminalEventType(event.type) ||
    event.type === 'permission_requested' ||
    event.type === 'agent_error'
  )
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

function notifyModel(event: ExternalAgentEvent): void {
  if (!event.taskRef) return
  const status = terminalStatus(event)
  const statusLine = status ? `\n<${STATUS_TAG}>${status}</${STATUS_TAG}>` : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${event.taskRef}</${TASK_ID_TAG}>
<${TASK_TYPE_TAG}>external_agent</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(event.taskRef)}</${OUTPUT_FILE_TAG}>${statusLine}
<${SUMMARY_TAG}>${escapeXml(summarize(event))}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  // Permission requests and errors block progress, so they jump the queue.
  // Completions follow the background-command convention of 'later' so they
  // never preempt a user's own prompt.
  const priority =
    event.type === 'permission_requested' || event.type === 'agent_error'
      ? 'next'
      : 'later'

  enqueuePendingNotification({ value: message, mode: 'task-notification', priority })
}

function notifySdk(event: ExternalAgentEvent): void {
  if (!event.taskRef) return
  const status = terminalStatus(event)
  if (status) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_notification',
      task_id: event.taskRef,
      status: status === 'killed' ? 'stopped' : status,
      output_file: getTaskOutputPath(event.taskRef),
      summary: summarize(event),
    })
    return
  }
  if (event.type !== 'tool_started' && event.type !== 'file_changed') return
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: event.taskRef,
    description: summarize(event),
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    last_tool_name: event.type === 'tool_started' ? event.toolName : undefined,
  })
}

/** Map an event onto the external task's state, or null to leave it unchanged. */
function nextTaskState(
  event: ExternalAgentEvent,
): ExternalTaskState | null {
  switch (event.type) {
    case 'task_completed':
      return 'completed'
    case 'task_failed':
      return 'failed'
    case 'agent_disconnected':
      return 'failed'
    case 'agent_error':
      // A provider outage leaves the task alive but stalled — a distinct state
      // from failure, and the one the user can act on by waiting or switching.
      return event.providerFault ? 'waiting-provider' : null
    case 'agent_message':
    case 'tool_started':
    case 'tool_output':
      return 'running'
    default:
      return null
  }
}

function updateAppState(
  event: ExternalAgentEvent,
  setAppState: SetAppState,
): void {
  const taskRef = event.taskRef
  if (!taskRef) return
  updateTaskState<ExternalAgentTaskState>(taskRef, setAppState, task => {
    if (!isExternalAgentTask(task)) return task
    const externalState = nextTaskState(event) ?? task.externalState
    const changedFiles =
      event.type === 'file_changed' && !task.changedFiles.includes(event.path)
        ? [...task.changedFiles, event.path]
        : task.changedFiles
    const patch: Partial<ExternalAgentTaskState> = {}
    if (event.type === 'task_completed' && event.summary !== undefined) {
      patch.resultSummary = event.summary
    }
    if (event.type === 'task_failed') {
      patch.errorMessage = event.message
    }
    if (event.turnId !== undefined) {
      patch.activeTurnId = event.turnId
    }
    if (isTerminalEventType(event.type)) {
      patch.activeTurnId = undefined
      patch.endTime = Date.now()
    }
    if (
      externalState === task.externalState &&
      changedFiles === task.changedFiles &&
      Object.keys(patch).length === 0
    ) {
      // Returning the same reference makes updateTaskState skip the spread, so
      // AppState subscribers do not re-render on a no-op.
      return task
    }
    return { ...task, ...patch, externalState, changedFiles }
  })

  // Background task state changed, so any speculated response may reference
  // stale output. Mirrors enqueueShellNotification in LocalShellTask.
  if (isTerminalEventType(event.type)) {
    abortSpeculation(setAppState)
  }
}

function logSink(event: ExternalAgentEvent): void {
  void appendEvent(event)
}

function taskOutputSink(event: ExternalAgentEvent): void {
  const text = renderEventForOutput(event)
  if (text !== null && event.taskRef) {
    appendTaskOutput(event.taskRef, text)
  }
}

function modelSink(event: ExternalAgentEvent): void {
  if (shouldNotifyModel(event)) {
    notifyModel(event)
  }
}

/**
 * Wire every sink to the bus, each as its own independent subscriber.
 *
 * The separation is load-bearing, not stylistic. `publishEvent` isolates a
 * throwing subscriber *per listener*; if all five sinks shared one listener, a
 * failure in an early sink would silently skip every later one. That is not
 * hypothetical — during development, `abortSpeculation` throwing on an
 * unexpected `AppState` shape swallowed the completion notification to the model
 * and the SDK, so tasks appeared to hang with no error anywhere.
 *
 * Order matters too: the disk log is registered first so an event is recorded
 * for crash forensics before any sink that could fail gets a chance to run.
 *
 * @returns uninstall function. Call on session teardown.
 */
export function installEventSinks(setAppState: SetAppState): () => void {
  logForDebugging('[eventSinks] installing external-agent event sinks')
  const unsubscribes = [
    subscribeToEvents(logSink),
    subscribeToEvents(taskOutputSink),
    subscribeToEvents(event => updateAppState(event, setAppState)),
    subscribeToEvents(modelSink),
    subscribeToEvents(notifySdk),
  ]
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}
