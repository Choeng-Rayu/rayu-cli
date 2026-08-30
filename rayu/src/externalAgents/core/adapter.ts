/**
 * The contract every provider adapter implements.
 *
 * ## Optional methods are the whole point
 *
 * This is deliberately **not** a fixed set of mandatory methods. Claude Code
 * cannot be adopted; a bare `claude` TUI cannot receive input at all; OpenCode
 * can drive its own live TUI; Codex can steer an in-flight turn but only for
 * certain turn kinds. A uniform interface would force every adapter to stub
 * operations it cannot perform, and stubs either lie (silently no-op) or throw
 * at the worst possible moment (mid-task).
 *
 * So: an operation's method is **optional**, and `capabilities` declares what is
 * actually available. `AgentManager` checks the declaration before dispatching,
 * so an unsupported operation fails immediately with an actionable message
 * rather than as a protocol error later.
 *
 * The two must agree. An adapter that declares `messages: 'full'` without a
 * `steer` method is a RAYU bug, and `AgentManager` raises
 * `AdapterInvariantError` rather than quietly degrading — a declared level has
 * to be trustworthy or the capability model is worthless.
 *
 * ## Adapters own their connection, not their bookkeeping
 *
 * An adapter's job is: speak the wire protocol, and translate both directions.
 * It does **not** own task records, admission decisions, permission routing or
 * persistence — `AgentManager` does. This keeps provider-specific code small
 * enough to audit against the vendor's protocol docs.
 */

import type { AgentRecord, AgentTransport } from '../persistence/schemas.js'
import type {
  AdoptionClass,
  AgentCapabilities,
  AgentInstanceId,
  AgentSessionId,
  AgentStatusSnapshot,
  Durability,
  ProviderId,
  TaskRef,
} from './types.js'

/** What the user wants to send. Text-only for v1; images are provider-specific. */
export type AgentInput = {
  readonly text: string
}

/** Everything an adapter needs to start a fresh instance. */
export type LaunchSpec = {
  readonly agentId: AgentInstanceId
  readonly cwd: string
  /** Provider-native model id, when the user pinned one. */
  readonly model?: string
  /**
   * Resume this native session instead of starting a new conversation. Set by
   * the recovery path so a relaunch continues rather than restarts.
   */
  readonly resumeSessionId?: AgentSessionId
  /** Extra env for the child. Adapters pass this explicitly, never `process.env`. */
  readonly env?: Readonly<Record<string, string>>
  /** Host the agent's real TUI in this tmux session, when the adapter supports it. */
  readonly tmuxSession?: string
}

/** How to reach an instance RAYU did not launch. */
export type AdoptTarget = {
  readonly agentId: AgentInstanceId
  readonly transport: AgentTransport
  readonly cwd: string
  /** Pid when discovery established one; absent for remote/HTTP agents. */
  readonly pid?: number
}

/** Result of dispatching input — the turn the adapter opened. */
export type DispatchResult = {
  readonly turnId: string
  readonly sessionId: AgentSessionId
}

export type SessionSummary = {
  readonly agentSessionId: AgentSessionId
  readonly title?: string
  readonly updatedAt?: number
}

/** How a permission request was answered, in provider-neutral terms. */
export type PermissionDecision =
  | 'accept'
  | 'accept-for-session'
  | 'decline'
  | 'cancel'

/**
 * A live connection to one agent instance.
 *
 * Methods are optional exactly where the corresponding capability is optional.
 * `AgentManager` gates on `capabilities` and never calls a method it has not
 * verified is both declared and present.
 */
export type AgentHandle = {
  readonly agentId: AgentInstanceId
  readonly provider: ProviderId

  /** Effective capabilities for *this instance* — may be lower than the
   * adapter's ceiling (an adopted instance often exposes less than a launched
   * one). This is the value `AgentManager` gates on. */
  readonly capabilities: AgentCapabilities
  readonly durability: Durability
  readonly adoption: AdoptionClass
  readonly transport: AgentTransport
  /** Absent for adopted remote agents whose pid RAYU never learns. */
  readonly pid?: number
  /** tmux session hosting the agent's real TUI, when one exists. */
  readonly tmuxSession?: string

  /** Current four-axis state. Cheap and synchronous — adapters cache it. */
  status(): AgentStatusSnapshot

  /** The native session currently in use, once established. */
  activeSessionId(): AgentSessionId | undefined

  /**
   * Send input as a new turn. Requires `messages >= 'message'`.
   *
   * `taskRef` is attached to every event this turn produces so the orchestrator
   * can attribute output without the adapter knowing what a RAYU task is.
   */
  send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult>

  /** Inject into an in-flight turn. Requires `messages: 'full'`. */
  steer?(turnId: string, input: AgentInput): Promise<void>

  /** Cancel an in-flight turn. Requires `process >= 'message'`. */
  interrupt?(turnId: string): Promise<void>

  /** Terminate the agent. Requires `process: 'full'`. */
  stop(): Promise<void>

  /**
   * Detach without terminating. Used for `process-durable` agents on RAYU exit,
   * so the agent keeps running and can be reconnected to.
   */
  detach(): Promise<void>

  listSessions?(): Promise<SessionSummary[]>
  resumeSession?(sessionId: AgentSessionId): Promise<void>
  forkSession?(sessionId: AgentSessionId): Promise<AgentSessionId>

  /** Answer a `permission_requested` event. Requires `permissions >= 'message'`. */
  respondToPermission?(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>

  /** Type text into the agent's own TUI. Requires `terminal: 'full'`. */
  driveTerminal?(text: string, submit: boolean): Promise<void>
}

/**
 * A provider adapter — the factory for handles.
 *
 * `launch` is mandatory. `reconnect` and `adopt` are optional because not every
 * provider supports them: Claude Code exposes no listener, so it can be neither
 * reconnected to nor adopted, and saying so through a missing method is more
 * honest than a method that always rejects.
 */
export type AgentAdapter = {
  readonly provider: ProviderId
  /** Shown in `/agent list` and `/agent discover`. */
  readonly displayName: string

  /**
   * The best capabilities this adapter can offer, before a specific instance is
   * known. Used by `/agent discover` to describe a provider that is installed
   * but not running. A live handle may report less.
   */
  readonly capabilityCeiling: AgentCapabilities

  /** True when the provider's CLI appears usable on this machine. */
  isAvailable(): Promise<boolean>

  launch(spec: LaunchSpec): Promise<AgentHandle>

  /** Re-establish a control channel to a `process-durable` instance. */
  reconnect?(record: AgentRecord): Promise<AgentHandle>

  /** Attach to an instance RAYU did not launch. */
  adopt?(target: AdoptTarget): Promise<AgentHandle>
}
