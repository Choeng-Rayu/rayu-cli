/**
 * The contract every adapter implements to turn its provider's wire messages
 * into `ExternalAgentEvent`s, plus the envelope helpers so no adapter hand-rolls
 * `at` / `seq` bookkeeping.
 *
 * One wire message can legitimately produce zero events (a heartbeat, an
 * acknowledgement, a notification method this adapter does not model) or several
 * (a Codex `item/completed` carrying a `fileChange` with multiple paths). So
 * `normalize` returns an array; returning `[]` is the correct way to ignore a
 * message, and is what keeps an unknown notification from crashing an adapter.
 */

import type {
  AgentInstanceId,
  AgentSessionId,
  ExternalAgentEvent,
  ExternalAgentEventBase,
  ProviderId,
  TaskRef,
} from './types.js'
import { nextSeq, publishEvent } from './eventBus.js'

/**
 * Which agent, session, task and turn an event belongs to.
 *
 * Carried separately from the wire message because most protocols do not repeat
 * all four on every notification — Codex omits `threadId` on some `item/*`
 * events, and OpenCode's SSE stream is session-scoped by connection.
 */
export type EventContext = {
  readonly agentId: AgentInstanceId
  readonly sessionId?: AgentSessionId
  readonly taskRef?: TaskRef
  readonly turnId?: string
}

/**
 * An event minus the envelope fields the factory fills in.
 *
 * Distributes over the union so each variant keeps its own required fields —
 * a plain `Omit` would collapse the discriminated union and let a
 * `tool_output` payload be built without its `callId`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

export type EventPayload = DistributiveOmit<
  ExternalAgentEvent,
  keyof ExternalAgentEventBase
>

/**
 * Stamp a payload with its envelope, allocating the next per-agent sequence.
 *
 * Sequence allocation happens here rather than at publish time so an adapter
 * that builds a batch keeps them strictly ordered even if it publishes later.
 */
export function buildEvent(
  context: EventContext,
  payload: EventPayload,
): ExternalAgentEvent {
  return {
    ...payload,
    agentId: context.agentId,
    sessionId: context.sessionId,
    taskRef: context.taskRef,
    turnId: context.turnId,
    at: Date.now(),
    seq: nextSeq(context.agentId),
  } as ExternalAgentEvent
}

/** Build and publish in one step — what adapters normally want. */
export function emitEvent(
  context: EventContext,
  payload: EventPayload,
): ExternalAgentEvent {
  const event = buildEvent(context, payload)
  publishEvent(event)
  return event
}

/** Publish a batch in order, so a multi-event wire message stays contiguous. */
export function emitEvents(
  context: EventContext,
  payloads: readonly EventPayload[],
): ExternalAgentEvent[] {
  return payloads.map(payload => emitEvent(context, payload))
}

/**
 * Provider-specific translation from wire message to normalized events.
 *
 * Implementations must be **pure** — no I/O, no publishing. That is what lets
 * Task 19 drive them from recorded wire fixtures and assert the output exactly,
 * and it keeps ordering decisions in the adapter that owns the connection.
 */
export type EventNormalizer = {
  readonly provider: ProviderId

  /**
   * Translate one wire message.
   *
   * @returns events in the order they should be published; `[]` to ignore.
   *   Must not throw on unrecognized input — an unknown notification method is
   *   expected as providers add features, and must degrade to `[]`.
   */
  normalize(raw: unknown, context: EventContext): EventPayload[]
}
