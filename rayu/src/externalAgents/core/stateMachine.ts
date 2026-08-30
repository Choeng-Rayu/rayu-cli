/**
 * Agent lifecycle transitions and admission control.
 *
 * Pure and synchronous by design — no I/O, no imports from the persistence or
 * transport layers. That is what lets the orchestrator ask "what should happen
 * if I send this now?" without side effects, and what makes the whole decision
 * table exhaustively testable.
 *
 * ## Why admission control exists
 *
 * `sendTask(agent, prompt)` is never a safe fire-and-forget operation. An agent
 * may be mid-turn, mid-approval, disconnected-but-alive, or dead-but-recorded-as
 * -working. Sending blindly in those states either destroys in-flight work or
 * throws a protocol error the caller cannot recover from. Codex documents this
 * explicitly: `turn/steer` is rejected on review and manual-compaction turns
 * with `ActiveTurnNotSteerable`, so "is a turn running" is not enough — the
 * *kind* of turn decides whether steering is legal.
 *
 * `resolveAdmission` therefore returns an action to take, never a boolean.
 *
 * ## Why the four axes stay separate
 *
 * `processState`, `connectionState` and `agentState` disagree in normal
 * operation, and each disagreement means something different:
 *
 *   - process running + connection lost -> alive but unreachable; reconnect and
 *     resume, do not relaunch (relaunching would abandon a live session).
 *   - process exited + agentState 'working' -> a stale record; the agent is
 *     dead regardless of what it last told us.
 *   - connection connected + agent 'working' + task stalled -> the upstream
 *     model provider is the problem, not the agent.
 *
 * Collapsing them into one status field makes all three indistinguishable.
 * `reconcileSnapshot` resolves only the unambiguous contradiction; the rest are
 * handled as distinct admission outcomes.
 */

import {
  type AgentCapabilities,
  type AgentState,
  type AgentStatusSnapshot,
  isSteerableTurnKind,
  supportsOperation,
} from './types.js'

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Legal `agentState` transitions.
 *
 * `failed`, `dead` and `stopped` all lead back to `starting` because relaunch is
 * a supported recovery, not a new agent — the instance id and its persisted
 * native session survive. `isTerminalAgentState` means "will not advance on its
 * own", not "unreachable forever".
 */
export const AGENT_STATE_TRANSITIONS: Readonly<
  Record<AgentState, readonly AgentState[]>
> = {
  starting: ['connecting', 'ready', 'failed', 'dead', 'stopped'],
  connecting: ['ready', 'failed', 'dead', 'stopped'],
  ready: ['working', 'idle', 'waiting', 'failed', 'dead', 'stopped'],
  working: ['idle', 'waiting', 'interrupted', 'failed', 'dead', 'stopped'],
  idle: ['working', 'waiting', 'failed', 'dead', 'stopped'],
  waiting: ['working', 'idle', 'interrupted', 'failed', 'dead', 'stopped'],
  interrupted: ['working', 'idle', 'ready', 'failed', 'dead', 'stopped'],
  failed: ['starting', 'dead', 'stopped'],
  dead: ['starting'],
  stopped: ['starting'],
}

/** True when `to` is a legal next state from `from`. Self-transitions are no-ops. */
export function canTransitionAgentState(
  from: AgentState,
  to: AgentState,
): boolean {
  if (from === to) return true
  return AGENT_STATE_TRANSITIONS[from].includes(to)
}

/** Message naming the illegal transition and what would have been legal. */
export function describeIllegalTransition(
  from: AgentState,
  to: AgentState,
): string {
  return (
    `Illegal agent state transition ${from} -> ${to}. ` +
    `Legal from ${from}: ${AGENT_STATE_TRANSITIONS[from].join(', ') || 'none'}.`
  )
}

/**
 * Resolve the one contradiction between axes that has a single correct answer:
 * a process that has exited cannot be running an agent, whatever the last
 * observed `agentState` claimed.
 *
 * Deliberately does NOT reconcile a lost connection. `connectionState: 'lost'`
 * with a live process means the agent is alive and unreachable — a state that
 * calls for reconnect-and-resume, and one that has no `agentState` of its own.
 * Rewriting it to `dead` here would make the orchestrator relaunch and abandon
 * a live session.
 *
 * `processState: 'absent'` is not a contradiction: adopted HTTP agents legitimately
 * have no local pid.
 */
export function reconcileSnapshot(
  snapshot: AgentStatusSnapshot,
): AgentStatusSnapshot {
  const processGone =
    snapshot.processState === 'exited' || snapshot.processState === 'killed'
  if (!processGone) return snapshot
  if (
    snapshot.agentState === 'dead' ||
    snapshot.agentState === 'stopped' ||
    snapshot.agentState === 'failed'
  ) {
    // Already terminal — preserve the recorded cause rather than flattening
    // 'failed' into 'dead' and losing why it died.
    return snapshot.activeTurn === undefined
      ? snapshot
      : { ...snapshot, activeTurn: undefined }
  }
  return {
    ...snapshot,
    agentState: snapshot.processState === 'killed' ? 'stopped' : 'dead',
    connectionState: 'lost',
    activeTurn: undefined,
  }
}

// ---------------------------------------------------------------------------
// Admission control
// ---------------------------------------------------------------------------

/**
 * What the orchestrator should do with a request, given live state.
 *
 *   `dispatch` send now as a new turn
 *   `steer`    inject into the turn already running
 *   `queue`    hold until the agent is idle (admission will re-run)
 *   `resume`   re-establish the session first, then send
 *   `relaunch` start the process again, restoring the native session, then send
 *   `reject`   do not attempt — the agent cannot serve this request
 */
export type AdmissionAction =
  | 'dispatch'
  | 'steer'
  | 'queue'
  | 'resume'
  | 'relaunch'
  | 'reject'

export type AdmissionRequest = {
  /**
   * `send` covers both `/agent assign` and `/agent chat` — they differ in
   * bookkeeping, not in what the agent must be able to do.
   */
  intent: 'send' | 'interrupt' | 'stop'
  /**
   * When the agent is mid-turn, prefer steering that turn over queueing behind
   * it. Only honoured when the agent and the turn kind both allow it; a request
   * to steer an unsteerable turn degrades to `queue`, never to an error.
   */
  preferSteer?: boolean
}

export type AdmissionDecision = {
  readonly action: AdmissionAction
  /** Human-readable justification, surfaced verbatim by commands and the tool. */
  readonly reason: string
}

/**
 * Decide how to serve `request` against the agent's current state.
 *
 * Layered, and the order matters:
 *
 *   1. **Capability** — reject what the agent fundamentally cannot do, before
 *      state is even considered. This is the difference between an actionable
 *      "this agent cannot be interrupted" and a protocol error 30 seconds later.
 *   2. **Process** — a dead process needs relaunching; no state below matters.
 *   3. **Connection** — alive but unreachable needs resuming, not relaunching.
 *   4. **Agent lifecycle** — the ordinary dispatch/steer/queue decision.
 *
 * Never throws. Every input maps to a decision, so callers have one code path.
 */
export function resolveAdmission(
  rawSnapshot: AgentStatusSnapshot,
  capabilities: AgentCapabilities,
  request: AdmissionRequest,
): AdmissionDecision {
  const snapshot = reconcileSnapshot(rawSnapshot)

  const capabilityRejection = checkCapability(capabilities, request)
  if (capabilityRejection) return capabilityRejection

  if (request.intent === 'interrupt' || request.intent === 'stop') {
    return resolveControlIntent(snapshot, request)
  }

  const reachability = checkReachability(snapshot)
  if (reachability) return reachability

  return resolveSendIntent(snapshot, capabilities, request)
}

/** Reject requests the agent's declared capabilities cannot serve at all. */
function checkCapability(
  capabilities: AgentCapabilities,
  request: AdmissionRequest,
): AdmissionDecision | null {
  if (request.intent === 'send' && !supportsOperation(capabilities, 'sendMessage')) {
    return {
      action: 'reject',
      reason:
        'This agent cannot receive messages from RAYU. It can only be observed or attached to.',
    }
  }
  if (request.intent === 'interrupt' && !supportsOperation(capabilities, 'interrupt')) {
    return {
      action: 'reject',
      reason: 'This agent cannot be interrupted by RAYU.',
    }
  }
  if (request.intent === 'stop' && !supportsOperation(capabilities, 'kill')) {
    return {
      action: 'reject',
      reason: 'This agent cannot be stopped by RAYU; stop it in its own terminal.',
    }
  }
  return null
}

/** Interrupt and stop only make sense against something actually running. */
function resolveControlIntent(
  snapshot: AgentStatusSnapshot,
  request: AdmissionRequest,
): AdmissionDecision {
  const { agentState } = snapshot
  if (agentState === 'dead' || agentState === 'stopped') {
    return {
      action: 'reject',
      reason: `Agent is already ${agentState}; nothing to ${request.intent}.`,
    }
  }
  if (request.intent === 'interrupt' && agentState !== 'working') {
    return {
      action: 'reject',
      reason: `Agent is ${agentState}, not working; there is no turn to interrupt.`,
    }
  }
  return {
    action: 'dispatch',
    reason: `Agent is ${agentState}; ${request.intent} can proceed.`,
  }
}

/**
 * Handle a dead process or a dropped channel before considering lifecycle.
 *
 * The two are distinct outcomes on purpose — see the module header.
 */
function checkReachability(
  snapshot: AgentStatusSnapshot,
): AdmissionDecision | null {
  const { processState, connectionState, agentState } = snapshot

  if (agentState === 'dead' || agentState === 'stopped') {
    return {
      action: 'relaunch',
      reason: `Agent is ${agentState}; relaunch and resume its previous session before sending.`,
    }
  }
  if (agentState === 'failed') {
    return {
      action: 'relaunch',
      reason:
        'Agent previously failed; relaunch and resume its previous session before sending.',
    }
  }
  if (processState === 'exited' || processState === 'killed') {
    return {
      action: 'relaunch',
      reason: `Agent process has ${processState}; relaunch before sending.`,
    }
  }
  if (connectionState === 'lost' || connectionState === 'disconnected') {
    return {
      action: 'resume',
      reason:
        'Agent process is alive but its control channel is not connected; reconnect and resume the session before sending.',
    }
  }
  if (connectionState === 'connecting' || agentState === 'starting' || agentState === 'connecting') {
    return {
      action: 'queue',
      reason: 'Agent is still coming up; the request will be sent once it is ready.',
    }
  }
  return null
}

/** The ordinary dispatch / steer / queue decision for a reachable agent. */
function resolveSendIntent(
  snapshot: AgentStatusSnapshot,
  capabilities: AgentCapabilities,
  request: AdmissionRequest,
): AdmissionDecision {
  const { agentState, activeTurn } = snapshot

  switch (agentState) {
    case 'ready':
    case 'idle':
      return {
        action: 'dispatch',
        reason: `Agent is ${agentState}; sending as a new turn.`,
      }

    case 'interrupted':
      return {
        action: 'resume',
        reason:
          'Agent has an interrupted turn; resume the session so the new input continues that conversation.',
      }

    case 'waiting':
      return {
        action: 'resume',
        reason:
          'Agent is blocked waiting on an approval or its provider; resolve that and resume before sending.',
      }

    case 'working':
      return resolveWhileWorking(activeTurn, capabilities, request)

    // Unreachable: checkReachability already returned for these. Kept so the
    // switch stays exhaustive and a new AgentState is a compile error here.
    case 'starting':
    case 'connecting':
    case 'failed':
    case 'dead':
    case 'stopped':
      return {
        action: 'queue',
        reason: `Agent is ${agentState}; holding the request.`,
      }
  }
}

/**
 * Steer only when all three hold: the caller asked for it, the agent supports
 * same-turn steering, and the running turn's kind accepts it. Otherwise queue.
 *
 * Degrading to `queue` rather than erroring is deliberate: a caller that
 * requested steering still wants the work done, and Codex would reject the
 * steer anyway on a review or compaction turn.
 */
function resolveWhileWorking(
  activeTurn: AgentStatusSnapshot['activeTurn'],
  capabilities: AgentCapabilities,
  request: AdmissionRequest,
): AdmissionDecision {
  if (!request.preferSteer) {
    return {
      action: 'queue',
      reason:
        'Agent is working; queueing so its in-flight turn is not disturbed.',
    }
  }
  if (!supportsOperation(capabilities, 'steer')) {
    return {
      action: 'queue',
      reason:
        'Agent is working and does not support steering an in-flight turn; queueing instead.',
    }
  }
  if (!activeTurn) {
    return {
      action: 'queue',
      reason:
        'Agent reports working but no active turn is known; queueing rather than guessing a turn id to steer.',
    }
  }
  if (!isSteerableTurnKind(activeTurn.kind)) {
    return {
      action: 'queue',
      reason: `Agent is in a ${activeTurn.kind} turn, which cannot be steered; queueing instead.`,
    }
  }
  return {
    action: 'steer',
    reason: `Steering the active ${activeTurn.kind} turn ${activeTurn.id}.`,
  }
}
