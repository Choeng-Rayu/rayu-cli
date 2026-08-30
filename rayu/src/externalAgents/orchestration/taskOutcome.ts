/**
 * Wait for one delegated task to reach a conclusion.
 *
 * Why this has to exist
 * --------------------
 * `AgentManager.assign` is fire-and-forget: it reports what admission control
 * DID (dispatch / steer / queue / resume / relaunch), not what the agent
 * eventually produced. Results arrive later as `task_completed` / `task_failed`
 * on the event bus. Every orchestration policy needs to know when a step is
 * finished, so that gap is closed here once rather than in each policy.
 *
 * Every path must settle
 * ----------------------
 * An unsettled promise is indistinguishable from a hung agent, so this watches
 * for four different endings, not just the happy one:
 *
 *   - `task_completed` / `task_failed` carrying our `taskRef` — the normal case.
 *   - `agent_disconnected` for the OWNING agent. Disconnect events are
 *     agent-level and carry no taskRef, so without this a crashed agent would
 *     leave the step waiting forever.
 *   - an abort signal, so a cancelled plan does not leak watchers.
 *   - an optional timeout, which is opt-in because a legitimate foreign turn can
 *     run for many minutes and a default deadline would abandon real work.
 *
 * `agent_error` deliberately does NOT settle: it is documented as non-fatal and
 * the agent may still finish the turn. Its `providerFault` flag is recorded
 * though, because that is exactly what a retry policy needs to decide whether
 * another attempt is worth making.
 */

import { subscribeToEvents } from '../core/eventBus.js'
import type {
  AgentInstanceId,
  ExternalAgentEvent,
  TaskRef,
} from '../core/types.js'

export type TaskOutcomeStatus =
  | 'completed'
  | 'failed'
  /** The owning agent dropped its control channel before finishing. */
  | 'disconnected'
  | 'timeout'
  | 'aborted'

export type TaskOutcome = {
  readonly taskRef: TaskRef
  readonly agentId: AgentInstanceId
  readonly status: TaskOutcomeStatus
  /** Completion summary, or the failure message. */
  readonly detail?: string
  /** Provider-specific classifier from the adapter, when one was supplied. */
  readonly code?: string
  /**
   * True when a `providerFault` error was seen for this task before it ended.
   * A retry is worth making; a non-provider fault usually is not.
   */
  readonly sawProviderFault: boolean
  readonly durationMs: number
}

export type AwaitTaskOptions = {
  readonly signal?: AbortSignal
  /** Opt-in deadline. Omitted means "wait as long as the agent takes". */
  readonly timeoutMs?: number
}

/**
 * Resolve when `taskRef` concludes. Never rejects — every ending is a status,
 * because a caller running a policy needs to branch on the reason rather than
 * catch.
 */
export function awaitTaskOutcome(
  taskRef: TaskRef,
  agentId: AgentInstanceId,
  options: AwaitTaskOptions = {},
): Promise<TaskOutcome> {
  const startedAt = Date.now()

  return new Promise<TaskOutcome>(resolve => {
    let settled = false
    let sawProviderFault = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (
      status: TaskOutcomeStatus,
      detail?: string,
      code?: string,
    ): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        taskRef,
        agentId,
        status,
        detail,
        code,
        sawProviderFault,
        durationMs: Date.now() - startedAt,
      })
    }

    function onAbort(): void {
      finish('aborted', 'the plan was cancelled')
    }

    // Checked before subscribing: an already-aborted signal must not leave a
    // live subscription behind.
    if (options.signal?.aborted) {
      finish('aborted', 'the plan was cancelled')
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    unsubscribe = subscribeToEvents((event: ExternalAgentEvent) => {
      if (event.type === 'agent_error') {
        // Non-fatal by contract, so it does not end the wait — but remember the
        // attribution for the retry decision.
        if (event.taskRef === taskRef && event.providerFault === true) {
          sawProviderFault = true
        }
        return
      }

      if (event.type === 'agent_disconnected') {
        // Agent-level, so matched on agentId rather than taskRef.
        if (event.agentId === agentId) {
          finish(
            'disconnected',
            `${agentId} disconnected (${event.reason}) before the task finished`,
          )
        }
        return
      }

      if (event.taskRef !== taskRef) return

      if (event.type === 'task_completed') {
        finish('completed', event.summary)
      } else if (event.type === 'task_failed') {
        finish('failed', event.message, event.code)
      }
    })

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () =>
          finish(
            'timeout',
            `no result within ${options.timeoutMs}ms; the agent may still be working`,
          ),
        options.timeoutMs,
      )
      // Do not hold the process open just to enforce a deadline.
      timer.unref?.()
    }
  })
}

/** True when the outcome means the work landed. */
export function isSuccessfulOutcome(outcome: TaskOutcome): boolean {
  return outcome.status === 'completed'
}

/**
 * Whether another attempt has a realistic chance.
 *
 * A provider fault (rate limit, overload, upstream 5xx) is transient, so a
 * retry is reasonable. A disconnect is worth one more try because a relaunch
 * may fix it. A plain `failed` usually means the agent tried and could not do
 * the work — repeating the identical prompt would most likely fail identically,
 * so it is NOT retried by default; `fallback` to a different agent is the
 * better answer, and the caller can still opt in.
 */
export function looksRetryable(outcome: TaskOutcome): boolean {
  if (outcome.status === 'completed' || outcome.status === 'aborted') {
    return false
  }
  return (
    outcome.sawProviderFault ||
    outcome.status === 'disconnected' ||
    outcome.status === 'timeout'
  )
}
