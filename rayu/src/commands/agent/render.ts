/**
 * Plain-text rendering for `/agent`.
 *
 * Kept separate from dispatch so the command file stays argument parsing plus
 * delegation. The discovery, workspace and conflict reports are NOT rendered
 * here — they already have formatters next to the data they describe
 * (`formatDiscoveryReport`, `formatWorkspaceReport`, `formatConflictReport`), so
 * a non-interactive caller and this command print identical text.
 */

import type { AgentInspection } from '../../externalAgents/core/AgentManager.js'
import type { AgentHandle } from '../../externalAgents/core/adapter.js'
import type { PendingApproval } from '../../externalAgents/permissions/permissionBroker.js'
import type { AgentFileChange } from '../../externalAgents/workspace/changeTracker.js'

/** Relative age, e.g. "3s ago". Kept terse for a table. */
function ago(atMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function formatAgentList(
  handles: readonly AgentHandle[],
  pendingFor: (handle: AgentHandle) => number,
): string {
  if (handles.length === 0) {
    return [
      'No external agents are connected to this session.',
      'Run /agent discover to see what is installed or already running.',
    ].join('\n')
  }

  const lines: string[] = []
  for (const handle of handles) {
    const status = handle.status()
    // All four axes, because collapsing them is exactly the confusion the
    // state model exists to prevent: a running process can be unreachable, and
    // a connected agent can be idle with a task still waiting on a provider.
    lines.push(
      `${handle.agentId}  ${status.agentState}  [process ${status.processState} / connection ${status.connectionState}]`,
    )
    const details: string[] = [
      `provider ${handle.provider}`,
      `${handle.adoption}, ${handle.durability}`,
    ]
    if (status.activeTurn) {
      details.push(`turn ${status.activeTurn.id} (${status.activeTurn.kind})`)
    }
    const pending = pendingFor(handle)
    if (pending > 0) details.push(`${pending} queued`)
    if (handle.pid !== undefined) details.push(`pid ${handle.pid}`)
    if (handle.tmuxSession) details.push(`tmux ${handle.tmuxSession}`)
    lines.push(`  ${details.join('  ·  ')}`)
    const session = handle.activeSessionId()
    if (session) lines.push(`  session: ${session}`)
  }
  return lines.join('\n')
}

export function formatInspection(inspection: AgentInspection): string {
  const lines: string[] = [
    `${inspection.agentId}  (${inspection.provider})`,
    `  adoption: ${inspection.adoption}   durability: ${inspection.durability}`,
    `  process: ${inspection.status.processState}   connection: ${inspection.status.connectionState}   agent: ${inspection.status.agentState}`,
  ]
  if (inspection.status.activeTurn) {
    lines.push(
      `  active turn: ${inspection.status.activeTurn.id} (${inspection.status.activeTurn.kind})`,
    )
  }
  if (inspection.activeSessionId) {
    lines.push(`  session: ${inspection.activeSessionId}`)
  }
  if (inspection.pid !== undefined) lines.push(`  pid: ${inspection.pid}`)
  if (inspection.tmuxSession) {
    lines.push(`  tmux session: ${inspection.tmuxSession}`)
  }
  if (inspection.pendingInputs > 0) {
    lines.push(`  queued inputs: ${inspection.pendingInputs}`)
  }

  lines.push('')
  lines.push('  capabilities')
  for (const [axis, level] of Object.entries(inspection.capabilities)) {
    lines.push(`    ${axis.padEnd(12)} ${level}`)
  }

  lines.push('')
  lines.push('  operations (declared capability AND implemented method)')
  for (const [operation, allowed] of Object.entries(inspection.operations)) {
    lines.push(`    ${allowed ? '\u2713' : '\u2717'} ${operation}`)
  }
  return lines.join('\n')
}

export function formatChangedFiles(
  agentId: string,
  files: readonly AgentFileChange[],
  overflowCount: number,
): string {
  if (files.length === 0) {
    return `${agentId} has not reported any file changes.`
  }
  const lines: string[] = [
    `${agentId} touched ${files.length} file${files.length === 1 ? '' : 's'}:`,
  ]
  for (const file of files) {
    const repeats = file.count > 1 ? ` (${file.count} edits)` : ''
    const diff = file.hasDiff ? ' [diff available]' : ''
    lines.push(
      `  ${file.change.padEnd(9)} ${file.displayPath}${repeats}${diff}  ${ago(file.lastSeenMs)}`,
    )
  }
  if (overflowCount > 0) {
    lines.push('')
    lines.push(
      `  ${overflowCount} further path${overflowCount === 1 ? '' : 's'} were not tracked (per-agent limit reached), so this list is partial.`,
    )
  }
  return lines.join('\n')
}

export function formatApprovals(
  approvals: readonly PendingApproval[],
): string {
  if (approvals.length === 0) {
    return 'No external agent is waiting for approval.'
  }
  const lines: string[] = [
    `${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}:`,
  ]
  for (const approval of approvals) {
    lines.push(`  ${approval.agentId}  ${approval.kind}  ${ago(approval.askedAtMs)}`)
    lines.push(`    ${approval.description}`)
    if (approval.cwd) lines.push(`    in ${approval.cwd}`)
  }
  lines.push('')
  lines.push(
    'Run /agent approvals --show to bring the prompts back on screen.',
  )
  return lines.join('\n')
}

export const AGENT_USAGE = [
  'Usage: /agent <subcommand>',
  '',
  '  list                       agents connected to this session (default)',
  '  discover                   what is installed or already running, and what RAYU can do with it',
  '  start <provider>           launch an agent   [--cwd <path>] [--model <m>] [--worktree] [--exclusive]',
  '  adopt <provider>           attach to an agent already running outside RAYU',
  '  reconnect <agentId>        re-attach to a process-durable agent',
  '  send <agentId> <text>      give the agent work',
  '  steer <agentId> <text>     inject into the running turn when the agent supports it',
  '  interrupt <agentId>        cancel the current turn',
  '  stop <agentId>             stop the agent   [--remove-worktree]',
  '  inspect <agentId>          four-axis state and the honest capability matrix',
  '  attach <agentId>           open the agent\u2019s live terminal (needs tmux)',
  '  approvals [--show]         approvals waiting on you',
  '  workspaces                 where each agent is running',
  '  conflicts                  files changed by more than one agent',
  '  files <agentId>            what one agent changed',
  '  recover [agentId]          agents left by a previous session; naming one reconnects or relaunches it',
].join('\n')
