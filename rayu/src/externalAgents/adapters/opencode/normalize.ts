/**
 * Translation from OpenCode bus events to normalized events.
 *
 * ## Why this normalizer needs state
 *
 * The other two adapters receive *increments*: Codex sends
 * `item/agentMessage/delta`, Claude Code sends whole finished blocks. OpenCode
 * sends **cumulative snapshots** — every `message.part.updated` carries the part's
 * full text so far. Emitting each snapshot as a message would render
 * `H`, `He`, `Hel`, … into the transcript.
 *
 * So delta computation is unavoidable, and it needs memory. Rather than hide that
 * in the adapter, it lives in an explicit `OpenCodeStreamState` object passed in
 * by the caller: `normalizeOpenCodeEvent` stays a deterministic function of
 * (event, state), which is what keeps it drivable from recorded fixtures — a test
 * constructs a fresh state and replays a captured stream.
 *
 * The state also suppresses duplicate `tool_started` events, since a tool part is
 * re-sent on every status change (`pending` → `running` → `completed`).
 */

import type { EventPayload } from '../../core/normalizer.js'

/**
 * Per-stream memory for turning cumulative snapshots into increments.
 *
 * Deterministic and I/O-free — the only reason it is an object rather than a pure
 * function is that OpenCode's protocol is snapshot-based.
 */
export type OpenCodeStreamState = {
  /** Newly-appended text for a part, or `''` when nothing changed. */
  textDelta(partId: string, fullText: string): string
  /** True exactly once per part, so `tool_started` is not repeated. */
  announceTool(partId: string): boolean
  /** True exactly once per (part, status) pair. */
  announceToolStatus(partId: string, status: string): boolean
  /** True exactly once per path, so a file is not reported repeatedly. */
  announceFile(path: string, change: string): boolean
  reset(): void
}

export function createOpenCodeStreamState(): OpenCodeStreamState {
  const text = new Map<string, string>()
  const announcedTools = new Set<string>()
  const announcedStatuses = new Set<string>()
  const announcedFiles = new Set<string>()

  return {
    textDelta(partId, fullText): string {
      const previous = text.get(partId) ?? ''
      text.set(partId, fullText)
      if (fullText === previous) return ''
      // Normal case: the snapshot extends what we already emitted.
      if (fullText.startsWith(previous)) return fullText.slice(previous.length)
      // The part was rewritten rather than extended (a retry or edit). Emitting
      // the whole new text is the only correct choice — a diff would be
      // meaningless mid-stream, and emitting nothing would lose the content.
      return fullText
    },

    announceTool(partId): boolean {
      if (announcedTools.has(partId)) return false
      announcedTools.add(partId)
      return true
    },

    announceToolStatus(partId, status): boolean {
      const key = `${partId}\u0000${status}`
      if (announcedStatuses.has(key)) return false
      announcedStatuses.add(key)
      return true
    },

    announceFile(path, change): boolean {
      const key = `${path}\u0000${change}`
      if (announcedFiles.has(key)) return false
      announcedFiles.add(key)
      return true
    },

    reset(): void {
      text.clear()
      announcedTools.clear()
      announcedStatuses.clear()
      announcedFiles.clear()
    },
  }
}

/** Event names RAYU models. Anything else normalizes to `[]`. */
export const OPENCODE_EVENT = {
  serverConnected: 'server.connected',
  messagePartUpdated: 'message.part.updated',
  messageUpdated: 'message.updated',
  messageRemoved: 'message.removed',
  sessionUpdated: 'session.updated',
  sessionIdle: 'session.idle',
  sessionError: 'session.error',
  sessionDeleted: 'session.deleted',
  permissionUpdated: 'permission.updated',
  permissionReplied: 'permission.replied',
  fileEdited: 'file.edited',
} as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Split an event into its discriminator and payload.
 *
 * OpenCode wraps bus events as `{ type, properties }`. Tolerates a flat shape so
 * an envelope change degrades to "unmodelled" rather than crashing the stream.
 */
export function readEventEnvelope(raw: unknown): {
  type: string
  properties: Record<string, unknown>
} {
  const event = asRecord(raw)
  return {
    type: str(event.type),
    properties: asRecord(event.properties ?? event),
  }
}

/**
 * Error text from a session/message error payload.
 *
 * OpenCode nests error data differently across events, so every documented
 * shape is checked before falling back to a generic message — an empty error
 * string in the UI is worse than a vague one.
 */
function readErrorMessage(properties: Record<string, unknown>): string {
  const error = asRecord(properties.error)
  return (
    str(error.message) ||
    str(asRecord(error.data).message) ||
    str(properties.message) ||
    str(error.name) ||
    'OpenCode reported an error'
  )
}

/**
 * Error names that mean the upstream model provider failed.
 *
 * Same distinction as the other adapters: a provider fault leaves the task alive
 * as `waiting-provider`, while an agent fault is a real failure.
 */
const PROVIDER_FAULT_NAMES = new Set([
  'ProviderAuthError',
  'ProviderRateLimitError',
  'ProviderOverloadedError',
  'APICallError',
])

function isProviderFaultError(properties: Record<string, unknown>): boolean {
  const error = asRecord(properties.error)
  const name = str(error.name)
  return PROVIDER_FAULT_NAMES.has(name)
}

function mapFileChange(
  action: string,
): 'created' | 'modified' | 'deleted' | 'renamed' {
  switch (action) {
    case 'add':
    case 'added':
    case 'create':
    case 'created':
      return 'created'
    case 'delete':
    case 'deleted':
    case 'remove':
      return 'deleted'
    case 'rename':
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

/** Events for a `tool` part, deduplicated by the stream state. */
function fromToolPart(
  partId: string,
  part: Record<string, unknown>,
  state: OpenCodeStreamState,
): EventPayload[] {
  const events: EventPayload[] = []
  const toolName = str(part.tool) || 'tool'
  const toolState = asRecord(part.state)
  const status = str(toolState.status)

  if (state.announceTool(partId)) {
    const input = asRecord(toolState.input)
    events.push({
      type: 'tool_started',
      callId: partId,
      toolName,
      summary:
        str(toolState.title) ||
        str(input.command) ||
        str(input.filePath) ||
        str(input.pattern) ||
        undefined,
    })
  }

  // Output arrives once the call settles. Gated on the (part, status) pair so a
  // repeated snapshot of a completed tool does not duplicate its output.
  const output = str(toolState.output)
  if (
    output &&
    (status === 'completed' || status === 'error') &&
    state.announceToolStatus(partId, status)
  ) {
    events.push({
      type: 'tool_output',
      callId: partId,
      chunk: output,
      stream: status === 'error' ? 'stderr' : 'stdout',
    })
  }

  // An OpenCode edit tool reports its target in the tool input, which is the
  // only signal available for workspace conflict tracking.
  if (status === 'completed') {
    const input = asRecord(toolState.input)
    const path = str(input.filePath) || str(input.path)
    if (path && isFileWritingTool(toolName) && state.announceFile(path, 'modified')) {
      events.push({ type: 'file_changed', path, change: 'modified' })
    }
  }

  return events
}

/**
 * OpenCode tools that mutate files.
 *
 * A narrow allowlist rather than a guess: a false positive would make the
 * Workspace Manager report a conflict on a file nobody wrote.
 */
function isFileWritingTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase()
  return (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized === 'patch' ||
    normalized === 'multiedit'
  )
}

function fromPartUpdated(
  properties: Record<string, unknown>,
  state: OpenCodeStreamState,
): EventPayload[] {
  const part = asRecord(properties.part)
  const partId = str(part.id) || str(properties.partID) || 'unknown'

  switch (str(part.type)) {
    case 'text': {
      const delta = state.textDelta(partId, str(part.text))
      return delta ? [{ type: 'agent_message', text: delta, delta: true }] : []
    }
    case 'reasoning': {
      const delta = state.textDelta(partId, str(part.text))
      return delta ? [{ type: 'agent_thinking', text: delta, delta: true }] : []
    }
    case 'tool':
      return fromToolPart(partId, part, state)
    case 'patch': {
      const files = Array.isArray(part.files) ? part.files : []
      return files
        .map(entry => str(entry))
        .filter(path => path.length > 0 && state.announceFile(path, 'modified'))
        .map(path => ({ type: 'file_changed' as const, path, change: 'modified' as const }))
    }
    default:
      // step-start, step-finish, agent, snapshot, file — no user-visible content
      // RAYU needs, and an unknown future part type lands here too.
      return []
  }
}

/**
 * Translate one OpenCode bus event.
 *
 * @param state per-stream memory; construct one per connection.
 * @returns events in publish order; `[]` for anything not modelled.
 */
export function normalizeOpenCodeEvent(
  raw: unknown,
  state: OpenCodeStreamState,
): EventPayload[] {
  const { type, properties } = readEventEnvelope(raw)

  switch (type) {
    case OPENCODE_EVENT.messagePartUpdated:
      return fromPartUpdated(properties, state)

    case OPENCODE_EVENT.sessionIdle:
      return [{ type: 'task_completed' }, { type: 'agent_idle' }]

    case OPENCODE_EVENT.sessionError: {
      const message = readErrorMessage(properties)
      return isProviderFaultError(properties)
        ? [{ type: 'agent_error', message, providerFault: true }]
        : [{ type: 'task_failed', message }, { type: 'agent_idle' }]
    }

    case OPENCODE_EVENT.sessionDeleted:
      return [{ type: 'agent_disconnected', reason: 'shutdown' }]

    case OPENCODE_EVENT.permissionUpdated: {
      const permission = asRecord(properties.permission ?? properties)
      const requestId = str(permission.id) || str(properties.permissionID)
      if (!requestId) return []
      return [
        {
          type: 'permission_requested',
          requestId,
          kind: classifyPermission(str(permission.type)),
          description:
            str(permission.title) ||
            str(permission.description) ||
            `approve ${str(permission.type) || 'an action'}`,
          cwd: str(permission.cwd) || undefined,
        },
      ]
    }

    case OPENCODE_EVENT.fileEdited: {
      const path = str(properties.file) || str(properties.path)
      const change = mapFileChange(str(properties.action))
      return path && state.announceFile(path, change)
        ? [{ type: 'file_changed', path, change }]
        : []
    }

    // Modelled as no-ops: connection handshake, message-level bookkeeping that
    // the part stream already covers, and session metadata changes.
    case OPENCODE_EVENT.serverConnected:
    case OPENCODE_EVENT.messageUpdated:
    case OPENCODE_EVENT.messageRemoved:
    case OPENCODE_EVENT.sessionUpdated:
    case OPENCODE_EVENT.permissionReplied:
      return []

    default:
      return []
  }
}

function classifyPermission(
  type: string,
): 'command' | 'file_change' | 'network' | 'tool' | 'other' {
  const normalized = type.toLowerCase()
  if (normalized.includes('bash') || normalized.includes('command')) return 'command'
  if (normalized.includes('edit') || normalized.includes('write')) return 'file_change'
  if (normalized.includes('fetch') || normalized.includes('network')) return 'network'
  if (normalized.includes('tool') || normalized.includes('mcp')) return 'tool'
  return 'other'
}

/** Session id an event belongs to, when it carries one. */
export function extractSessionId(raw: unknown): string | undefined {
  const { properties } = readEventEnvelope(raw)
  return (
    str(properties.sessionID) ||
    str(properties.sessionId) ||
    str(asRecord(properties.info).sessionID) ||
    str(asRecord(properties.session).id) ||
    undefined
  )
}
