/**
 * Shared TaskState → wire-safe view projection.
 *
 * This is deliberately pure. Runtime handles, controllers, callbacks, credentials,
 * message objects and raw reasoning never cross the IPC/webview boundary.
 */
import type { TaskState } from '../../tasks/types.js'
import type {
  BackgroundTaskType,
  BackgroundTaskView,
  TaskActivityView,
} from './webviewProtocol.js'

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
    capabilities: {
      canStop: !terminal && task.status === 'running',
      canSendMessage: !terminal && (type === 'local_agent' || type === 'in_process_teammate'),
      hasTranscript: type === 'local_agent' || type === 'in_process_teammate',
      hasOutput: type === 'local_shell' || type === 'local_workflow' || type === 'monitor_mcp',
    },
  }
}

function normalizeType(value: string): BackgroundTaskType {
  if (value === 'local_bash') return 'local_shell'
  switch (value) {
    case 'local_agent':
    case 'in_process_teammate':
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

function groupFor(type: BackgroundTaskType): BackgroundTaskView['group'] {
  if (type === 'local_agent' || type === 'in_process_teammate') return 'agents'
  if (type === 'local_shell') return 'shells'
  if (type === 'local_workflow') return 'workflows'
  if (type === 'remote_agent' || type === 'external_agent') return 'remote'
  if (type === 'monitor_mcp') return 'monitors'
  return 'other'
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

function splitModel(value: string | undefined): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined]
  const separator = value.indexOf('/')
  return separator > 0
    ? [value.slice(0, separator), value.slice(separator + 1)]
    : [undefined, value]
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
