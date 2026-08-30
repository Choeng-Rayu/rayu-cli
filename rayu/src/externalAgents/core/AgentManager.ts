/**
 * The single front door for every external-agent operation.
 *
 * Both entry points — `/agent …` commands and the model-facing `ExternalAgent`
 * tool — route through here. That is deliberate: if the tool had its own path it
 * would eventually diverge on admission control, permission routing or
 * persistence, and the model would be able to do things the user could not (or
 * worse, bypass a safety check the commands enforce).
 *
 * What this module owns:
 *
 *   - **Agent registry** — live handles, plus slot allocation for instance ids.
 *   - **Session registry** — the foreign agents' own session ids, persisted so a
 *     relaunch resumes rather than restarts.
 *   - **Capability gating** — `assertCapability` refuses before any protocol
 *     call, naming the shortfall.
 *   - **Admission** — every dispatch consults `resolveAdmission`; nothing is
 *     ever sent blind.
 *   - **Queueing** — work admitted as `queue` is held and drained when the agent
 *     reports idle, so a busy agent is never clobbered and the request is not
 *     silently dropped either.
 *   - **Persistence sync** — records stay current so a crash is recoverable.
 *
 * What it does not own: wire protocols (adapters), permission UI (Task 11),
 * worktrees (Task 12), terminal attach (Task 10).
 */

import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  patchAgentRecord,
  readAgentRecord,
  readAgentSessions,
  registerAgentExitCleanup,
  writeAgentRecord,
  writeAgentSessions,
  listAgentRecords,
} from '../persistence/agentStore.js'
import type { AgentRecord } from '../persistence/schemas.js'
import type {
  AdoptTarget,
  AgentHandle,
  AgentInput,
  LaunchSpec,
  PermissionDecision,
  SessionSummary,
} from './adapter.js'
import { getAdapter } from './adapterRegistry.js'
import { currentSeq, subscribeToEvents } from './eventBus.js'
import {
  AdapterInvariantError,
  AdmissionError,
  CapabilityError,
  UnknownAgentError,
} from './errors.js'
import { emitEvent } from './normalizer.js'
import {
  type AdmissionAction,
  type AdmissionRequest,
  resolveAdmission,
} from './stateMachine.js'
import {
  type AgentInstanceId,
  type AgentOperation,
  type AgentSessionId,
  formatAgentInstanceId,
  OPERATION_REQUIREMENTS,
  type ProviderId,
  supportsOperation,
  type TaskRef,
} from './types.js'

/**
 * Which `AgentHandle` method each operation needs.
 *
 * Kept beside `OPERATION_REQUIREMENTS` so a declared capability and an
 * implemented method can be cross-checked. Operations with no handle method
 * (terminal observe/attach, handled by the Terminal Manager) map to null.
 */
const OPERATION_METHODS: Readonly<
  Record<AgentOperation, keyof AgentHandle | null>
> = {
  sendMessage: 'send',
  steer: 'steer',
  interrupt: 'interrupt',
  kill: 'stop',
  listSessions: 'listSessions',
  resumeSession: 'resumeSession',
  forkSession: 'forkSession',
  observeTerminal: null,
  attachTerminal: null,
  driveTerminal: 'driveTerminal',
  brokerPermissions: 'respondToPermission',
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const liveAgents = new Map<AgentInstanceId, AgentHandle>()
const exitCleanups = new Map<AgentInstanceId, () => void>()

type QueuedInput = {
  readonly input: AgentInput
  readonly taskRef?: TaskRef
  readonly preferSteer: boolean
}

/** Inputs admitted as `queue`, awaiting the agent going idle. */
const pendingByAgent = new Map<AgentInstanceId, QueuedInput[]>()

let drainSubscription: (() => void) | undefined

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

/**
 * Refuse an operation the agent cannot perform, before touching the wire.
 *
 * Two failure modes, deliberately distinguished:
 *   - the capability is below what the operation needs -> `CapabilityError`,
 *     user-facing and actionable.
 *   - the capability is sufficient but the adapter has no such method ->
 *     `AdapterInvariantError`, a RAYU bug. Not degraded silently, because the
 *     value of the capability model is that a declared level can be trusted.
 */
export function assertCapability(
  handle: AgentHandle,
  operation: AgentOperation,
): void {
  const requirement = OPERATION_REQUIREMENTS[operation]
  if (!supportsOperation(handle.capabilities, operation)) {
    throw new CapabilityError({
      agentId: handle.agentId,
      operation,
      axis: requirement.axis,
      required: requirement.level,
      actual: handle.capabilities[requirement.axis],
    })
  }
  const method = OPERATION_METHODS[operation]
  if (method !== null && typeof handle[method] !== 'function') {
    throw new AdapterInvariantError(
      handle.provider,
      `declares ${requirement.axis}='${handle.capabilities[requirement.axis]}' ` +
        `(enough for ${operation}) but implements no '${String(method)}' method`,
    )
  }
}

/** Non-throwing capability probe, for rendering `/agent inspect`. */
export function canPerform(
  handle: AgentHandle,
  operation: AgentOperation,
): boolean {
  const method = OPERATION_METHODS[operation]
  return (
    supportsOperation(handle.capabilities, operation) &&
    (method === null || typeof handle[method] === 'function')
  )
}

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

export function listLiveAgents(): AgentHandle[] {
  return [...liveAgents.values()]
}

export function findLiveAgent(
  agentId: AgentInstanceId,
): AgentHandle | undefined {
  return liveAgents.get(agentId)
}

/** Look up a live handle, or throw listing what is running. */
export function getLiveAgent(agentId: AgentInstanceId): AgentHandle {
  const handle = liveAgents.get(agentId)
  if (!handle) {
    throw new UnknownAgentError(agentId, [...liveAgents.keys()])
  }
  return handle
}

/**
 * Allocate the lowest free `agent_NN` slot for a provider.
 *
 * Considers persisted records as well as live handles: reusing a slot whose
 * record still exists would silently inherit another agent's session history and
 * crash forensics.
 */
export async function allocateAgentId(
  provider: ProviderId,
): Promise<AgentInstanceId> {
  const { records } = await listAgentRecords()
  const taken = new Set<string>([
    ...records
      .filter(record => record.provider === provider)
      .map(record => record.slot),
    ...[...liveAgents.keys()]
      .filter(id => id.startsWith(`${provider}:`))
      .map(id => id.slice(provider.length + 1)),
  ])
  for (let n = 1; n < 1000; n++) {
    const slot = `agent_${String(n).padStart(2, '0')}`
    if (!taken.has(slot)) return formatAgentInstanceId(provider, slot)
  }
  throw new Error(
    `Cannot allocate a slot for provider '${provider}': 999 slots in use. Prune old agents with '/agent stop'.`,
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Persist a handle's current state so a crash is recoverable. */
async function syncRecord(handle: AgentHandle): Promise<void> {
  const snapshot = handle.status()
  const sessionId = handle.activeSessionId()
  const existing = await readAgentRecord(handle.agentId)
  const patch = {
    processState: snapshot.processState,
    connectionState: snapshot.connectionState,
    agentState: snapshot.agentState,
    activeTurn: snapshot.activeTurn,
    pid: handle.pid,
    tmuxSession: handle.tmuxSession,
    lastEventSeq: currentSeq(handle.agentId),
  }
  if (existing.status === 'ok') {
    await patchAgentRecord(handle.agentId, patch)
  } else {
    await writeAgentRecord({
      agentInstanceId: handle.agentId,
      provider: handle.provider,
      adoption: handle.adoption,
      durability: handle.durability,
      capabilities: handle.capabilities,
      transport: handle.transport,
      cwd: process.cwd(),
      ...patch,
    })
  }
  if (sessionId) {
    await recordSession(handle.agentId, sessionId)
  }
}

/** Register a handle, wire its exit cleanup, and persist it. */
async function adoptHandle(handle: AgentHandle): Promise<AgentHandle> {
  liveAgents.set(handle.agentId, handle)
  ensureDrainSubscription()

  // A session-bound agent dies with this RAYU process, so its record must be
  // marked stopped on exit. A process-durable one keeps running, so we detach
  // instead and leave the record reconnectable.
  if (handle.durability === 'session-bound') {
    exitCleanups.set(handle.agentId, registerAgentExitCleanup(handle.agentId))
  }

  await syncRecord(handle)
  emitEvent(
    { agentId: handle.agentId, sessionId: handle.activeSessionId() },
    {
      type: 'agent_started',
      provider: handle.provider,
      adoption: handle.adoption,
      capabilities: handle.capabilities,
    },
  )
  return handle
}

/** Launch a new instance of `provider`. */
export async function startAgent(params: {
  provider: ProviderId
  cwd: string
  model?: string
  resumeSessionId?: AgentSessionId
  env?: Record<string, string>
  tmuxSession?: string
  agentId?: AgentInstanceId
}): Promise<AgentHandle> {
  const adapter = getAdapter(params.provider)
  const agentId = params.agentId ?? (await allocateAgentId(params.provider))
  const spec: LaunchSpec = {
    agentId,
    cwd: params.cwd,
    model: params.model,
    resumeSessionId: params.resumeSessionId,
    env: params.env,
    tmuxSession: params.tmuxSession,
  }
  logForDebugging(`[AgentManager] launching ${agentId}`)
  return adoptHandle(await adapter.launch(spec))
}

/** Attach to an instance RAYU did not launch. */
export async function adoptAgent(target: AdoptTarget): Promise<AgentHandle> {
  const provider = providerOf(target.agentId)
  const adapter = getAdapter(provider)
  if (!adapter.adopt) {
    throw new CapabilityError({
      agentId: target.agentId,
      operation: 'sendMessage',
      axis: 'messages',
      required: 'message',
      actual: 'none',
    })
  }
  logForDebugging(`[AgentManager] adopting ${target.agentId}`)
  return adoptHandle(await adapter.adopt(target))
}

/** Re-establish a control channel to a persisted `process-durable` instance. */
export async function reconnectAgent(
  agentId: AgentInstanceId,
): Promise<AgentHandle> {
  const existing = liveAgents.get(agentId)
  if (existing) return existing

  const record = await readAgentRecord(agentId)
  if (record.status !== 'ok') {
    throw new UnknownAgentError(agentId, [...liveAgents.keys()])
  }
  const adapter = getAdapter(record.record.provider as ProviderId)
  if (!adapter.reconnect) {
    throw new AdapterInvariantError(
      adapter.provider,
      `record declares durability='${record.record.durability}' but the adapter implements no 'reconnect'`,
    )
  }
  logForDebugging(`[AgentManager] reconnecting ${agentId}`)
  return adoptHandle(await adapter.reconnect(record.record))
}

/** Stop an agent and remove it from the registry. */
export async function stopAgent(agentId: AgentInstanceId): Promise<void> {
  const handle = getLiveAgent(agentId)
  assertCapability(handle, 'kill')
  try {
    await handle.stop()
  } finally {
    await releaseAgent(agentId, 'stopped')
  }
}

/**
 * Detach every live agent without stopping the durable ones.
 *
 * Called on RAYU exit. `session-bound` agents cannot survive, so they are
 * stopped; `process-durable` ones keep running and stay reconnectable, which is
 * the whole point of the durability distinction.
 */
export async function detachAllAgents(): Promise<void> {
  await Promise.all(
    listLiveAgents().map(async handle => {
      try {
        if (handle.durability === 'process-durable') {
          await handle.detach()
          await patchAgentRecord(handle.agentId, {
            connectionState: 'disconnected',
          })
        } else if (canPerform(handle, 'kill')) {
          await handle.stop()
        }
      } catch (e) {
        logForDebugging(
          `[AgentManager] detach failed for ${handle.agentId}: ${errorMessage(e)}`,
        )
      }
    }),
  )
  liveAgents.clear()
  pendingByAgent.clear()
}

async function releaseAgent(
  agentId: AgentInstanceId,
  finalState: 'stopped' | 'dead',
): Promise<void> {
  liveAgents.delete(agentId)
  pendingByAgent.delete(agentId)
  exitCleanups.get(agentId)?.()
  exitCleanups.delete(agentId)
  await patchAgentRecord(agentId, {
    agentState: finalState,
    connectionState: 'disconnected',
    activeTurn: undefined,
  })
}

function providerOf(agentId: AgentInstanceId): ProviderId {
  const sep = agentId.indexOf(':')
  return agentId.slice(0, sep) as ProviderId
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type AssignOutcome = {
  readonly action: AdmissionAction
  readonly reason: string
  /** Set when the input actually went to the agent. */
  readonly turnId?: string
  readonly sessionId?: AgentSessionId
  /** Position in the pending queue, when `action` is `queue`. */
  readonly queuePosition?: number
}

/**
 * Send input to an agent, honouring admission control.
 *
 * Returns what actually happened rather than pretending every send is a
 * dispatch — a caller that queued needs to say so, and one that was rejected
 * needs the reason. Only `reject` throws, because that is the one outcome the
 * caller cannot proceed from.
 */
export async function assign(
  agentId: AgentInstanceId,
  input: AgentInput,
  options: { taskRef?: TaskRef; preferSteer?: boolean } = {},
): Promise<AssignOutcome> {
  const handle = getLiveAgent(agentId)
  assertCapability(handle, 'sendMessage')

  const request: AdmissionRequest = {
    intent: 'send',
    preferSteer: options.preferSteer,
  }
  const decision = resolveAdmission(
    handle.status(),
    handle.capabilities,
    request,
  )

  switch (decision.action) {
    case 'reject':
      throw new AdmissionError(agentId, decision)

    case 'dispatch': {
      const result = await handle.send(input, options.taskRef)
      await syncRecord(handle)
      return { ...decision, turnId: result.turnId, sessionId: result.sessionId }
    }

    case 'steer': {
      assertCapability(handle, 'steer')
      const turnId = handle.status().activeTurn?.id
      if (!turnId) {
        // Lost the turn between admission and here. Queue rather than guess.
        return enqueue(agentId, input, options, {
          action: 'queue',
          reason:
            'Active turn ended while preparing to steer; queued for the next turn.',
        })
      }
      await handle.steer!(turnId, input)
      await syncRecord(handle)
      return { ...decision, turnId }
    }

    case 'queue':
    case 'resume':
    case 'relaunch':
      // `resume` and `relaunch` need work the caller must decide to do (Task 16
      // owns recovery). Holding the input means the request is not lost, and the
      // outcome tells the caller what has to happen first.
      return enqueue(agentId, input, options, decision)
  }
}

function enqueue(
  agentId: AgentInstanceId,
  input: AgentInput,
  options: { taskRef?: TaskRef; preferSteer?: boolean },
  decision: { action: AdmissionAction; reason: string },
): AssignOutcome {
  const queue = pendingByAgent.get(agentId) ?? []
  queue.push({
    input,
    taskRef: options.taskRef,
    preferSteer: options.preferSteer ?? false,
  })
  pendingByAgent.set(agentId, queue)
  return { ...decision, queuePosition: queue.length }
}

/** Cancel the agent's in-flight turn. */
export async function interruptAgent(
  agentId: AgentInstanceId,
): Promise<AssignOutcome> {
  const handle = getLiveAgent(agentId)
  assertCapability(handle, 'interrupt')
  const decision = resolveAdmission(handle.status(), handle.capabilities, {
    intent: 'interrupt',
  })
  if (decision.action === 'reject') {
    throw new AdmissionError(agentId, decision)
  }
  const turnId = handle.status().activeTurn?.id
  if (!turnId) {
    throw new AdmissionError(agentId, {
      action: 'reject',
      reason: 'No active turn id is known, so there is nothing to interrupt.',
    })
  }
  await handle.interrupt!(turnId)
  await syncRecord(handle)
  return { action: 'dispatch', reason: decision.reason, turnId }
}

export function pendingCount(agentId: AgentInstanceId): number {
  return pendingByAgent.get(agentId)?.length ?? 0
}

/**
 * Drain queued input when an agent reports it is free.
 *
 * Subscribed once, lazily. Without this, work admitted as `queue` would sit
 * forever — a silent drop that looks identical to a hung agent.
 */
function ensureDrainSubscription(): void {
  if (drainSubscription) return
  drainSubscription = subscribeToEvents(event => {
    if (event.type !== 'agent_idle' && event.type !== 'task_completed') return
    void drainPending(event.agentId)
  })
}

async function drainPending(agentId: AgentInstanceId): Promise<void> {
  const queue = pendingByAgent.get(agentId)
  const handle = liveAgents.get(agentId)
  if (!queue || queue.length === 0 || !handle) return

  const decision = resolveAdmission(handle.status(), handle.capabilities, {
    intent: 'send',
  })
  if (decision.action !== 'dispatch') return

  const next = queue.shift()!
  if (queue.length === 0) pendingByAgent.delete(agentId)
  try {
    await handle.send(next.input, next.taskRef)
    await syncRecord(handle)
  } catch (e) {
    logForDebugging(
      `[AgentManager] draining queued input for ${agentId} failed: ${errorMessage(e)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Record a native session id, keeping it as the active one.
 *
 * Stored verbatim: resuming with the real Codex `threadId` or Claude Code
 * `--session-id` is what separates continuing a conversation from silently
 * starting a fresh one with no history.
 */
export async function recordSession(
  agentId: AgentInstanceId,
  sessionId: AgentSessionId,
  title?: string,
): Promise<void> {
  const existing = await readAgentSessions(agentId)
  const now = Date.now()
  const sessions =
    existing.status === 'ok' ? [...existing.record.sessions] : []
  const index = sessions.findIndex(s => s.agentSessionId === sessionId)
  if (index >= 0) {
    sessions[index] = { ...sessions[index]!, lastUsedAt: now, title: title ?? sessions[index]!.title }
  } else {
    sessions.push({ agentSessionId: sessionId, title, createdAt: now, lastUsedAt: now })
  }
  await writeAgentSessions(agentId, { activeSessionId: sessionId, sessions })
}

/** Native sessions RAYU knows about for an agent, newest first. */
export async function listRecordedSessions(
  agentId: AgentInstanceId,
): Promise<SessionSummary[]> {
  const record = await readAgentSessions(agentId)
  if (record.status !== 'ok') return []
  return [...record.record.sessions]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map(s => ({
      agentSessionId: s.agentSessionId as AgentSessionId,
      title: s.title,
      updatedAt: s.lastUsedAt,
    }))
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export type AgentInspection = {
  readonly agentId: AgentInstanceId
  readonly provider: ProviderId
  readonly adoption: string
  readonly durability: string
  readonly status: ReturnType<AgentHandle['status']>
  readonly capabilities: AgentHandle['capabilities']
  /** Per-operation truth, accounting for both declaration and implementation. */
  readonly operations: Readonly<Record<AgentOperation, boolean>>
  readonly activeSessionId?: AgentSessionId
  readonly pendingInputs: number
  readonly pid?: number
  readonly tmuxSession?: string
  readonly record?: AgentRecord
}

/**
 * Everything `/agent inspect` needs, including the honest per-operation matrix.
 *
 * `operations` is computed from capabilities *and* method presence, so what the
 * UI shows is exactly what the manager would allow — the two cannot drift.
 */
export async function inspectAgent(
  agentId: AgentInstanceId,
): Promise<AgentInspection> {
  const handle = getLiveAgent(agentId)
  const operations = {} as Record<AgentOperation, boolean>
  for (const operation of Object.keys(OPERATION_REQUIREMENTS) as AgentOperation[]) {
    operations[operation] = canPerform(handle, operation)
  }
  const record = await readAgentRecord(agentId)
  return {
    agentId,
    provider: handle.provider,
    adoption: handle.adoption,
    durability: handle.durability,
    status: handle.status(),
    capabilities: handle.capabilities,
    operations,
    activeSessionId: handle.activeSessionId(),
    pendingInputs: pendingCount(agentId),
    pid: handle.pid,
    tmuxSession: handle.tmuxSession,
    record: record.status === 'ok' ? record.record : undefined,
  }
}

/** Answer a pending permission request raised by an agent. */
export async function respondToPermission(
  agentId: AgentInstanceId,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const handle = getLiveAgent(agentId)
  assertCapability(handle, 'brokerPermissions')
  await handle.respondToPermission!(requestId, decision)
  await syncRecord(handle)
}

/** Clear all in-memory registry state. Test/reset helper. */
export function resetAgentManager(): void {
  for (const unregister of exitCleanups.values()) unregister()
  exitCleanups.clear()
  liveAgents.clear()
  pendingByAgent.clear()
  drainSubscription?.()
  drainSubscription = undefined
}
