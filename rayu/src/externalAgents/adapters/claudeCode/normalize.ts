/**
 * Pure translation from Claude Code `stream-json` envelopes to normalized events.
 *
 * No I/O, no publishing, no state — same contract as the Codex normalizer, for
 * the same reason: Task 19 drives it from recorded wire fixtures.
 *
 * Two shape differences from Codex worth knowing:
 *
 *   - **Assistant output arrives as whole messages,** not as a stream of typed
 *     item notifications. One envelope can therefore yield several events (text
 *     plus two tool calls), which is why `normalize` returns an array.
 *   - **File edits are ordinary tool calls.** There is no file-change event, so
 *     `changedFiles` can only be populated by recognizing the tools that write
 *     and reading their input paths. That inference is explicit and narrow
 *     (`CLAUDE_FILE_WRITING_TOOLS`) rather than guessing from arbitrary tool
 *     names, because a false positive would make the Workspace Manager report
 *     conflicts that do not exist.
 */

import type { EventPayload } from '../../core/normalizer.js'
import {
  CLAUDE_BLOCK,
  CLAUDE_FILE_WRITING_TOOLS,
  CLAUDE_MESSAGE_TYPE,
  CLAUDE_RESULT_SUCCESS,
  type ClaudeContentBlock,
  type ClaudeMessageEnvelope,
} from './protocol.js'

/**
 * `result.subtype` values that mean the provider failed rather than the agent.
 *
 * Only these leave the task alive as `waiting-provider`. `error_max_turns` and
 * `error_during_execution` are genuine task failures — retrying without change
 * would fail identically.
 */
const PROVIDER_FAULT_SUBTYPES = new Set([
  'error_rate_limit',
  'error_overloaded',
  'error_api',
])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Content blocks, tolerating the string form some envelopes use. */
function blocksOf(envelope: ClaudeMessageEnvelope): ClaudeContentBlock[] {
  const content = envelope.message?.content
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  return Array.isArray(content) ? content : []
}

/**
 * Paths a file-writing tool is about to touch.
 *
 * Reads the documented input keys only. An unrecognized shape yields no paths,
 * which is the safe direction: a missed path means a missed conflict warning,
 * while a wrong path would block an unrelated agent's write.
 */
export function extractEditedPaths(block: ClaudeContentBlock): string[] {
  const input = asRecord(block.input)
  const single = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (single) return [single]

  // MultiEdit-style: an array of per-file edits.
  const edits = Array.isArray(input.edits) ? input.edits : []
  const paths = edits
    .map(edit => str(asRecord(edit).file_path))
    .filter(path => path.length > 0)
  return [...new Set(paths)]
}

/** Human-readable one-liner for a tool call, safe to display. */
function summarizeToolUse(block: ClaudeContentBlock): string | undefined {
  const input = asRecord(block.input)
  const command = str(input.command)
  if (command) return command
  const path = extractEditedPaths(block)[0]
  if (path) return path
  const pattern = str(input.pattern) || str(input.query)
  return pattern || undefined
}

function fromAssistantBlock(block: ClaudeContentBlock): EventPayload[] {
  switch (block.type) {
    case CLAUDE_BLOCK.text:
      return block.text
        ? [{ type: 'agent_message', text: block.text, delta: false }]
        : []

    case CLAUDE_BLOCK.thinking:
      return block.thinking
        ? [{ type: 'agent_thinking', text: block.thinking, delta: false }]
        : []

    case CLAUDE_BLOCK.toolUse: {
      const callId = block.id ?? 'unknown'
      const toolName = block.name ?? 'unknown'
      const events: EventPayload[] = [
        {
          type: 'tool_started',
          callId,
          toolName,
          summary: summarizeToolUse(block),
        },
      ]
      // Claude Code has no file-change event; infer from write-capable tools so
      // the Workspace Manager can see what this agent is touching.
      if (CLAUDE_FILE_WRITING_TOOLS.has(toolName)) {
        for (const path of extractEditedPaths(block)) {
          events.push({
            type: 'file_changed',
            path,
            change: toolName === 'Write' ? 'created' : 'modified',
          })
        }
      }
      return events
    }

    default:
      return []
  }
}

/** Tool results arrive as blocks on a `user` envelope. */
function fromUserBlock(block: ClaudeContentBlock): EventPayload[] {
  if (block.type !== CLAUDE_BLOCK.toolResult) return []
  const raw = block.content
  const chunk =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map(part => str(asRecord(part).text)).join('')
        : ''
  if (!chunk) return []
  return [
    {
      type: 'tool_output',
      callId: block.tool_use_id ?? 'unknown',
      chunk,
      stream: block.is_error ? 'stderr' : 'stdout',
    },
  ]
}

function fromResult(envelope: ClaudeMessageEnvelope): EventPayload[] {
  const subtype = envelope.subtype ?? ''
  const succeeded = subtype === CLAUDE_RESULT_SUCCESS && envelope.is_error !== true

  if (succeeded) {
    return [
      { type: 'task_completed', summary: envelope.result || undefined },
      { type: 'agent_idle' },
    ]
  }

  const message = envelope.result || `Claude Code ended with '${subtype || 'an error'}'`
  if (PROVIDER_FAULT_SUBTYPES.has(subtype)) {
    // Task stays alive: the user can wait it out or move the work elsewhere.
    return [{ type: 'agent_error', message, providerFault: true }]
  }
  return [
    { type: 'task_failed', message, code: subtype || undefined },
    { type: 'agent_idle' },
  ]
}

/** Partial streaming deltas, only present with `--include-partial-messages`. */
function fromStreamEvent(envelope: ClaudeMessageEnvelope): EventPayload[] {
  const event = envelope.event
  if (event?.type !== 'content_block_delta') return []
  const delta = event.delta
  if (delta?.type === 'text_delta' && delta.text) {
    return [{ type: 'agent_message', text: delta.text, delta: true }]
  }
  if (delta?.type === 'thinking_delta' && delta.thinking) {
    return [{ type: 'agent_thinking', text: delta.thinking, delta: true }]
  }
  return []
}

/**
 * Translate one `stream-json` envelope.
 *
 * @returns events in publish order; `[]` for anything not modelled, including
 *   unknown envelope types and unknown content blocks.
 */
export function normalizeClaudeEnvelope(raw: unknown): EventPayload[] {
  const envelope = asRecord(raw) as ClaudeMessageEnvelope

  switch (envelope.type) {
    case CLAUDE_MESSAGE_TYPE.assistant:
      return blocksOf(envelope).flatMap(block => fromAssistantBlock(block))

    case CLAUDE_MESSAGE_TYPE.user:
      // Also covers `--replay-user-messages` echoes, whose blocks are plain text
      // and therefore produce nothing — we do not want our own prompt echoed
      // back into the transcript as agent output.
      return blocksOf(envelope).flatMap(block => fromUserBlock(block))

    case CLAUDE_MESSAGE_TYPE.result:
      return fromResult(envelope)

    case CLAUDE_MESSAGE_TYPE.streamEvent:
      return fromStreamEvent(envelope)

    case CLAUDE_MESSAGE_TYPE.system:
      // `init` carries the session id, which the adapter captures directly from
      // the envelope. Nothing here is user-visible.
      return []

    default:
      return []
  }
}

/** The session id Claude Code reports, so RAYU records the real one. */
export function extractSessionId(raw: unknown): string | undefined {
  const envelope = asRecord(raw) as ClaudeMessageEnvelope
  return envelope.session_id || undefined
}

/** True when this envelope ends a turn, so the adapter can go idle. */
export function isTurnTerminal(raw: unknown): boolean {
  return (asRecord(raw) as ClaudeMessageEnvelope).type === CLAUDE_MESSAGE_TYPE.result
}
