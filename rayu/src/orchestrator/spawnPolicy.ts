/**
 * Which workers the Orchestrator may launch, checked by AgentTool before it spawns one.
 *
 * Governed: an agent that can write files (Edit, Write or NotebookEdit), launched by
 * the main thread in Orchestrator mode. Read-only agents (planner, Explore, a
 * verifier) are never held back. A governed worker must implement one packet of the
 * published contract, named by the Agent call's `name`, and:
 *   - the packets it depends on have completed;
 *   - no other worker of the same packet is running;
 *   - fewer than `orchestrator.maxParallelWriters` writers are running;
 * A packet worker always runs in the background (AgentTool starts it there whatever
 * `run_in_background` says), so the Orchestrator keeps coordinating and its status is
 * tracked; where background tasks are disabled a foreground worker is tracked directly.
 * Every refusal tells the Orchestrator what to do instead.
 */
import type { ToolUseContext } from '../Tool.js'
import { VERIFIER_AGENT_TYPE } from '../tools/AgentTool/constants.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { ORCHESTRATION_CONTRACT_TOOL_NAME } from '../tools/OrchestrationContractTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import type { ContractPacket } from './contract.js'
import { getActiveRun, type OrchestrationRun, type PacketRunState, workspaceTracking } from './runState.js'
import { renderWorkerBriefing } from './workerBriefing.js'

const FILE_WRITING_TOOLS = [FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME]

/** Whether an agent definition leaves it any file-writing tool. */
export function canWriteFiles(definition: Pick<AgentDefinition, 'tools' | 'disallowedTools'>): boolean {
  const denied = new Set(definition.disallowedTools ?? [])
  const allowsAll = !definition.tools || definition.tools.includes('*')
  return FILE_WRITING_TOOLS.some(tool => !denied.has(tool) && (allowsAll || (definition.tools ?? []).includes(tool)))
}

export type WorkerSpawnRequest = {
  agentDefinition: Pick<AgentDefinition, 'agentType' | 'tools' | 'disallowedTools'>
  name?: string
}

export type WorkerSpawnContext = Pick<ToolUseContext, 'agentId' | 'getAppState'> & {
  options: Pick<ToolUseContext['options'], 'tools' | 'agentDefinitions'>
}

export type WorkerSpawnGrant = {
  kind: 'packet'
  runId: string
  packet: ContractPacket
  /** The worktree base for a worktree packet; null runs it in the shared tree. */
  worktreeBase: string | null
  briefing: string
}

export type WorkerSpawnDecision = { kind: 'ungoverned' } | { kind: 'refused'; message: string } | WorkerSpawnGrant

const refuse = (message: string): WorkerSpawnDecision => ({ kind: 'refused', message })

function isGoverned(request: WorkerSpawnRequest, context: WorkerSpawnContext): boolean {
  if (context.agentId) return false
  if (context.getAppState().toolPermissionContext.mode !== 'orchestrator') return false
  return canWriteFiles(request.agentDefinition)
}

/**
 * The governed path is for implementation workers. A review or verification agent is
 * not a packet: point the Orchestrator at the exempt verifier when this session has it,
 * and at its own checks otherwise, so it does not invent a packet or republish the
 * contract to make room for a reviewer.
 */
function reviewHint(context: WorkerSpawnContext): string {
  const hasVerifier = context.options.agentDefinitions.activeAgents.some(agent => agent.agentType === VERIFIER_AGENT_TYPE)
  return hasVerifier
    ? ` If this agent reviews or verifies the result rather than implementing a packet, launch the \`${VERIFIER_AGENT_TYPE}\` agent instead (it serves no packet), or run the checks yourself.`
    : ' If this agent reviews or verifies the result rather than implementing a packet, run the checks yourself instead; a review is not a packet.'
}

function findPacket(run: OrchestrationRun, name: string | undefined, hint: string): { packet: ContractPacket; state: PacketRunState } | string {
  const names = run.current.contract.packets.map(packet => packet.name)
  if (!name) {
    return `Set \`name\` to the contract packet this worker implements (${names.join(', ')}). Implementation workers in Orchestrator mode each serve one packet.${hint}`
  }
  const packet = run.current.contract.packets.find(item => item.name === name)
  const state = run.packets.find(item => item.name === name)
  if (!packet || !state) {
    return `Contract v${run.current.version} has no packet named "${name}" (packets: ${names.join(', ')}). To add one, publish a new contract version with ${ORCHESTRATION_CONTRACT_TOOL_NAME}.${hint}`
  }
  return { packet, state }
}

function busyProblem(run: OrchestrationRun, packet: ContractPacket, state: PacketRunState, canMessage: boolean): string | null {
  if (state.status === 'running') {
    const worker = state.workerAgentIds.at(-1)
    const next = canMessage ? `send it more work with ${SEND_MESSAGE_TOOL_NAME} (to: "${packet.name}")` : 'wait for its completion notice'
    return `Packet "${packet.name}" already has a running worker${worker ? ` (${worker})` : ''}. Do not start a second one; ${next}.`
  }
  if (state.status === 'merging') {
    return `Packet "${packet.name}" is being merged from its worktree into the main tree. Wait for its completion notice.`
  }
  if (state.status === 'conflicted' && canMessage) {
    return `Packet "${packet.name}" has work in its worktree that conflicts with the main tree. A new worker would start without it; continue its worker with ${SEND_MESSAGE_TOOL_NAME} (to: "${packet.name}") to resolve the conflicts instead.`
  }
  const status = new Map(run.packets.map(item => [item.name, item.status]))
  const waiting = packet.dependsOn.filter(dependency => status.get(dependency) !== 'completed')
  if (waiting.length === 0) return null
  const detail = waiting.map(dependency => `${dependency} (${status.get(dependency) ?? 'unknown'})`).join(', ')
  return `Packet "${packet.name}" depends on ${detail}, which has not completed. Launch it after its dependencies finish.`
}

function capacityProblem(run: OrchestrationRun, maxParallelWriters: number): string | null {
  const running = run.packets.filter(packet => packet.status === 'running').map(packet => packet.name)
  if (running.length < maxParallelWriters) return null
  return `${running.length} workers are already writing (${running.join(', ')}); the limit is ${maxParallelWriters} (setting orchestrator.maxParallelWriters). Launch this packet when one of them finishes.`
}

/** Decide whether AgentTool may launch this worker, and with which briefing. */
export function decideWorkerSpawn(
  request: WorkerSpawnRequest,
  context: WorkerSpawnContext,
  limits: { maxParallelWriters: number },
): WorkerSpawnDecision {
  if (!isGoverned(request, context)) return { kind: 'ungoverned' }
  const run = getActiveRun(context.getAppState())
  if (!run) {
    return refuse(`Publish the run's contract with ${ORCHESTRATION_CONTRACT_TOOL_NAME} before launching implementation workers. Read-only agents such as the planner can run before it.`)
  }
  const found = findPacket(run, request.name, reviewHint(context))
  if (typeof found === 'string') return refuse(found)
  const canMessage = context.options.tools.some(tool => tool.name === SEND_MESSAGE_TOOL_NAME)
  const problem = busyProblem(run, found.packet, found.state, canMessage) ?? capacityProblem(run, limits.maxParallelWriters)
  if (problem) return refuse(problem)
  if (found.packet.isolation === 'worktree' && (!run.workspace.baseline || workspaceTracking(run.workspace) !== 'git')) {
    return refuse(`Packet "${found.packet.name}" runs in its own git worktree, which starts from the run's baseline snapshot, and this run has none. Publish the packet with isolation "shared", or fix the repository problem the contract result reported.`)
  }
  return {
    kind: 'packet',
    runId: run.runId,
    packet: found.packet,
    worktreeBase: found.packet.isolation === 'worktree' ? (run.workspace.baseline?.commit ?? null) : null,
    briefing: renderWorkerBriefing(run, found.packet),
  }
}
