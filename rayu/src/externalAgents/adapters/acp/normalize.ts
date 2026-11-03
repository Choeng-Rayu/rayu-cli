/**
 * ACP wire messages -> RAYU's normalized events. PURE, no I/O.
 *
 * Two things here are genuinely different from the other adapters:
 *
 * 1. **Capabilities are read off the handshake, not declared up front.** An ACP
 *    agent advertises what it supports in `initialize`, and conforming agents
 *    legitimately differ — one offers `session/load`, another does not. So the
 *    per-instance `sessions` level is COMPUTED from `agentCapabilities` rather
 *    than asserted by the adapter. This is exactly what per-instance
 *    capabilities exist for; claiming a fixed ceiling would make
 *    `/agent inspect` lie about half the agents in the ecosystem.
 *
 * 2. **RAYU cannot invent a permission optionId.** Codex has a fixed decision
 *    enum and OpenCode has fixed once/always/reject values, but an ACP agent
 *    supplies its own option list. A decision is therefore satisfied by finding
 *    an offered option whose `kind` matches — and when none does, that is
 *    reported rather than papered over with a guess.
 */

import type { EventPayload } from '../../core/normalizer.js'
import type { AgentCapabilities, ControlLevel } from '../../core/types.js'
import type { PermissionDecision } from '../../core/adapter.js'
import {
  ACP_PERMISSION_KIND,
  ACP_STOP_REASON,
  ACP_TOOL_STATUS,
  ACP_UPDATE,
  type AcpAgentCapabilities,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpRequestPermissionParams,
  type AcpSessionUpdateParams,
} from './protocol.js'

/** Pull the plain text out of an ACP content block, when it has any. */
function blockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const record = block as { type?: unknown; text?: unknown }
  return record.type === 'text' && typeof record.text === 'string'
    ? record.text
    : ''
}

/**
 * Normalize one `session/update` notification.
 *
 * Unknown `sessionUpdate` values return `[]` rather than throwing: ACP adds
 * variants as non-breaking changes (that is the stated purpose of capability
 * negotiation), so an agent on a newer spec must not be able to kill a running
 * task just by sending an update RAYU has not learned about yet.
 */
export function normalizeAcpUpdate(
  params: AcpSessionUpdateParams,
): EventPayload[] {
  const update = params.update
  if (!update || typeof update.sessionUpdate !== 'string') return []

  switch (update.sessionUpdate) {
    case ACP_UPDATE.agentMessageChunk: {
      const text = blockText((update as { content?: unknown }).content)
      // Chunks are incremental by name and by spec, so they are deltas.
      return text ? [{ type: 'agent_message', text, delta: true }] : []
    }

    case ACP_UPDATE.agentThoughtChunk: {
      const text = blockText((update as { content?: unknown }).content)
      return text ? [{ type: 'agent_thinking', text, delta: true }] : []
    }

    case ACP_UPDATE.userMessageChunk:
      // RAYU's own prompt echoed back. Emitting it would duplicate the user's
      // message as agent output.
      return []

    case ACP_UPDATE.toolCall:
      return normalizeToolCall(update)

    case ACP_UPDATE.toolCallUpdate:
      return normalizeToolCallUpdate(update)

    case ACP_UPDATE.plan:
    case ACP_UPDATE.availableCommandsUpdate:
    case ACP_UPDATE.currentModeUpdate:
    case ACP_UPDATE.configOptionUpdate:
    case ACP_UPDATE.sessionInfoUpdate:
    case ACP_UPDATE.usageUpdate:
      // Real information, but none of it is agent OUTPUT. Routing a token count
      // or a mode change into the task transcript would bury the actual work.
      return []

    default:
      return []
  }
}

function normalizeToolCall(update: Record<string, unknown>): EventPayload[] {
  const callId = asString(update.toolCallId)
  const title = asString(update.title) || asString(update.kind) || 'tool'
  if (!callId) return []

  const events: EventPayload[] = [
    { type: 'tool_started', callId, toolName: title },
  ]
  events.push(...fileChangesFromLocations(update))
  return events
}

function normalizeToolCallUpdate(
  update: Record<string, unknown>,
): EventPayload[] {
  const callId = asString(update.toolCallId)
  if (!callId) return []

  const events: EventPayload[] = []
  const status = asString(update.status)

  // Tool output arrives as a content collection replacement. Only text is
  // renderable; other block kinds are the agent's own structured data.
  const content = update.content
  if (Array.isArray(content)) {
    const text = content
      .map(entry => blockText((entry as { content?: unknown })?.content ?? entry))
      .filter(Boolean)
      .join('\n')
    if (text) {
      events.push({
        type: 'tool_output',
        callId,
        chunk: text,
        stream: status === ACP_TOOL_STATUS.failed ? 'stderr' : 'stdout',
      })
    }
  }

  events.push(...fileChangesFromLocations(update))
  return events
}

/**
 * `locations` is the spec's "follow-along" hint: the files a tool call touches.
 *
 * Only emitted for a tool call that has FINISHED successfully. A pending or
 * in-progress call may still fail, and reporting a change that never landed
 * would create phantom conflicts in the workspace tracker.
 */
function fileChangesFromLocations(
  update: Record<string, unknown>,
): EventPayload[] {
  if (asString(update.status) !== ACP_TOOL_STATUS.completed) return []
  const locations = update.locations
  if (!Array.isArray(locations)) return []

  const events: EventPayload[] = []
  const seen = new Set<string>()
  for (const location of locations) {
    const path = asString((location as { path?: unknown })?.path)
    if (!path || seen.has(path)) continue
    seen.add(path)
    // ACP reports which files a call touched, not HOW. 'modified' is the honest
    // generic answer; claiming 'created' would be a guess.
    events.push({ type: 'file_changed', path, change: 'modified' })
  }
  return events
}

/**
 * Turn a completed `session/prompt` into terminal events.
 *
 * `cancelled` is NOT a failure: the client asked for it, and the spec requires
 * the agent to confirm cancellation with this stop reason. Reporting it as
 * `task_failed` would show an error for something the user chose.
 */
export function stopReasonToEvents(stopReason: string): EventPayload[] {
  switch (stopReason) {
    case ACP_STOP_REASON.endTurn:
      return [{ type: 'task_completed' }, { type: 'agent_idle' }]

    case ACP_STOP_REASON.cancelled:
      return [{ type: 'agent_idle' }]

    case ACP_STOP_REASON.maxTokens:
      return [
        {
          type: 'task_failed',
          message: 'The agent hit its token limit before finishing the turn.',
          code: stopReason,
        },
        { type: 'agent_idle' },
      ]

    case ACP_STOP_REASON.maxTurnRequests:
      return [
        {
          type: 'task_failed',
          message:
            'The agent reached its maximum number of model requests for one turn.',
          code: stopReason,
        },
        { type: 'agent_idle' },
      ]

    case ACP_STOP_REASON.refusal:
      return [
        {
          type: 'task_failed',
          message: 'The agent refused to continue with this request.',
          code: stopReason,
        },
        { type: 'agent_idle' },
      ]

    default:
      // An unrecognized stop reason still ENDED the turn. Leaving the task open
      // would hang it, so it is reported as failed with the raw value passed
      // through for diagnosis.
      return [
        {
          type: 'task_failed',
          message: `The agent stopped with an unrecognized reason: ${stopReason}`,
          code: stopReason,
        },
        { type: 'agent_idle' },
      ]
  }
}

/**
 * Derive per-instance capabilities from the handshake.
 *
 * `messages` is capped at `'message'` on purpose: ACP has `session/prompt` and
 * `session/cancel`, but NO method for injecting into a turn that is already
 * running. Declaring `'full'` would advertise a steer the protocol cannot
 * perform, and admission control would then choose it and fail.
 */
export function capabilitiesFromHandshake(
  agentCapabilities: AcpAgentCapabilities | undefined,
): AgentCapabilities {
  return {
    // A stdio JSON-RPC subprocess has no interactive terminal of its own to
    // attach to or drive.
    terminal: 'none',
    messages: 'message',
    sessions: sessionLevel(agentCapabilities),
    // RAYU spawned it, so signals and lifecycle are fully available.
    process: 'full',
    // `session/request_permission` is a genuine reply channel.
    permissions: 'full',
  }
}

function sessionLevel(
  capabilities: AcpAgentCapabilities | undefined,
): ControlLevel {
  const sessionCapabilities = capabilities?.sessionCapabilities
  const canList = sessionCapabilities?.list != null
  // `session/load` is gated by the TOP-LEVEL loadSession flag, not by
  // sessionCapabilities — the spec calls this out as a wart to be unified later.
  const canResumeOrLoad =
    capabilities?.loadSession === true || sessionCapabilities?.resume != null

  if (canList && canResumeOrLoad) return 'full'
  if (canList || canResumeOrLoad) return 'message'
  return 'none'
}

/** What the agent advertised, for `/agent inspect` and honest error messages. */
export function describeAgentCapabilities(
  capabilities: AcpAgentCapabilities | undefined,
): string[] {
  if (!capabilities) return ['the agent advertised no capabilities']
  const notes: string[] = []
  if (capabilities.loadSession === true) notes.push('session/load')
  const session = capabilities.sessionCapabilities
  for (const key of ['list', 'resume', 'close', 'delete'] as const) {
    if (session?.[key] != null) notes.push(`session/${key}`)
  }
  const prompt = capabilities.promptCapabilities
  if (prompt?.image) notes.push('image prompts')
  if (prompt?.audio) notes.push('audio prompts')
  if (prompt?.embeddedContext) notes.push('embedded context')
  return notes.length > 0 ? notes : ['baseline session methods only']
}

export type PermissionSelection =
  | { readonly kind: 'selected'; readonly optionId: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Decision -> the option kinds that satisfy it, best match first. */
const DECISION_PREFERENCES: Record<
  Exclude<PermissionDecision, 'cancel'>,
  readonly AcpPermissionOptionKind[]
> = {
  accept: [ACP_PERMISSION_KIND.allowOnce, ACP_PERMISSION_KIND.allowAlways],
  // Falling back to allow-once for accept-for-session is safe in the
  // conservative direction: the user gets asked again rather than granting more
  // than they chose.
  'accept-for-session': [
    ACP_PERMISSION_KIND.allowAlways,
    ACP_PERMISSION_KIND.allowOnce,
  ],
  decline: [ACP_PERMISSION_KIND.rejectOnce, ACP_PERMISSION_KIND.rejectAlways],
}

/**
 * Pick the offered option that satisfies a RAYU decision.
 *
 * The agent owns the option list, so this SELECTS rather than constructs. A
 * decision with no matching option returns `unavailable` with a reason instead
 * of picking an arbitrary option — sending the wrong optionId could approve
 * something the user declined.
 */
export function selectPermissionOption(
  decision: PermissionDecision,
  options: readonly AcpPermissionOption[] | undefined,
): PermissionSelection {
  if (decision === 'cancel') return { kind: 'cancelled' }

  const offered = options ?? []
  if (offered.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'the agent offered no permission options',
    }
  }

  for (const wanted of DECISION_PREFERENCES[decision]) {
    const match = offered.find(option => option.kind === wanted)
    if (match) return { kind: 'selected', optionId: match.optionId }
  }

  return {
    kind: 'unavailable',
    reason: `the agent offered only [${offered
      .map(option => option.kind)
      .join(', ')}], none of which can express "${decision}"`,
  }
}

/** Human-readable description of what the agent wants permission for. */
export function describePermissionRequest(
  params: AcpRequestPermissionParams,
): { description: string; kind: 'command' | 'file_change' | 'tool' | 'other' } {
  const toolCall = params.toolCall
  const title = asString(toolCall?.title)
  const rawKind = asString(toolCall?.kind)
  const paths = (toolCall?.locations ?? [])
    .map(location => asString(location?.path))
    .filter(Boolean)

  const description =
    title ||
    (paths.length > 0 ? `${rawKind || 'tool'} on ${paths.join(', ')}` : '') ||
    rawKind ||
    'an operation'

  return { description, kind: mapToolKind(rawKind, paths.length > 0) }
}

/**
 * ACP tool kinds are advisory UI hints and the set is open, so this maps the
 * documented ones and otherwise infers from whether files are involved.
 */
function mapToolKind(
  rawKind: string,
  hasPaths: boolean,
): 'command' | 'file_change' | 'tool' | 'other' {
  switch (rawKind) {
    case 'execute':
      return 'command'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change'
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
      return 'tool'
    default:
      return hasPaths ? 'file_change' : 'other'
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
