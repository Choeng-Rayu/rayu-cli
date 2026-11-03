/**
 * Pure translation from `codex app-server` notifications to normalized events.
 *
 * No I/O, no publishing, no state. That is what lets Task 19 drive it from
 * recorded wire fixtures and assert exact output, and it keeps every ordering
 * decision in the adapter that owns the connection.
 *
 * Unknown methods and unknown item variants return `[]`. Codex adds both between
 * releases, and an adapter that threw on an unrecognized notification would
 * break on a Codex upgrade — the failure mode is a dead agent mid-task, so
 * degrading is the only acceptable behaviour.
 *
 * `warning` and `configWarning` also return `[]`. They are diagnostics, not
 * agent output: routing them through `agent_error` would interrupt RAYU's model
 * for a config note. The adapter logs them instead.
 */

import type { EventPayload } from '../../core/normalizer.js'
import type { TurnKind } from '../../core/types.js'
import {
  CODEX_EVENT,
  codexErrorTag,
  type CodexItem,
  type CodexThreadStatus,
  type CodexTurn,
} from './protocol.js'

/**
 * `codexErrorInfo` tags that mean the upstream model provider failed, not the
 * agent or the request.
 *
 * The distinction drives task state: a provider fault becomes
 * `waiting-provider` (task alive, user can wait or switch), while an agent fault
 * becomes a real failure. Treating a rate limit as a task failure would discard
 * recoverable work.
 */
const PROVIDER_FAULT_TAGS = new Set([
  'rateLimitExceeded',
  'UsageLimitExceeded',
  'SessionBudgetExceeded',
  'HttpConnectionFailed',
  'ResponseStreamConnectionFailed',
  'ResponseStreamDisconnected',
  'ResponseTooManyFailedAttempts',
  'InternalServerError',
])

/** True when this error should leave the task alive as `waiting-provider`. */
export function isProviderFault(codexErrorInfo: unknown): boolean {
  const tag = codexErrorTag(codexErrorInfo)
  return tag !== undefined && PROVIDER_FAULT_TAGS.has(tag)
}

/**
 * Turn kind implied by an item, for admission control.
 *
 * Codex rejects `turn/steer` on review and compaction turns, so the adapter has
 * to know which kind is running. It learns that from the items Codex emits
 * rather than from a dedicated field, because the protocol does not expose one.
 */
export function inferTurnKind(item: CodexItem): TurnKind | undefined {
  switch (item.type) {
    case 'enteredReviewMode':
      return 'review'
    case 'exitedReviewMode':
      return 'regular'
    case 'contextCompaction':
    case 'compacted':
      return 'compaction'
    case 'commandExecution':
      // A user-initiated `!` shell command runs as its own turn kind.
      return item.source === 'userShell' ? 'shell' : undefined
    default:
      return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Render a plan array as readable lines. */
function renderPlan(params: Record<string, unknown>): string {
  const steps = Array.isArray(params.plan) ? params.plan : []
  const lines = steps.map(entry => {
    const step = asRecord(entry)
    const marker =
      step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '>' : ' '
    return `  [${marker}] ${text(step.step)}`
  })
  const explanation = text(params.explanation)
  return [explanation ? `Plan: ${explanation}` : 'Plan:', ...lines].join('\n')
}

/** Events for an item entering the transcript. */
function fromItemStarted(item: CodexItem): EventPayload[] {
  const callId = item.id ?? 'unknown'
  switch (item.type) {
    case 'commandExecution':
      return [
        {
          type: 'tool_started',
          callId,
          toolName: 'shell',
          // `command` is a redacted display value in Codex's own words — safe
          // to surface, and never re-executed by RAYU.
          summary: item.command ? String(item.command) : undefined,
        },
      ]
    case 'mcpToolCall':
      return [
        {
          type: 'tool_started',
          callId,
          toolName: `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`,
        },
      ]
    case 'webSearch':
      return [{ type: 'tool_started', callId, toolName: 'web_search' }]
    case 'imageGeneration':
      return [{ type: 'tool_started', callId, toolName: 'image_generation' }]
    case 'fileChange':
      return fileChangeEvents(item)
    default:
      return []
  }
}

/** Events for an item reaching its final state. */
function fromItemCompleted(item: CodexItem): EventPayload[] {
  switch (item.type) {
    case 'agentMessage':
      // Non-delta: the accumulated final text. Deltas already streamed, so this
      // is emitted only when there were none (short replies arrive whole).
      return item.text
        ? [{ type: 'agent_message', text: String(item.text), delta: false }]
        : []
    case 'fileChange':
      return fileChangeEvents(item)
    case 'commandExecution': {
      const failed = item.status === 'failed'
      return failed
        ? [
            {
              type: 'agent_error',
              message: `shell command failed${item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ''}`,
              providerFault: false,
            },
          ]
        : []
    }
    case 'exitedReviewMode':
      return item.review
        ? [{ type: 'agent_message', text: String(item.review), delta: false }]
        : []
    default:
      return []
  }
}

function fileChangeEvents(item: CodexItem): EventPayload[] {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return changes.map(change => ({
    type: 'file_changed' as const,
    path: String(change.path),
    change: mapChangeKind(change.kind),
    diff: change.diff ? String(change.diff) : undefined,
  }))
}

function mapChangeKind(
  kind: unknown,
): 'created' | 'modified' | 'deleted' | 'renamed' {
  switch (kind) {
    case 'add':
    case 'added':
    case 'create':
      return 'created'
    case 'delete':
    case 'deleted':
      return 'deleted'
    case 'rename':
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

function fromTurnCompleted(turn: CodexTurn): EventPayload[] {
  switch (turn.status) {
    case 'completed':
      return [{ type: 'task_completed' }, { type: 'agent_idle' }]
    case 'interrupted':
      // Not a failure — the user asked for it. Idle so queued work can drain.
      return [{ type: 'agent_idle' }]
    case 'failed': {
      const error = turn.error
      const providerFault = isProviderFault(error?.codexErrorInfo)
      const message = error?.message ?? 'turn failed'
      return providerFault
        ? [{ type: 'agent_error', message, providerFault: true }]
        : [
            {
              type: 'task_failed',
              message,
              code: codexErrorTag(error?.codexErrorInfo),
            },
            { type: 'agent_idle' },
          ]
    }
    default:
      return []
  }
}

function fromThreadStatus(status: CodexThreadStatus): EventPayload[] {
  switch (status.type) {
    case 'idle':
      return [{ type: 'agent_idle' }]
    case 'systemError':
      return [
        {
          type: 'agent_error',
          message: 'Codex reported a system error for this thread.',
          providerFault: false,
        },
      ]
    default:
      // `active` and `notLoaded` are tracked by the adapter's own state, not
      // surfaced as events — emitting them would add noise with no action.
      return []
  }
}

/**
 * Translate one Codex notification.
 *
 * @returns events in publish order; `[]` for anything not modelled.
 */
export function normalizeCodexNotification(
  method: string,
  rawParams: unknown,
): EventPayload[] {
  const params = asRecord(rawParams)

  switch (method) {
    case CODEX_EVENT.agentMessageDelta:
      return [
        { type: 'agent_message', text: text(params.delta), delta: true },
      ]

    case CODEX_EVENT.reasoningSummaryDelta:
    case CODEX_EVENT.reasoningTextDelta:
      return [
        {
          type: 'agent_thinking',
          text: text(params.delta),
          delta: true,
        },
      ]

    case CODEX_EVENT.commandOutputDelta:
      return [
        {
          type: 'tool_output',
          callId: text(params.itemId) || 'unknown',
          chunk: text(params.delta) || text(params.chunk),
          stream: params.stream === 'stderr' ? 'stderr' : 'stdout',
        },
      ]

    case CODEX_EVENT.itemStarted:
      return fromItemStarted(asRecord(params.item) as CodexItem)

    case CODEX_EVENT.itemCompleted:
      return fromItemCompleted(asRecord(params.item) as CodexItem)

    case CODEX_EVENT.fileChangePatchUpdated:
      return fileChangeEvents(asRecord(params.item ?? params) as CodexItem)

    case CODEX_EVENT.turnCompleted:
      return fromTurnCompleted(asRecord(params.turn) as CodexTurn)

    case CODEX_EVENT.turnPlanUpdated:
      return [{ type: 'agent_message', text: renderPlan(params), delta: false }]

    case CODEX_EVENT.threadStatusChanged:
      return fromThreadStatus(asRecord(params.status) as CodexThreadStatus)

    case CODEX_EVENT.threadClosed:
      return [
        {
          type: 'agent_disconnected',
          reason: 'shutdown',
        },
      ]

    case CODEX_EVENT.error: {
      const error = asRecord(params.error)
      const providerFault = isProviderFault(error.codexErrorInfo)
      return [
        {
          type: 'agent_error',
          message: text(error.message) || 'Codex reported an error',
          code: codexErrorTag(error.codexErrorInfo),
          providerFault,
        },
      ]
    }

    // Modelled deliberately as no-ops:
    //   turnStarted / threadStarted — adapter state, not user-visible events
    //   turnDiffUpdated — aggregate of file_changed we already emitted
    //   warning / configWarning — diagnostics; adapter logs them
    //   serverRequestResolved — approval bookkeeping, handled by the broker
    case CODEX_EVENT.turnStarted:
    case CODEX_EVENT.threadStarted:
    case CODEX_EVENT.turnDiffUpdated:
    case CODEX_EVENT.warning:
    case CODEX_EVENT.configWarning:
    case CODEX_EVENT.serverRequestResolved:
      return []

    default:
      return []
  }
}

/** Normalize a server-initiated approval request into a permission event. */
export function normalizeApprovalRequest(
  method: string,
  rawParams: unknown,
  requestId: string,
): EventPayload[] {
  const params = asRecord(rawParams)
  const isFileChange = method.includes('fileChange')
  const description = isFileChange
    ? `apply file changes${params.grantRoot ? ` under ${String(params.grantRoot)}` : ''}`
    : `run: ${text(params.command) || 'a shell command'}`
  return [
    {
      type: 'permission_requested',
      requestId,
      kind: isFileChange ? 'file_change' : 'command',
      description: text(params.reason) ? `${description} — ${text(params.reason)}` : description,
      cwd: text(params.cwd) || undefined,
    },
  ]
}
