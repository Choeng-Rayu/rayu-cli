/**
 * In-process pub/sub for normalized external-agent events.
 *
 * Adapters publish; sinks subscribe. Nothing else in the codebase needs to know
 * which provider produced an event.
 *
 * ## Why Node's EventEmitter and not `src/ink/events/emitter.ts`
 *
 * The ink emitter exists to give terminal *input* events
 * `stopImmediatePropagation` semantics, and it lives inside the renderer. This
 * bus is consumed by adapters, the recovery path and the persistence layer —
 * none of which should pull the renderer into their module graph. That is the
 * same separation `LocalShellTask/guards.ts` makes when it splits pure types out
 * of the `.tsx`. Event delivery here is fan-out with no cancellation, so the
 * extra semantics would be unused weight.
 *
 * ## Sequence numbers
 *
 * Every event carries a `seq` that is monotonic per agent instance. Consumers
 * use it to order events that share a millisecond and to detect gaps after a
 * reconnect. The allocator is seedable so a recovered agent continues its
 * sequence from the persisted `lastEventSeq` rather than restarting at 1 and
 * making old and new events indistinguishable.
 */

import { EventEmitter } from 'events'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import type { AgentInstanceId, ExternalAgentEvent } from './types.js'

/** Single channel — subscribers filter by agent themselves. */
const CHANNEL = 'external-agent-event'

/**
 * Sinks (UI, model queue, SDK, disk log) plus per-agent watchers from commands
 * and the recovery path. The Node default of 10 would emit spurious leak
 * warnings once a handful of agents are being watched at once.
 */
const MAX_LISTENERS = 64

const emitter = new EventEmitter()
emitter.setMaxListeners(MAX_LISTENERS)

const seqByAgent = new Map<AgentInstanceId, number>()

export type EventListener = (event: ExternalAgentEvent) => void

/**
 * Allocate the next sequence number for an agent.
 *
 * Called by adapters via the event factory rather than directly.
 */
export function nextSeq(agentId: AgentInstanceId): number {
  const next = (seqByAgent.get(agentId) ?? 0) + 1
  seqByAgent.set(agentId, next)
  return next
}

/**
 * Continue an agent's sequence from a persisted high-water mark.
 *
 * Called during recovery before any event is published for that agent. Lowering
 * a sequence is refused: replaying numbers already written to the log would make
 * gap detection report phantom gaps and dedupe drop live events.
 */
export function seedSeq(agentId: AgentInstanceId, lastSeq: number): void {
  const current = seqByAgent.get(agentId) ?? 0
  if (lastSeq > current) {
    seqByAgent.set(agentId, lastSeq)
  }
}

/** Highest sequence issued for an agent so far, for persisting `lastEventSeq`. */
export function currentSeq(agentId: AgentInstanceId): number {
  return seqByAgent.get(agentId) ?? 0
}

/**
 * Forget an agent's sequence. Call only when its state directory is pruned —
 * doing so while a log still exists would restart numbering at 1.
 */
export function forgetSeq(agentId: AgentInstanceId): void {
  seqByAgent.delete(agentId)
}

/**
 * Publish one event to every subscriber.
 *
 * A throwing subscriber is logged and skipped rather than allowed to abort
 * delivery: one broken sink must not stop the disk log from recording an event,
 * because that log is what the recovery path reads after a crash.
 */
export function publishEvent(event: ExternalAgentEvent): void {
  const listeners = emitter.listeners(CHANNEL) as EventListener[]
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (e) {
      logForDebugging(
        `[eventBus] subscriber threw on ${event.type} for ${event.agentId}: ${errorMessage(e)}`,
      )
    }
  }
}

/** Subscribe to every agent's events. Returns an unsubscribe function. */
export function subscribeToEvents(listener: EventListener): () => void {
  emitter.on(CHANNEL, listener)
  return () => {
    emitter.off(CHANNEL, listener)
  }
}

/** Subscribe to one agent's events. Returns an unsubscribe function. */
export function subscribeToAgent(
  agentId: AgentInstanceId,
  listener: EventListener,
): () => void {
  return subscribeToEvents(event => {
    if (event.agentId === agentId) {
      listener(event)
    }
  })
}

/**
 * Wait for the next event from an agent matching `predicate`.
 *
 * Used by adapters to await a specific protocol milestone (a turn completing,
 * a session becoming idle) without each one hand-rolling listener bookkeeping.
 * Always settles: on timeout it resolves `null` rather than rejecting, so the
 * caller decides whether a timeout is an error.
 */
export function waitForAgentEvent(
  agentId: AgentInstanceId,
  predicate: (event: ExternalAgentEvent) => boolean,
  timeoutMs: number,
): Promise<ExternalAgentEvent | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(null)
    }, timeoutMs)
    timer.unref()

    const unsubscribe = subscribeToAgent(agentId, event => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

/** Remove every subscriber and clear sequence state. Test/reset helper. */
export function resetEventBus(): void {
  emitter.removeAllListeners(CHANNEL)
  seqByAgent.clear()
}
