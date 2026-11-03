/**
 * Error types for the external-agent orchestrator.
 *
 * Three distinct kinds, because the correct response to each differs and a
 * single generic `Error` would make them indistinguishable at the call site:
 *
 *   `CapabilityError`      the agent genuinely cannot do this. User-facing and
 *                          actionable; not a bug, not retryable.
 *   `AdmissionError`       admission control refused right now. Carries the
 *                          decision so the caller can explain or retry later.
 *   `AdapterInvariantError` an adapter declared a capability but did not
 *                          implement it. A RAYU bug, never the user's fault.
 */

import type { AdmissionDecision } from './stateMachine.js'
import type {
  AgentCapabilities,
  AgentInstanceId,
  AgentOperation,
  CapabilityAxis,
  ControlLevel,
  ProviderId,
} from './types.js'

/**
 * The agent cannot perform an operation at the level it requires.
 *
 * Thrown *before* any protocol call, so the user learns "this agent cannot be
 * adopted" instead of watching a request fail obscurely 30 seconds in.
 */
export class CapabilityError extends Error {
  readonly agentId: AgentInstanceId
  readonly operation: AgentOperation
  readonly axis: CapabilityAxis
  readonly required: ControlLevel
  readonly actual: ControlLevel

  constructor(params: {
    agentId: AgentInstanceId
    operation: AgentOperation
    axis: CapabilityAxis
    required: ControlLevel
    actual: ControlLevel
  }) {
    super(
      `${params.agentId} cannot ${params.operation}: ` +
        `supports ${params.axis} at level '${params.actual}', ` +
        `but ${params.operation} requires '${params.required}'.`,
    )
    this.name = 'CapabilityError'
    this.agentId = params.agentId
    this.operation = params.operation
    this.axis = params.axis
    this.required = params.required
    this.actual = params.actual
  }
}

/** Admission control refused the request. `decision.reason` is user-facing. */
export class AdmissionError extends Error {
  readonly agentId: AgentInstanceId
  readonly decision: AdmissionDecision

  constructor(agentId: AgentInstanceId, decision: AdmissionDecision) {
    super(`${agentId}: ${decision.reason}`)
    this.name = 'AdmissionError'
    this.agentId = agentId
    this.decision = decision
  }
}

/**
 * An adapter's declared capabilities and its implemented methods disagree.
 *
 * Surfaced loudly rather than degraded, because silently treating a declared
 * capability as absent would make the honest capability model a lie — the whole
 * point is that a declared level can be trusted.
 */
export class AdapterInvariantError extends Error {
  constructor(provider: ProviderId, detail: string) {
    super(
      `Adapter '${provider}' violates its own capability declaration: ${detail}. ` +
        `This is a RAYU bug, not a problem with the external agent.`,
    )
    this.name = 'AdapterInvariantError'
  }
}

/** No adapter is registered for a provider id. */
export class UnknownProviderError extends Error {
  constructor(provider: ProviderId, known: readonly ProviderId[]) {
    super(
      `No adapter registered for provider '${provider}'. ` +
        `Known providers: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
    )
    this.name = 'UnknownProviderError'
  }
}

/** The agent instance is not in the registry (never started, or already reaped). */
export class UnknownAgentError extends Error {
  constructor(agentId: AgentInstanceId, known: readonly AgentInstanceId[]) {
    super(
      `No live agent '${agentId}'. ` +
        `Running: ${known.length > 0 ? known.join(', ') : '(none)'}. ` +
        `Use '/agent list' to see persisted agents that can be relaunched.`,
    )
    this.name = 'UnknownAgentError'
  }
}

/** Convenience for reporting a capability shortfall without a live handle. */
export function describeCapabilityGap(
  capabilities: AgentCapabilities,
  axis: CapabilityAxis,
): string {
  return `${axis}='${capabilities[axis]}'`
}
