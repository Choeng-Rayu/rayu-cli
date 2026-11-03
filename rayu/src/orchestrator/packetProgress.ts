/**
 * Which worker serves which contract packet, and how far each packet has got.
 *
 * A packet's status follows its LATEST worker's task: AgentTool assigns the worker
 * when it launches it, and the task transitions (LocalAgentTask: register, complete,
 * fail, kill) report back here. The status is stored on the packet rather than read
 * from the task, because finished tasks are evicted from AppState once their
 * notification has been delivered, and a dependent packet is usually launched after
 * that.
 *
 * Imports from runState.ts only (itself free of runtime imports), so the task module
 * can call this without loading the orchestrator's contract or git code.
 */
import type { AppState } from '../state/AppStateStore.js'
import {
  openProblems,
  type OrchestrationProblem,
  type OrchestrationRun,
  type OrchestrationState,
  type PacketRunState,
  type PacketStatus,
  type PacketWorktree,
} from './runState.js'

type SetAppState = (update: (prev: AppState) => AppState) => void

export type WorkerTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

const PACKET_STATUS_BY_TASK: Readonly<Record<WorkerTaskStatus, PacketStatus>> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
}

function mapActivePackets(
  state: OrchestrationState,
  update: (packet: PacketRunState, run: OrchestrationRun) => PacketRunState,
): OrchestrationState {
  const run = state.run
  if (!run || run.status !== 'active') return state
  let changed = false
  const packets = run.packets.map(packet => {
    const next = update(packet, run)
    if (next !== packet) changed = true
    return next
  })
  return changed ? { ...state, run: { ...run, packets } } : state
}

/** The packet with a new latest worker, briefed with the run's current contract. */
export function withPacketWorker(state: OrchestrationState, packetName: string, agentId: string): OrchestrationState {
  return mapActivePackets(state, (packet, run) =>
    packet.name === packetName
      ? {
          ...packet,
          status: 'running',
          workerAgentIds: [...packet.workerAgentIds.filter(id => id !== agentId), agentId],
          briefedVersion: run.current.version,
        }
      : packet,
  )
}

/**
 * The packet status after its latest worker's task reached `taskStatus`. A worktree
 * packet with unmerged changes is `merging` when its worker completes, until
 * worktreeIntegration.ts settles it as `completed` or `conflicted`.
 */
function nextPacketStatus(packet: PacketRunState, taskStatus: WorkerTaskStatus): PacketStatus {
  const status = PACKET_STATUS_BY_TASK[taskStatus]
  if (taskStatus !== 'completed' || packet.worktree?.state !== 'open') return status
  // Only a running worker starts a merge; a settled merge is not reopened by a late report.
  return packet.status === 'running' ? 'merging' : packet.status
}

/** The state after `agentId`'s task reached `taskStatus`; unchanged if it serves no packet. */
export function withWorkerStatus(state: OrchestrationState, agentId: string, taskStatus: WorkerTaskStatus): OrchestrationState {
  return mapActivePackets(state, packet => {
    if (packet.workerAgentIds.at(-1) !== agentId) return packet
    const status = nextPacketStatus(packet, taskStatus)
    return packet.status === status ? packet : { ...packet, status }
  })
}

/** The state with `worktree` recorded for the packet whose latest worker is `agentId`. */
export function withPacketWorktree(state: OrchestrationState, agentId: string, worktree: PacketWorktree): OrchestrationState {
  return mapActivePackets(state, packet => (packet.workerAgentIds.at(-1) === agentId ? { ...packet, worktree } : packet))
}

export function recordPacketWorktree(agentId: string, worktree: PacketWorktree, setAppState: SetAppState): void {
  applyOrchestration(setAppState, state => withPacketWorktree(state, agentId, worktree))
}

/** The state after `agentId` was sent the current contract version. */
export function withWorkerBriefed(state: OrchestrationState, agentId: string): OrchestrationState {
  return mapActivePackets(state, (packet, run) =>
    packet.workerAgentIds.at(-1) === agentId && packet.briefedVersion !== run.current.version
      ? { ...packet, briefedVersion: run.current.version }
      : packet,
  )
}

function applyOrchestration(setAppState: SetAppState, update: (state: OrchestrationState) => OrchestrationState): void {
  setAppState(prev => {
    const next = update(prev.orchestration)
    return next === prev.orchestration ? prev : { ...prev, orchestration: next }
  })
}

export function assignPacketWorker(packetName: string, agentId: string, setAppState: SetAppState): void {
  applyOrchestration(setAppState, state => withPacketWorker(state, packetName, agentId))
}

/** Undo a claim whose worker never started: the packet gets its previous status back. */
export function withoutPacketWorker(
  state: OrchestrationState,
  packetName: string,
  agentId: string,
  previous: PacketStatus,
): OrchestrationState {
  return mapActivePackets(state, packet =>
    packet.name === packetName && packet.workerAgentIds.at(-1) === agentId
      ? { ...packet, status: previous, workerAgentIds: packet.workerAgentIds.slice(0, -1) }
      : packet,
  )
}

export function releasePacketWorker(packetName: string, agentId: string, previous: PacketStatus, setAppState: SetAppState): void {
  applyOrchestration(setAppState, state => withoutPacketWorker(state, packetName, agentId, previous))
}

/**
 * Settle a foreground packet worker when its Agent call ends. A call that returns
 * `async_launched` was moved to the background; its task reports the outcome later.
 * `afterCompleted` runs once the completion is recorded (a worktree packet's merge);
 * text it returns is added to the result the Orchestrator reads.
 */
export async function settleForegroundPacket<T extends { data: unknown }>(
  run: Promise<T>,
  agentId: string,
  setAppState: SetAppState,
  afterCompleted?: () => Promise<string | null>,
): Promise<T> {
  let result: T
  try {
    result = await run
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    recordWorkerStatus(agentId, aborted ? 'killed' : 'failed', setAppState)
    throw error
  }
  const status = (result.data as { status?: unknown } | null)?.status
  if (status === 'async_launched') return result
  recordWorkerStatus(agentId, 'completed', setAppState)
  const text = afterCompleted ? await afterCompleted() : null
  return text ? withAppendedContent(result, text) : result
}

function withAppendedContent<T extends { data: unknown }>(result: T, text: string): T {
  const data = result.data as { content?: unknown } | null
  if (!data || !Array.isArray(data.content)) return result
  return { ...result, data: { ...data, content: [...data.content, { type: 'text', text }] } }
}

/** Called by LocalAgentTask on every status transition. A no-op outside Orchestrator runs. */
export function recordWorkerStatus(agentId: string, taskStatus: WorkerTaskStatus, setAppState: SetAppState): void {
  applyOrchestration(setAppState, state => withWorkerStatus(state, agentId, taskStatus))
}

export function recordWorkerBriefed(agentId: string, setAppState: SetAppState): void {
  applyOrchestration(setAppState, state => withWorkerBriefed(state, agentId))
}

/** The active run's packet whose latest worker is `agentId`. */
export function packetOfWorker(state: Pick<AppState, 'orchestration'>, agentId: string): { run: OrchestrationRun; packet: PacketRunState } | null {
  const run = state.orchestration.run
  if (!run || run.status !== 'active') return null
  const packet = run.packets.find(item => item.workerAgentIds.at(-1) === agentId)
  return packet ? { run, packet } : null
}

/** Packets whose dependencies have all completed and that have not started. */
export function readyPackets(run: OrchestrationRun): string[] {
  const status = new Map(run.packets.map(packet => [packet.name, packet.status]))
  return run.current.contract.packets
    .filter(packet => status.get(packet.name) === 'pending')
    .filter(packet => packet.dependsOn.every(dependency => status.get(dependency) === 'completed'))
    .map(packet => packet.name)
}

/**
 * The `<orchestration>` block added to a worker's completion notice: which packet it
 * served, and what the Orchestrator can do next. Null for workers outside a run.
 */
export function orchestrationNotice(state: Pick<AppState, 'orchestration'>, agentId: string): string | null {
  const found = packetOfWorker(state, agentId)
  if (!found) return null
  const { run, packet } = found
  const running = run.packets.filter(item => item.status === 'running').map(item => item.name)
  const ready = readyPackets(run)
  const problems = openProblems(run, packet.name)
  const lines = [
    `Packet "${packet.name}" of ${run.runId} (contract v${run.current.version}) is now ${packet.status}.`,
    ...worktreeLines(packet),
    ...problemLines(problems),
    ready.length ? `Packets that can start now: ${ready.join(', ')}.` : null,
    running.length ? `Still running: ${running.join(', ')}.` : null,
    nextStep(packet),
  ].filter((line): line is string => line !== null)
  return `<orchestration>\n${lines.join('\n')}\n</orchestration>`
}

function nextStep(packet: PacketRunState): string {
  switch (packet.status) {
    case 'completed':
      return 'Check its final report against the contract before you build on it.'
    case 'conflicted':
      return `Its dependents wait until the merge succeeds. Continue this worker with SendMessage (to: "${packet.name}") to resolve the conflicts in its worktree; the merge is tried again when it finishes.`
    case 'merging':
      return 'Wait for the merge to finish before you build on it.'
    default:
      return 'Launch a new worker for this packet, or change the contract, before its dependents can start.'
  }
}

/** What happened to a worktree packet's changes. */
export function worktreeLines(packet: PacketRunState): string[] {
  const worktree = packet.worktree
  if (!worktree) return []
  if (worktree.state === 'merged') {
    const files = worktree.mergedFiles ?? 0
    if (files === 0) return ['Its worktree had no changes to merge into the main tree.']
    return [`Its worktree changes were merged into the main tree (${files} file${files === 1 ? '' : 's'}).`]
  }
  if (packet.status === 'conflicted') {
    return [
      `Its worktree changes were NOT merged: they conflict with the main tree (attempt ${worktree.failedAttempts}).`,
      ...worktree.conflicts.map(conflict => `- ${conflict.path}: ${conflict.reason}`),
      `The worktree at ${worktree.path} now also holds the main tree's other changes, with conflict markers in the files where both sides changed the same lines.`,
    ]
  }
  if (packet.status === 'failed' || packet.status === 'stopped') {
    return [`Its changes stay in its worktree at ${worktree.path}; they were not merged into the main tree.`]
  }
  return []
}

/**
 * How the user accepts these problems, with real ids: a placeholder such as `<id>` is
 * read as a tag and dropped from the text, which left "accept )" on screen.
 */
export function acceptHint(problems: readonly OrchestrationProblem[]): string {
  const ids = problems.map(problem => problem.id)
  return `/orchestrator-status accept ${ids[0] ?? 'p1'}${ids.length > 1 ? `, and likewise for ${ids.slice(1).join(', ')}` : ''}`
}

/** Open contract problems, one line each, with what settles them. */
export function problemLines(problems: readonly OrchestrationProblem[]): string[] {
  if (problems.length === 0) return []
  return [
    `Contract problems (${problems.length} open):`,
    ...problems.map(problem => `- ${problem.id} ${describeProblem(problem)}`),
    `Each stays open until the change is undone, a new contract version gives the file to the packet, or the user accepts it (${acceptHint(problems)}).`,
  ]
}

export function describeProblem(problem: OrchestrationProblem): string {
  const who = problem.packet ? `packet ${problem.packet}` : 'an unknown worker'
  switch (problem.kind) {
    case 'outside-packet':
      return `${who} changed ${problem.path}, which belongs to ${problem.owners.join(', ')}`
    case 'unowned':
      return `${who} changed ${problem.path}, which no packet owns`
    case 'overlap':
      return `${who} and ${problem.with?.join(', ')} both changed ${problem.path} while able to run at the same time`
    case 'untraced':
      return `${problem.path} changed, and no worker's tools account for it${problem.with?.length ? ` (commands of ${problem.with.join(', ')} ran at the same time)` : ''}`
    case 'interrupted':
      return `${who} ended before finishing, after changing ${problem.path}; those changes may be incomplete`
    case 'merge-conflict':
      return `${who}'s worktree changes to ${problem.path} could not be merged into the main tree${problem.detail ? ` (${problem.detail})` : ''}`
    case 'verifier-change':
      return `${problem.path} changed while the verifier ran; the verifier must not change project files`
  }
}
