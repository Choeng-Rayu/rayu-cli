/**
 * Shared TaskState -> wire-safe view projection.
 *
 * The TUI, SDK, Rayucode, and attached-session IPC all consume the same task
 * lifecycle. Runtime handles, callbacks, credentials, message objects and raw
 * reasoning are intentionally not part of the returned value.
 */
import type { TaskState } from '../tasks/types.js'
import { decodeModelProvider } from '../utils/rayuConfig.js'
import type {
  BackgroundTaskType,
  BackgroundTaskView,
  TaskActivityView,
} from './taskTypes.js'

/**
 * `type`/`group`/`capabilities` derivation shared between the one-shot snapshot
 * projector below and `sessionHandle.ts`'s incremental, event-by-event task-lifecycle
 * accumulator. Both consume the same wire vocabulary (`BackgroundTaskType`) and must
 * agree on what a type IS and what it can DO — a fork here previously let one path
 * claim `canSendMessage: true` for local agents while the other always said `false`,
 * which would have surfaced as a control that worked or silently vanished depending on
 * which code path last wrote the row.
 */
export function normalizeType(value: string | undefined): BackgroundTaskType {
  if (value === 'local_bash') return 'local_shell'
  switch (value) {
    case 'local_agent':
    case 'in_process_teammate':
    case 'local_shell':
    case 'remote_agent':
    case 'external_agent':
    case 'local_workflow':
    case 'monitor_mcp':
    case 'dream':
      return value
    default:
      return 'unknown'
  }
}

export function groupFor(type: BackgroundTaskType): BackgroundTaskView['group'] {
  switch (type) {
    case 'local_agent':
    case 'in_process_teammate':
      return 'agents'
    case 'local_shell':
      return 'shells'
    case 'local_workflow':
      return 'workflows'
    case 'remote_agent':
    case 'external_agent':
      return 'remote'
    case 'monitor_mcp':
      return 'monitors'
    default:
      return 'other'
  }
}

/**
 * `canSendMessage` is deliberately always `false`. Routing a follow-up message to a
 * running task requires the execution owner's live task store, which the standalone
 * engine does not expose yet — rendering a control based on `type` alone would offer an
 * action that silently does nothing. Flip this once that operation actually exists.
 */
export function taskCapabilities(
  type: BackgroundTaskType,
  running: boolean,
): BackgroundTaskView['capabilities'] {
  const agent = type === 'local_agent' || type === 'in_process_teammate'
  return {
    canStop: running,
    canSendMessage: false,
    hasTranscript: agent,
    hasOutput: type === 'local_shell' || type === 'monitor_mcp' || type === 'local_workflow',
  }
}

export function projectTaskState(
  sourceSessionId: string,
  task: TaskState,
): BackgroundTaskView {
  const record = task as unknown as Record<string, unknown>
  const rawType = String(task.type)
  const type = normalizeType(rawType)
  const progress = objectValue(record.progress)
  const identity = objectValue(record.identity)
  const recent = Array.isArray(progress?.recentActivities)
    ? progress.recentActivities.slice(-8).flatMap((item, index) => {
        const activity = objectValue(item)
        if (!activity) return []
        const toolName = stringValue(activity.toolName)
        const label = stringValue(activity.activityDescription) ?? toolName
        if (!label) return []
        return [{
          id: `${sourceSessionId}:${task.id}:activity:${index}:${label}`,
          label,
          toolName,
          timestamp: task.endTime ?? Date.now(),
          kind: activity.isSearch === true
            ? 'search'
            : activity.isRead === true
              ? 'read'
              : 'tool',
        } satisfies TaskActivityView]
      })
    : []
  const modelValue = stringValue(record.model)
  const [provider, model] = splitModel(modelValue)
  const waiting = record.awaitingPlanApproval === true || record.isIdle === true
  const status = waiting && task.status === 'running'
    ? 'waiting'
    : task.status === 'killed'
      ? 'stopped'
      : task.status
  const summary = stringValue(progress?.summary)
  const last = objectValue(progress?.lastActivity)
  const currentActivity = record.awaitingPlanApproval === true
    ? 'Awaiting approval'
    : record.isIdle === true
      ? 'Waiting for a message'
      : summary ?? stringValue(last?.activityDescription) ?? stringValue(last?.toolName)
  const terminal = status === 'completed' || status === 'failed' || status === 'stopped'

  return {
    key: `${sourceSessionId}:${task.id}`,
    taskId: task.id,
    sourceSessionId,
    type,
    rawType: type === 'unknown' ? rawType : undefined,
    group: groupFor(type),
    description: task.description,
    prompt: stringValue(record.prompt),
    agentId: stringValue(identity?.agentId) ?? stringValue(record.agentId),
    agentName: stringValue(identity?.agentName),
    status,
    executionMode: record.isBackgrounded === false ? 'foreground' : 'background',
    startedAt: task.startTime,
    updatedAt: task.endTime ?? Date.now(),
    currentActivity: currentActivity ?? (terminal ? status : task.description),
    recentActivities: recent,
    model,
    provider,
    tokenCount: numberValue(progress?.tokenCount),
    toolCount: numberValue(progress?.toolUseCount),
    result: safeResult(record.result),
    error: stringValue(record.error),
    unread: terminal && task.notified !== true,
    // `taskCapabilities`'s `hasTranscript`/`hasOutput`/`canSendMessage` policy is shared
    // with the incremental accumulator; `canStop` is passed explicitly because this
    // path's original stop rule (running only, not waiting-on-approval) predates the
    // shared helper and changing it is a UI behavior change, not a projection cleanup.
    capabilities: {
      ...taskCapabilities(type, task.status === 'running'),
      canStop: !terminal && task.status === 'running',
    },
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Split a task's model into `[provider, model]` for display.
 *
 * ── THE PROVIDER ENCODING IS DELEGATED, NOT RE-IMPLEMENTED ─────────────────────
 *
 * A subagent routed to a provider other than the active one carries its model
 * ENCODED as `providerId\u0000model`, via `encodeModelWithProvider`. That format is
 * owned by `decodeModelProvider`, which is what this calls — so the decode cannot
 * drift from the encode, and the separator constant is never restated here.
 *
 * It must be checked BEFORE the slash form: an encoded value contains no slash, so
 * a slash-first split would leave the whole encoded string — NUL and all — as the
 * model, and that is what the panel would render next to the provider.
 *
 * A plain `provider/model` string is still accepted afterwards, because that is what
 * an already-decoded or hand-written value looks like.
 */
function splitModel(value: string | undefined): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined]
  const decoded = decodeModelProvider(value)
  if (decoded.providerId) return [decoded.providerId, decoded.model]
  const separator = decoded.model.indexOf('/')
  return separator > 0
    ? [decoded.model.slice(0, separator), decoded.model.slice(separator + 1)]
    : [undefined, decoded.model]
}

function safeResult(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 8_000)
  const record = objectValue(value)
  if (!record) return undefined
  for (const key of ['summary', 'result', 'content', 'text']) {
    const candidate = stringValue(record[key])
    if (candidate) return candidate.slice(0, 8_000)
  }
  return undefined
}
