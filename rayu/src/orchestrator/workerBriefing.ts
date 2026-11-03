/**
 * What an Orchestrator worker is told about the contract: the briefing that opens its
 * prompt, and the update it receives when the contract changes while it works.
 *
 * Workers cannot see the Orchestrator's conversation or each other. Before this, each
 * worker got whatever the Orchestrator chose to paste, and the pieces drifted apart
 * (one packet's `fullName` against another's `displayName`). The briefing is generated
 * from the published contract, so every worker reads the same definitions.
 *
 * The `Your packet: <name>` line is a stable marker: the end-to-end test harness and
 * the audit read it to tell which packet a worker serves.
 */
import type { AppState } from '../state/AppStateStore.js'
import type { ContractPacket, OrchestrationContract } from './contract.js'
import { packetOfWorker } from './packetProgress.js'
import type { OrchestrationRun } from './runState.js'
import { checksSection, interfacesSection, packetSection, waveIndexOf } from './statusReport.js'

/** Interfaces the packet owns, and the ones it uses, by name. */
function interfaceRoles(contract: OrchestrationContract, packet: ContractPacket): string[] {
  const owned = contract.sharedInterfaces.filter(item => item.owner === packet.name).map(item => item.name)
  const used = contract.sharedInterfaces.filter(item => item.consumers.includes(packet.name)).map(item => item.name)
  return [
    ...(owned.length ? [`- You write these shared interfaces: ${owned.join(', ')}. Write them exactly as defined below.`] : []),
    ...(used.length ? [`- You use these shared interfaces: ${used.join(', ')}. Code against the definitions below, even if the owner has not written them yet.`] : []),
  ]
}

function rules(contract: OrchestrationContract, packet: ContractPacket): string[] {
  return [
    '## Rules',
    '',
    `- Change only files your packet owns: ${packet.owns.map(pattern => `\`${pattern}\``).join(', ')}. Reading other files is fine.`,
    '- If the work needs a change outside those files, do not make it. Say exactly what is needed, and where, in your final report.',
    '- Use the shared interfaces exactly as defined: names, fields, types and signatures. Do not rename, extend or redefine them. If one is wrong or missing something, report it instead of working around it.',
    ...interfaceRoles(contract, packet),
    '- Before you finish, run the checks below that apply to your packet, when you can.',
  ]
}

const FINAL_REPORT = [
  '## Final report',
  '',
  'End with these sections:',
  '- Changed files: every file you created, changed or deleted.',
  '- Interfaces: the shared interfaces you wrote or used, and whether they match the contract.',
  '- Checks: the commands you ran and their results.',
  '- Open issues: anything outside your packet that is needed, and anything you could not verify.',
]

/** The text that opens a worker's prompt. */
export function renderWorkerBriefing(run: OrchestrationRun, packet: ContractPacket): string {
  const { contract, version } = run.current
  const lines = [
    `# Orchestration contract v${version} (${run.runId})`,
    '',
    `Your packet: ${packet.name}`,
    '',
    `You are one of several workers implementing this goal in parallel: ${contract.goal} The other workers cannot see your work while they run, so this contract is the only agreement between you.`,
    ...(contract.notes ? ['', `Notes: ${contract.notes}`] : []),
    '',
    '## Your packet',
    '',
    ...packetSection(packet, waveIndexOf(run.current).get(packet.name) ?? 0),
    '',
    ...rules(contract, packet),
    '',
    ...interfacesSection(contract),
    ...checksSection(contract),
    '',
    ...FINAL_REPORT,
    '',
    '---',
    '',
    'The Orchestrator\u2019s instructions for this packet:',
    '',
  ]
  return lines.join('\n')
}

/** Sent to a worker whose briefing is older than the current contract version. */
export function renderContractUpdate(run: OrchestrationRun, packet: ContractPacket): string {
  const { contract, version, reason } = run.current
  return [
    `The orchestration contract changed to v${version}${reason ? `: ${reason}` : ''}. Follow this version from now on.`,
    '',
    `Your packet: ${packet.name}`,
    '',
    ...packetSection(packet, waveIndexOf(run.current).get(packet.name) ?? 0),
    '',
    ...rules(contract, packet),
    '',
    ...interfacesSection(contract),
  ].join('\n').trimEnd()
}

/** The update `agentId` still needs, or null when it was briefed with the current version. */
export function contractUpdateFor(state: Pick<AppState, 'orchestration'>, agentId: string): string | null {
  const found = packetOfWorker(state, agentId)
  if (!found || found.packet.briefedVersion === found.run.current.version) return null
  const packet = found.run.current.contract.packets.find(item => item.name === found.packet.name)
  return packet ? renderContractUpdate(found.run, packet) : null
}

/** Running workers whose briefing is older than the current contract, with their update. */
export function staleRunningWorkers(run: OrchestrationRun): Array<{ packet: string; agentId: string; update: string }> {
  return run.packets.flatMap(state => {
    const agentId = state.workerAgentIds.at(-1)
    const packet = run.current.contract.packets.find(item => item.name === state.name)
    if (state.status !== 'running' || !agentId || !packet || state.briefedVersion === run.current.version) return []
    return [{ packet: state.name, agentId, update: renderContractUpdate(run, packet) }]
  })
}
