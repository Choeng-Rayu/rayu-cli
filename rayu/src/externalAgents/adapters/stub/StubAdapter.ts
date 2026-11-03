/**
 * In-memory adapter used to exercise `AgentManager` without a real agent CLI.
 *
 * Its purpose is to make the *manager* testable in isolation: capability gating,
 * admission decisions, queue draining, persistence sync and the inspection
 * matrix are all provider-independent, and validating them against a live Codex
 * process would be slow and non-deterministic.
 *
 * It is also the reference for what an adapter is responsible for. Note what it
 * does: speak a "protocol" and emit normalized events. Note what it does not do:
 * decide whether it may accept work, own task records, or route permissions.
 *
 * Configurable so one stub covers every shape the manager must handle —
 * message-only agents (no steer), observe-only agents (no send), adopted agents
 * with no pid, and process-durable agents that survive detach.
 */

import { logForDebugging } from '../../../utils/debug.js'
import type {
  AdoptTarget,
  AgentAdapter,
  AgentHandle,
  AgentInput,
  DispatchResult,
  LaunchSpec,
  PermissionDecision,
  SessionSummary,
} from '../../core/adapter.js'
import { emitEvent } from '../../core/normalizer.js'
import {
  type AdoptionClass,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentSessionId,
  type AgentStatusSnapshot,
  asAgentSessionId,
  asProviderId,
  type Durability,
  noCapabilities,
  type ProviderId,
  type TaskRef,
} from '../../core/types.js'

export type StubOptions = {
  provider?: ProviderId
  capabilities?: Partial<AgentCapabilities>
  durability?: Durability
  adoption?: AdoptionClass
  /**
   * Keep turns open instead of completing them, so tests can observe an agent
   * that is genuinely `working` and exercise steer/queue paths.
   */
  holdTurns?: boolean
  /** Report no pid, like an adopted HTTP agent. */
  withoutPid?: boolean
  /** Make `launch` reject, to exercise failure handling. */
  failLaunch?: boolean
}

const FULL: AgentCapabilities = {
  terminal: 'full',
  messages: 'full',
  sessions: 'full',
  process: 'full',
  permissions: 'full',
}

class StubHandle implements AgentHandle {
  readonly agentId: AgentInstanceId
  readonly provider: ProviderId
  readonly capabilities: AgentCapabilities
  readonly durability: Durability
  readonly adoption: AdoptionClass
  readonly transport = { kind: 'stdio' as const }
  readonly pid?: number
  readonly tmuxSession?: string

  /** Recorded so tests can assert what the manager actually sent. */
  readonly sent: { input: AgentInput; taskRef?: TaskRef }[] = []
  readonly steered: { turnId: string; input: AgentInput }[] = []
  readonly interrupted: string[] = []
  readonly permissionReplies: { requestId: string; decision: PermissionDecision }[] = []
  stopped = false
  detached = false

  #snapshot: AgentStatusSnapshot
  #sessionId: AgentSessionId
  #turnCounter = 0
  #holdTurns: boolean

  constructor(agentId: AgentInstanceId, options: StubOptions) {
    this.agentId = agentId
    this.provider = options.provider ?? asProviderId('stub')
    this.capabilities = { ...FULL, ...options.capabilities }
    this.durability = options.durability ?? 'session-bound'
    this.adoption = options.adoption ?? 'managed'
    this.pid = options.withoutPid ? undefined : process.pid
    this.#holdTurns = options.holdTurns ?? false
    this.#sessionId = asAgentSessionId(`stub-session-${agentId}`)
    this.#snapshot = {
      processState: options.withoutPid ? 'absent' : 'running',
      connectionState: 'connected',
      agentState: 'idle',
    }
  }

  status(): AgentStatusSnapshot {
    return this.#snapshot
  }

  activeSessionId(): AgentSessionId | undefined {
    return this.#sessionId
  }

  async send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult> {
    this.sent.push({ input, taskRef })
    const turnId = `turn_${++this.#turnCounter}`
    this.#snapshot = {
      ...this.#snapshot,
      agentState: 'working',
      activeTurn: { id: turnId, kind: 'regular' },
    }
    const context = { agentId: this.agentId, sessionId: this.#sessionId, taskRef, turnId }
    emitEvent(context, { type: 'agent_message', text: `echo: ${input.text}`, delta: false })

    if (!this.#holdTurns) {
      this.#snapshot = {
        processState: this.#snapshot.processState,
        connectionState: this.#snapshot.connectionState,
        agentState: 'idle',
      }
      emitEvent(context, { type: 'task_completed', summary: `handled: ${input.text}` })
      emitEvent(context, { type: 'agent_idle' })
    }
    return { turnId, sessionId: this.#sessionId }
  }

  async steer(turnId: string, input: AgentInput): Promise<void> {
    this.steered.push({ turnId, input })
    emitEvent(
      { agentId: this.agentId, sessionId: this.#sessionId, turnId },
      { type: 'agent_message', text: `steered: ${input.text}`, delta: false },
    )
  }

  async interrupt(turnId: string): Promise<void> {
    this.interrupted.push(turnId)
    this.#snapshot = {
      processState: this.#snapshot.processState,
      connectionState: this.#snapshot.connectionState,
      agentState: 'interrupted',
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.#snapshot = {
      processState: 'killed',
      connectionState: 'disconnected',
      agentState: 'stopped',
    }
  }

  async detach(): Promise<void> {
    this.detached = true
    this.#snapshot = { ...this.#snapshot, connectionState: 'disconnected' }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [{ agentSessionId: this.#sessionId, title: 'stub session' }]
  }

  async resumeSession(sessionId: AgentSessionId): Promise<void> {
    this.#sessionId = sessionId
    this.#snapshot = { ...this.#snapshot, agentState: 'idle' }
  }

  async forkSession(sessionId: AgentSessionId): Promise<AgentSessionId> {
    return asAgentSessionId(`${sessionId}-fork`)
  }

  async respondToPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.permissionReplies.push({ requestId, decision })
    this.#snapshot = { ...this.#snapshot, agentState: 'working' }
  }

  async driveTerminal(): Promise<void> {}

  // ---- test controls -----------------------------------------------------

  /** Force a state, to drive admission paths the stub would not reach itself. */
  setState(patch: Partial<AgentStatusSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
  }

  /** Complete a held turn and announce idle, so the manager drains its queue. */
  completeHeldTurn(taskRef?: TaskRef): void {
    const turnId = this.#snapshot.activeTurn?.id
    this.#snapshot = {
      processState: this.#snapshot.processState,
      connectionState: this.#snapshot.connectionState,
      agentState: 'idle',
    }
    emitEvent(
      { agentId: this.agentId, sessionId: this.#sessionId, taskRef, turnId },
      { type: 'agent_idle' },
    )
  }
}

/**
 * Build a stub adapter.
 *
 * `adopt` and `reconnect` are only present when the requested capabilities and
 * durability make them meaningful, mirroring how a real adapter omits a method
 * it cannot honour rather than providing one that always rejects.
 */
export function createStubAdapter(options: StubOptions = {}): AgentAdapter {
  const provider = options.provider ?? asProviderId('stub')
  const capabilities: AgentCapabilities = { ...FULL, ...options.capabilities }

  const adapter: AgentAdapter = {
    provider,
    displayName: `Stub (${provider})`,
    capabilityCeiling: capabilities,

    async isAvailable() {
      return true
    },

    async launch(spec: LaunchSpec): Promise<AgentHandle> {
      if (options.failLaunch) {
        throw new Error(`stub launch failure for ${spec.agentId}`)
      }
      logForDebugging(`[StubAdapter] launch ${spec.agentId}`)
      const handle = new StubHandle(spec.agentId, { ...options, provider })
      if (spec.resumeSessionId) {
        await handle.resumeSession(spec.resumeSessionId)
      }
      return handle
    },
  }

  if (options.adoption === 'adoptable') {
    adapter.adopt = async (target: AdoptTarget): Promise<AgentHandle> =>
      new StubHandle(target.agentId, { ...options, provider })
  }
  if ((options.durability ?? 'session-bound') === 'process-durable') {
    adapter.reconnect = async (record): Promise<AgentHandle> =>
      new StubHandle(record.agentInstanceId as AgentInstanceId, {
        ...options,
        provider,
      })
  }
  return adapter
}

/** An adapter that can be observed and attached to, but never sent input. */
export function createObserveOnlyStubAdapter(
  provider = asProviderId('stub-observe'),
): AgentAdapter {
  return createStubAdapter({
    provider,
    capabilities: { ...noCapabilities(), terminal: 'observe' },
    adoption: 'observable',
  })
}

export type { StubHandle }
