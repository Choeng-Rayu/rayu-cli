/**
 * Core vocabulary for the external-agent orchestrator.
 *
 * RAYU drives foreign agentic CLIs (Codex, Claude Code, OpenCode, any
 * ACP-compliant binary). Those CLIs do NOT expose equivalent control surfaces,
 * so this module deliberately refuses to model them as a single uniform
 * interface. Instead:
 *
 *   - **Capabilities are declared, per axis, at a level** (`ControlLevel`).
 *     Callers ask "can this agent do X at least at level Y?" and get an honest
 *     answer before attempting the operation. Nothing here pretends an agent
 *     can steer a turn or be adopted when it cannot.
 *
 *   - **State is four independent axes** (`ProcessState`, `ConnectionState`,
 *     `AgentState`, `ExternalTaskState`). A process can be alive while its
 *     protocol connection is dead, and an agent can be connected and "working"
 *     while its task is actually stalled waiting on an upstream model provider.
 *     Collapsing these into one status field is the single most common source of
 *     bugs in orchestrators, so they are kept separate by construction.
 *
 *   - **Vendor wire formats never reach RAYU core.** Adapters normalize into
 *     `ExternalAgentEvent` and nothing else.
 *
 * Naming note: the external-agent session id is `AgentSessionId`, NOT
 * `SessionId` — `SessionId` in `src/types/ids.ts` already means "this RAYU
 * session" and conflating the two would be a correctness hazard.
 *
 * Conventions note: this file uses string unions plus a rank map rather than a
 * TypeScript `enum`. The codebase contains zero `enum` declarations, and these
 * values are persisted to `~/.rayu/agents/*.json` where a numeric enum member
 * would serialize as an opaque integer.
 */

import type { TaskStatus } from '../../Task.js'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Which kind of foreign agent this is — `codex`, `claude-code`, `opencode`, or
 * a user-registered ACP binary. Branded because a provider id and an instance
 * id are both strings and mixing them up silently addresses the wrong thing.
 */
export type ProviderId = string & { readonly __brand: 'ProviderId' }

/**
 * A single running (or recoverable) agent, e.g. `codex:agent_01`. Two Codex
 * instances working on different tasks are two distinct `AgentInstanceId`s;
 * a provider id alone is never a valid address for an operation.
 */
export type AgentInstanceId = string & { readonly __brand: 'AgentInstanceId' }

/**
 * The foreign agent's OWN conversation identity — a Codex `threadId`, a Claude
 * Code `--session-id` UUID, an OpenCode session id. RAYU stores this verbatim
 * so a restart resumes the real conversation instead of starting a new one.
 */
export type AgentSessionId = string & { readonly __brand: 'AgentSessionId' }

/**
 * Points at a task in RAYU's own task framework (`src/Task.ts`), which is a
 * different thing from the foreign agent's session. One RAYU task may span
 * several foreign turns, and one foreign session may serve several RAYU tasks.
 */
export type TaskRef = string & { readonly __brand: 'TaskRef' }

/** Provider ids with adapters shipped in-tree. Others may be registered by config. */
export const BUILTIN_PROVIDER_IDS = [
  'codex',
  'claude-code',
  'opencode',
  'acp',
] as const

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]

export function asProviderId(id: string): ProviderId {
  return id as ProviderId
}

export function asAgentSessionId(id: string): AgentSessionId {
  return id as AgentSessionId
}

export function asTaskRef(id: string): TaskRef {
  return id as TaskRef
}

/**
 * Compose an instance id as `<provider>:<slot>`.
 *
 * `:` is the separator, so a provider id containing `:` would make ids
 * ambiguous. Callers pass provider ids from the registry, which validates them;
 * this function additionally refuses the ambiguous case rather than emitting an
 * id that cannot be parsed back.
 */
export function formatAgentInstanceId(
  provider: ProviderId,
  slot: string,
): AgentInstanceId {
  if (provider.includes(':')) {
    throw new Error(
      `Provider id may not contain ':' (got ${JSON.stringify(provider)}) — ':' separates provider from slot in an agent instance id.`,
    )
  }
  return `${provider}:${slot}` as AgentInstanceId
}

/** Split `<provider>:<slot>`. Returns null when the input is not an instance id. */
export function parseAgentInstanceId(
  id: string,
): { provider: ProviderId; slot: string } | null {
  const sep = id.indexOf(':')
  if (sep <= 0 || sep === id.length - 1) {
    return null
  }
  return {
    provider: id.slice(0, sep) as ProviderId,
    slot: id.slice(sep + 1),
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * How much control RAYU has over one axis of an agent.
 *
 * Ordered ladder — each level includes everything below it:
 *   `none`    RAYU cannot touch this axis at all.
 *   `observe` RAYU can watch but not act (read a transcript, tail output).
 *   `message` RAYU can send input and read replies, but not manipulate
 *             in-flight work (no steer of a running turn, no fork).
 *   `full`    RAYU has the complete surface the axis implies.
 */
export type ControlLevel = 'none' | 'observe' | 'message' | 'full'

const CONTROL_LEVEL_RANK: Record<ControlLevel, number> = {
  none: 0,
  observe: 1,
  message: 2,
  full: 3,
}

/** Total order over `ControlLevel`, for sorting and comparison. */
export function compareControlLevel(a: ControlLevel, b: ControlLevel): number {
  return CONTROL_LEVEL_RANK[a] - CONTROL_LEVEL_RANK[b]
}

/** True when `actual` meets or exceeds `required`. */
export function atLeastControlLevel(
  actual: ControlLevel,
  required: ControlLevel,
): boolean {
  return CONTROL_LEVEL_RANK[actual] >= CONTROL_LEVEL_RANK[required]
}

/**
 * The axes RAYU negotiates. Kept deliberately small — an axis exists only when
 * some caller must branch on it.
 *
 *   `terminal`    Can RAYU show/drive the agent's real terminal UI?
 *   `messages`    Can RAYU send prompts, and can it steer an in-flight turn?
 *   `sessions`    Can RAYU enumerate / resume / fork the agent's own sessions?
 *   `process`     Can RAYU manage the OS process (spawn, signal, kill)?
 *   `permissions` Can the agent route its approval prompts back to RAYU?
 */
export type CapabilityAxis =
  | 'terminal'
  | 'messages'
  | 'sessions'
  | 'process'
  | 'permissions'

export const CAPABILITY_AXES = [
  'terminal',
  'messages',
  'sessions',
  'process',
  'permissions',
] as const

export type AgentCapabilities = Readonly<Record<CapabilityAxis, ControlLevel>>

/** Every axis at `none` — the safe default for an unidentified agent. */
export function noCapabilities(): AgentCapabilities {
  return {
    terminal: 'none',
    messages: 'none',
    sessions: 'none',
    process: 'none',
    permissions: 'none',
  }
}

/**
 * Named operations, each mapped to the axis and minimum level it needs.
 *
 * Centralizing this is what lets `assertCapability` produce an actionable error
 * ("steer requires messages:full, codex:agent_01 has messages:message") instead
 * of a downstream protocol failure whose cause is unrecoverable from the stack.
 */
export const OPERATION_REQUIREMENTS = {
  sendMessage: { axis: 'messages', level: 'message' },
  steer: { axis: 'messages', level: 'full' },
  interrupt: { axis: 'process', level: 'message' },
  kill: { axis: 'process', level: 'full' },
  listSessions: { axis: 'sessions', level: 'observe' },
  resumeSession: { axis: 'sessions', level: 'message' },
  forkSession: { axis: 'sessions', level: 'full' },
  observeTerminal: { axis: 'terminal', level: 'observe' },
  attachTerminal: { axis: 'terminal', level: 'observe' },
  driveTerminal: { axis: 'terminal', level: 'full' },
  brokerPermissions: { axis: 'permissions', level: 'message' },
} as const satisfies Record<
  string,
  { axis: CapabilityAxis; level: ControlLevel }
>

export type AgentOperation = keyof typeof OPERATION_REQUIREMENTS

/** True when `caps` permit `op`. The single source of truth for gating. */
export function supportsOperation(
  caps: AgentCapabilities,
  op: AgentOperation,
): boolean {
  const req = OPERATION_REQUIREMENTS[op]
  return atLeastControlLevel(caps[req.axis], req.level)
}

// ---------------------------------------------------------------------------
// Adoption + durability
// ---------------------------------------------------------------------------

/**
 * How RAYU relates to an instance it found. This exists so the UI can be
 * truthful: RAYU cannot inject input into a foreign full-screen TUI that it did
 * not launch unless that agent exposes a control surface.
 *
 *   `managed`    RAYU launched it and holds its control channel.
 *   `adoptable`  Not launched by RAYU, but exposes a usable control protocol
 *                (Codex control socket, OpenCode HTTP server).
 *   `observable` Detected and possibly attachable, but NOT controllable
 *                (a bare `claude` TUI in another terminal).
 *   `unknown`    A process was detected but its protocol/session cannot be
 *                safely identified; RAYU must not guess.
 */
export type AdoptionClass = 'managed' | 'adoptable' | 'observable' | 'unknown'

/**
 * Whether the agent survives RAYU exiting.
 *
 *   `session-bound`   The control channel is a stdio pipe owned by this RAYU
 *                     process; the agent dies when RAYU does. Recovery is
 *                     relaunch-and-resume using the persisted native session id.
 *   `process-durable` The control channel is a socket or HTTP endpoint, or the
 *                     process is tmux-hosted; it outlives RAYU and can be
 *                     reconnected to.
 */
export type Durability = 'session-bound' | 'process-durable'

// ---------------------------------------------------------------------------
// State — four independent axes
// ---------------------------------------------------------------------------

/** The OS process. `absent` = adopted or remote agent with no local pid. */
export type ProcessState =
  | 'spawning'
  | 'running'
  | 'exited'
  | 'killed'
  | 'absent'

/** The protocol channel. Independent of whether the process is alive. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'lost'

/**
 * The agent's own lifecycle, as RAYU understands it.
 *
 * `waiting` means the agent is blocked on something outside RAYU (an approval
 * it raised, an upstream provider) and is distinct from `idle`, which means it
 * is healthy and ready for work.
 */
export type AgentState =
  | 'starting'
  | 'connecting'
  | 'ready'
  | 'working'
  | 'idle'
  | 'waiting'
  | 'interrupted'
  | 'failed'
  | 'dead'
  | 'stopped'

/** Terminal agent states — no further transition will occur unaided. */
export function isTerminalAgentState(state: AgentState): boolean {
  return state === 'dead' || state === 'stopped' || state === 'failed'
}

/** True when the agent is healthy enough to accept new work right now. */
export function isDispatchableAgentState(state: AgentState): boolean {
  return state === 'ready' || state === 'idle'
}

/**
 * A RAYU orchestration task's state. Deliberately richer than RAYU's own
 * `TaskStatus`: `queued` (admission control deferred it) and `waiting-provider`
 * (the agent is alive but its model backend is unavailable) are states the
 * generic task framework has no word for, and both are actionable for the user.
 */
export type ExternalTaskState =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting-provider'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Project the richer external task state onto RAYU's `TaskStatus` so external
 * agent work shows up in the standard background-task indicator and
 * `<task_notification>` plumbing.
 *
 * `waiting-provider` maps to `running` on purpose: the task is not finished and
 * must not be evicted. The precise reason stays visible on the task state.
 */
export function toRayuTaskStatus(state: ExternalTaskState): TaskStatus {
  switch (state) {
    case 'queued':
      return 'pending'
    case 'dispatched':
    case 'running':
    case 'waiting-provider':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'killed'
  }
}

/**
 * The kind of turn currently in flight. Needed because Codex documents that
 * review turns and manual compaction turns REJECT `turn/steer`; sending one
 * anyway is a protocol error, so admission control has to know the turn kind
 * and not merely that a turn exists.
 */
export type TurnKind = 'regular' | 'review' | 'compaction' | 'shell' | 'unknown'

/** True when a turn of this kind accepts same-turn steering. */
export function isSteerableTurnKind(kind: TurnKind): boolean {
  return kind === 'regular'
}

/** The full four-axis snapshot for one agent instance. */
export type AgentStatusSnapshot = {
  readonly processState: ProcessState
  readonly connectionState: ConnectionState
  readonly agentState: AgentState
  /** The turn in flight, when the agent is `working`. */
  readonly activeTurn?: { readonly id: string; readonly kind: TurnKind }
}

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

/**
 * Envelope shared by every normalized event.
 *
 * `seq` is monotonic per agent instance so consumers can detect gaps and order
 * events that share a millisecond timestamp.
 */
export type ExternalAgentEventBase = {
  readonly agentId: AgentInstanceId
  readonly sessionId?: AgentSessionId
  readonly taskRef?: TaskRef
  readonly turnId?: string
  /** Unix epoch milliseconds. */
  readonly at: number
  readonly seq: number
}

export type AgentStartedEvent = ExternalAgentEventBase & {
  readonly type: 'agent_started'
  readonly provider: ProviderId
  readonly adoption: AdoptionClass
  readonly capabilities: AgentCapabilities
}

/** Assistant-visible prose from the agent. `delta` = incremental chunk. */
export type AgentMessageEvent = ExternalAgentEventBase & {
  readonly type: 'agent_message'
  readonly text: string
  readonly delta: boolean
}

/** Reasoning/thinking output, kept separate so it can be styled or suppressed. */
export type AgentThinkingEvent = ExternalAgentEventBase & {
  readonly type: 'agent_thinking'
  readonly text: string
  readonly delta: boolean
}

export type ToolStartedEvent = ExternalAgentEventBase & {
  readonly type: 'tool_started'
  /** Adapter-stable id so `tool_output` can be correlated to its tool call. */
  readonly callId: string
  readonly toolName: string
  /** Display-safe summary. Adapters MUST NOT put credentials here. */
  readonly summary?: string
}

export type ToolOutputEvent = ExternalAgentEventBase & {
  readonly type: 'tool_output'
  readonly callId: string
  readonly chunk: string
  readonly stream: 'stdout' | 'stderr'
}

export type FileChangedEvent = ExternalAgentEventBase & {
  readonly type: 'file_changed'
  readonly path: string
  readonly change: 'created' | 'modified' | 'deleted' | 'renamed'
  /** Unified diff when the protocol supplies one. */
  readonly diff?: string
}

/**
 * The agent is blocked asking permission. `requestId` is the adapter's handle
 * for replying; the Permission Broker echoes it back verbatim.
 */
export type PermissionRequestedEvent = ExternalAgentEventBase & {
  readonly type: 'permission_requested'
  readonly requestId: string
  readonly kind: 'command' | 'file_change' | 'network' | 'tool' | 'other'
  readonly description: string
  readonly cwd?: string
}

export type TaskCompletedEvent = ExternalAgentEventBase & {
  readonly type: 'task_completed'
  readonly summary?: string
}

export type TaskFailedEvent = ExternalAgentEventBase & {
  readonly type: 'task_failed'
  readonly message: string
  /** Provider-specific classifier, passed through for diagnosis. */
  readonly code?: string
}

/** The agent finished its turn and is ready for more work. */
export type AgentIdleEvent = ExternalAgentEventBase & {
  readonly type: 'agent_idle'
}

/** A non-fatal error. The agent may still be usable. */
export type AgentErrorEvent = ExternalAgentEventBase & {
  readonly type: 'agent_error'
  readonly message: string
  readonly code?: string
  /** True when the upstream model provider is the cause, not the agent. */
  readonly providerFault?: boolean
}

/** The control channel dropped. Says nothing about whether the process lives. */
export type AgentDisconnectedEvent = ExternalAgentEventBase & {
  readonly type: 'agent_disconnected'
  readonly reason: 'process_exit' | 'protocol_disconnect' | 'shutdown'
  readonly exitCode?: number
}

export type ExternalAgentEvent =
  | AgentStartedEvent
  | AgentMessageEvent
  | AgentThinkingEvent
  | ToolStartedEvent
  | ToolOutputEvent
  | FileChangedEvent
  | PermissionRequestedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | AgentIdleEvent
  | AgentErrorEvent
  | AgentDisconnectedEvent

export type ExternalAgentEventType = ExternalAgentEvent['type']

/**
 * Event types that mean "this agent will produce nothing further without
 * intervention". Used by the recovery path to decide when to act.
 */
export function isTerminalEventType(type: ExternalAgentEventType): boolean {
  return (
    type === 'task_completed' ||
    type === 'task_failed' ||
    type === 'agent_disconnected'
  )
}
