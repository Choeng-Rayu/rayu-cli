/**
 * Orchestrator text for people and models: the contract as workers read it, and the
 * run status `/orchestrator-status` prints. Plain text and Markdown only, so the CLI,
 * Rayucode and the audit files show the same thing.
 */
import type { ContractPacket, OrchestrationContract } from './contract.js'
import { problemLines } from './packetProgress.js'
import { type ContractVersion, type OrchestrationRun, type PacketRunState, workspaceRoot, workspaceTracking } from './runState.js'

export function packetSection(packet: ContractPacket, waveIndex: number): string[] {
  return [
    `### ${packet.name}${packet.isolation === 'worktree' ? ' (own worktree)' : ''}`,
    `- Objective: ${packet.objective}`,
    `- Owns: ${packet.owns.map(pattern => `\`${pattern}\``).join(', ')}`,
    `- Starts in wave ${waveIndex + 1}${packet.dependsOn.length ? `, after ${packet.dependsOn.join(', ')}` : ''}`,
    ...(packet.riskReason ? [`- Why a worktree: ${packet.riskReason}`] : []),
    '- Done when:',
    ...packet.acceptance.map(item => `  - ${item}`),
  ]
}

export function interfacesSection(contract: OrchestrationContract): string[] {
  if (contract.sharedInterfaces.length === 0) return []
  const lines = ['## Shared interfaces', '', 'Use these exactly. Only the owner writes them; consumers code against the definition.', '']
  for (const item of contract.sharedInterfaces) {
    const consumers = item.consumers.length ? `; used by ${item.consumers.join(', ')}` : ''
    lines.push(`### ${item.name} (owner: ${item.owner}, in \`${item.path}\`${consumers})`, '', '```', item.definition, '```', '')
  }
  return lines
}

export function checksSection(contract: OrchestrationContract): string[] {
  return [
    '## Checks',
    '',
    ...contract.checks.map(check => `- ${check.required ? 'Required' : 'Optional'}: ${check.name}: \`${check.command}\`${check.source === 'settings' ? ' (from settings)' : ''}`),
  ]
}

/** The wave (0-based) each packet starts in. */
export function waveIndexOf(version: ContractVersion): Map<string, number> {
  return new Map(version.waves.flatMap((names, index) => names.map(name => [name, index] as const)))
}

/** The contract as Markdown: the form workers receive and the audit keeps. */
export function renderContractMarkdown(version: ContractVersion): string {
  const { contract, waves } = version
  const waveOf = waveIndexOf(version)
  const lines = [
    `# Orchestration contract v${version.version}`,
    '',
    `Goal: ${contract.goal}`,
    ...(version.reason ? ['', `Changed in this version: ${version.reason}`] : []),
    ...(contract.notes ? ['', `Notes: ${contract.notes}`] : []),
    '',
    '## Order',
    '',
    ...waves.map((names, index) => `${index + 1}. ${names.join(', ')}`),
    '',
    '## Packets',
    '',
  ]
  for (const packet of contract.packets) lines.push(...packetSection(packet, waveOf.get(packet.name) ?? 0), '')
  lines.push(...interfacesSection(contract), ...checksSection(contract))
  return `${lines.join('\n').trimEnd()}\n`
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function packetLine(packet: PacketRunState, contractPacket: ContractPacket | undefined): string {
  const workers = packet.workerAgentIds.length ? `  workers: ${packet.workerAgentIds.join(', ')}` : ''
  const owns = contractPacket ? `  owns ${contractPacket.owns.join(', ')}` : ''
  return `  ${packet.name.padEnd(20)} ${packet.status.padEnd(10)}${owns}${workers}${worktreeText(packet)}`
}

function worktreeText(packet: PacketRunState): string {
  const worktree = packet.worktree
  if (!worktree) return ''
  if (worktree.state === 'merged') return `  worktree merged (${worktree.mergedFiles ?? 0} files)`
  const failed = worktree.failedAttempts ? `, ${worktree.failedAttempts} failed merge${worktree.failedAttempts === 1 ? '' : 's'}` : ''
  return `  worktree ${worktree.path}${failed}`
}

/** The latest verification and the gate's last word. */
/** The project root contract paths are relative to, and how changes are tracked. */
function trackingLines(run: OrchestrationRun): string[] {
  const root = workspaceRoot(run.workspace)
  const tracking = workspaceTracking(run.workspace)
  const how = {
    git: `git snapshots (baseline ${run.workspace.baseline?.commit.slice(0, 12) ?? 'none'})`,
    files: 'file sizes and modification times (the project is not in git; worktree packets are unavailable)',
    none: 'none: no baseline could be taken, so changes made outside the workers\' tools are not detected. File edits are still checked against their packets',
  }[tracking]
  return [...(root ? [`Project root: ${root} (contract paths are relative to it)`] : []), `Change tracking: ${how}`]
}

function verificationSection(run: OrchestrationRun): string[] {
  const latest = run.verifications?.at(-1)
  const verification = !latest
    ? 'Verification: none yet'
    : `Verification ${latest.id}: ${latest.verdict ?? 'no verdict'}, ${latest.accepted ? 'accepted' : `NOT accepted${latest.findings[0] ? ` (${latest.findings[0]})` : ''}`}${latest.accepted && latest.warnings?.length ? ` (${latest.warnings.length} note${latest.warnings.length === 1 ? '' : 's'})` : ''}`
  const gate = run.gate
    ? ['Gate: closed', ...run.gate.key.split('\n').map(reason => `  - ${reason}`)]
    : [`Gate: ${latest?.accepted ? 'open' : 'not checked yet'}`]
  return [verification, ...gate, '']
}

export type StatusReportInput = {
  run: OrchestrationRun | null
  orchestratorModeOn: boolean
}

function problemSection(run: OrchestrationRun): string[] {
  const problems = run.problems ?? []
  const open = problems.filter(problem => problem.status === 'open')
  const closed = problems.length - open.length
  if (problems.length === 0) return ['Contract problems: none', '']
  return [
    ...(open.length ? problemLines(open) : ['Contract problems: none open']),
    ...(closed ? [`(${closed} resolved or accepted; see the audit history)`] : []),
    ...open.filter(problem => problem.diffFile).map(problem => `  ${problem.id} diff: /orchestrator-status diff ${problem.id}`),
    '',
  ]
}

/** What `/orchestrator-status` prints. */
export function formatRunStatus({ run, orchestratorModeOn }: StatusReportInput): string {
  const mode = `Orchestrator mode is ${orchestratorModeOn ? 'on' : 'off'}.`
  if (!run) {
    return `${mode}\nNo Orchestrator run in this session yet. A run starts when the Orchestrator publishes its contract (the OrchestrationContract tool).`
  }
  const { contract, waves, version, publishedAt } = run.current
  const byName = new Map(contract.packets.map(packet => [packet.name, packet]))
  const lines = [
    mode,
    `Run ${run.runId} (${run.status}${run.archivedAt ? ` ${formatTime(run.archivedAt)}` : ''}), started ${formatTime(run.startedAt)}`,
    `Contract v${version}, published ${formatTime(publishedAt)}${run.current.reason ? `: ${run.current.reason}` : ''}`,
    `Goal: ${contract.goal}`,
    '',
    'Order:',
    ...waves.map((names, index) => `  ${index + 1}. ${names.join(', ')}`),
    '',
    'Packets:',
    ...run.packets.map(packet => packetLine(packet, byName.get(packet.name))),
    '',
    'Required checks:',
    ...contract.checks.filter(check => check.required).map(check => `  ${check.name}: ${check.command}`),
    '',
    ...problemSection(run),
    ...verificationSection(run),
    `Audit history: ${run.auditDir ?? 'not written (the directory could not be created)'}`,
    ...trackingLines(run),
    'Full contract: /orchestrator-status contract',
  ]
  return lines.join('\n')
}
