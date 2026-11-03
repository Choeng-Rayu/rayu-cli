/**
 * Checkpoints: compare the whole working tree with the run's baseline whenever every
 * worker has stopped, so nothing that changed during the run goes unexamined.
 *
 * Taken at the start of an Orchestrator turn (attachments.ts) when no packet is running,
 * no worker command is in flight, and a packet finished since the last checkpoint. Each
 * path that differs from the baseline is either explained by a worker's recorded
 * changes, or raised as `untraced`: the user, a background command, or a tool that is
 * not checked changed it, and nothing may silently count as a worker's work. A worker
 * that failed or was stopped after changing files is raised as `interrupted`. Open
 * problems whose file is back to its baseline content are closed: the change was undone.
 *
 * The result goes to the Orchestrator as an `orchestrator_checkpoint` attachment and into
 * the audit history.
 */
import { isAbsolute, join } from 'path'
import type { ToolUseContext } from '../Tool.js'
import { logError } from '../utils/log.js'
import { appendAuditEvent } from './audit.js'
import { type AttributionContext, auditClosedProblems, ledgerExplains, ledgerFileCounts, raiseRunProblem } from './attribution.js'
import { ownersOf } from './contract.js'
import { defaultCaseInsensitivePaths } from './ownership.js'
import { describeProblem } from './packetProgress.js'
import {
  getActiveRun,
  type OrchestrationProblem,
  type OrchestrationRun,
  openProblems,
  updateActiveRun,
  workspaceRoot,
  workspaceTracking,
} from './runState.js'
import { hasRunningCommands } from './shellChanges.js'
import { changedPaths, snapshotTree } from './treeTracker.js'

const LISTED_CHANGES = 20

export type CheckpointSummary = {
  runId: string
  label: string
  commit: string
  changed: Array<{ path: string; packets: string[] }>
  raised: string[]
  closed: string[]
  open: string[]
}

/** What distinguishes this moment: every packet's status and latest worker. */
export function checkpointKey(run: OrchestrationRun): string {
  return run.packets.map(packet => `${packet.name}:${packet.status}:${packet.workerAgentIds.at(-1) ?? ''}`).join('|')
}

/** Whether a checkpoint is due now. */
export function checkpointDue(run: OrchestrationRun): boolean {
  if (!run.workspace.baseline || !workspaceRoot(run.workspace) || workspaceTracking(run.workspace) === 'none') return false
  // A merge writes into the main tree; compare only once it has finished.
  if (run.packets.some(packet => packet.status === 'running' || packet.status === 'merging') || hasRunningCommands(run.runId)) return false
  if (!run.packets.some(packet => packet.workerAgentIds.length > 0)) return false
  return run.lastCheckpoint?.key !== checkpointKey(run)
}

function updateRun(context: AttributionContext, runId: string, update: (run: OrchestrationRun) => OrchestrationRun): void {
  updateActiveRun(context.setAppStateForTasks ?? context.setAppState, runId, update)
}

/** Raise every changed path that no worker's recorded changes explain. */
function raiseUntraced(context: AttributionContext, run: OrchestrationRun, root: string, changes: readonly string[]): string[] {
  const raised: string[] = []
  for (const path of changes) {
    if (ledgerExplains(run.runId, join(root, path)).length > 0) continue
    const added = raiseRunProblem(context, run, {
      kind: 'untraced',
      path,
      packet: null,
      agentId: null,
      owners: ownersOf(run.current.contract, path, defaultCaseInsensitivePaths()),
      tool: 'checkpoint',
      at: Date.now(),
    })
    if (added) raised.push(added.id)
  }
  return raised
}

/** Workers that ended without finishing after changing files. */
function raiseInterrupted(context: AttributionContext, run: OrchestrationRun): string[] {
  const counts = ledgerFileCounts(run.runId)
  const raised: string[] = []
  for (const packet of run.packets) {
    if (packet.status !== 'failed' && packet.status !== 'stopped') continue
    const files = counts.get(packet.name) ?? 0
    if (files === 0) continue
    const added = raiseRunProblem(context, run, {
      kind: 'interrupted',
      path: `${files} file${files === 1 ? '' : 's'}`,
      packet: packet.name,
      agentId: packet.workerAgentIds.at(-1) ?? null,
      owners: [packet.name],
      tool: 'checkpoint',
      at: Date.now(),
    })
    if (added) raised.push(added.id)
  }
  return raised
}

/** Open problems about a file that now matches the baseline again: the change was undone. */
export function closeUndone(run: OrchestrationRun, changedPaths: ReadonlySet<string>): { run: OrchestrationRun; closed: OrchestrationProblem[] } {
  const closed: OrchestrationProblem[] = []
  const caseInsensitive = defaultCaseInsensitivePaths()
  const key = (path: string) => (caseInsensitive ? path.toLowerCase() : path)
  const changed = new Set([...changedPaths].map(key))
  const problems = run.problems.map(problem => {
    const fileProblem =
      problem.kind === 'outside-packet' || problem.kind === 'unowned' || problem.kind === 'untraced' || problem.kind === 'verifier-change'
    // A path outside the repository never appears in the tree diff; it cannot be checked.
    if (problem.status !== 'open' || !fileProblem || isAbsolute(problem.path) || changed.has(key(problem.path))) return problem
    const done: OrchestrationProblem = { ...problem, status: 'resolved', resolution: 'The change was undone: the file matches the baseline again.' }
    closed.push(done)
    return done
  })
  return closed.length ? { run: { ...run, problems }, closed } : { run, closed }
}

/** Take a checkpoint if one is due. Returns its summary for the Orchestrator, or null. */
export async function takeCheckpointIfDue(context: Pick<ToolUseContext, 'agentId' | 'getAppState' | 'setAppState' | 'setAppStateForTasks'>): Promise<CheckpointSummary | null> {
  if (context.agentId) return null
  const state = context.getAppState()
  if (state.toolPermissionContext.mode !== 'orchestrator') return null
  const run = getActiveRun(state)
  if (!run || !checkpointDue(run)) return null
  try {
    return await takeCheckpoint(context, run)
  } catch (error) {
    logError(error)
    return null
  }
}

async function takeCheckpoint(context: AttributionContext, run: OrchestrationRun): Promise<CheckpointSummary | null> {
  const root = workspaceRoot(run.workspace)!
  const baseline = run.workspace.baseline!
  const label = `checkpoint-${(run.lastCheckpoint ? Number(run.lastCheckpoint.label.split('-')[1]) : 0) + 1}`
  const snapshot = await snapshotTree(run.workspace, label)
  const changes = snapshot ? await changedPaths(run.workspace, baseline.commit, snapshot.commit) : null
  // A snapshot or comparison that could not be made is not a checkpoint: nothing is
  // reported as changed or unchanged, and the next turn tries again.
  if (!snapshot || !changes) return null
  const raised = [...raiseUntraced(context, run, root, changes), ...raiseInterrupted(context, run)]
  const closedHolder: { closed: OrchestrationProblem[] } = { closed: [] }
  updateRun(context, run.runId, current => {
    const settled = closeUndone(current, new Set(changes))
    closedHolder.closed = settled.closed
    return { ...settled.run, lastCheckpoint: { label, commit: snapshot.commit, at: Date.now(), key: checkpointKey(current) } }
  })
  const after = getActiveRun(context.getAppState()) ?? run
  const summary: CheckpointSummary = {
    runId: run.runId,
    label,
    commit: snapshot.commit,
    changed: changes.map(path => ({ path, packets: ledgerExplains(run.runId, join(root, path)) })),
    raised,
    closed: closedHolder.closed.map(problem => problem.id),
    open: openProblems(after).map(problem => `${problem.id} ${describeProblem(problem)}`),
  }
  await recordCheckpoint(after, summary, closedHolder.closed)
  return summary
}

async function recordCheckpoint(run: OrchestrationRun, summary: CheckpointSummary, closed: readonly OrchestrationProblem[]): Promise<void> {
  if (!run.auditDir) return
  await appendAuditEvent(run.auditDir, {
    type: 'checkpoint',
    label: summary.label,
    commit: summary.commit,
    changed: summary.changed.length,
    raised: summary.raised,
  }).catch(logError)
  await auditClosedProblems(run, closed).catch(logError)
}

/** The checkpoint as the Orchestrator reads it. */
export function renderCheckpoint(summary: CheckpointSummary): string {
  const listed = summary.changed.slice(0, LISTED_CHANGES).map(change => `- ${change.path} (${change.packets.length ? change.packets.join(', ') : 'no worker'})`)
  const more = summary.changed.length > LISTED_CHANGES ? [`- ...and ${summary.changed.length - LISTED_CHANGES} more`] : []
  return [
    `## Orchestrator checkpoint (${summary.runId}, ${summary.label})`,
    '',
    'No worker is running. Compared with the baseline taken when the contract was first published:',
    `${summary.changed.length} file${summary.changed.length === 1 ? '' : 's'} changed.`,
    ...listed,
    ...more,
    ...(summary.closed.length ? ['', `Settled because the change was undone: ${summary.closed.join(', ')}.`] : []),
    '',
    summary.open.length ? `Open contract problems (${summary.open.length}):` : 'No open contract problems.',
    ...summary.open.map(problem => `- ${problem}`),
    ...(summary.open.length
      ? ['Settle each before you report success: have the owning worker fix or undo it, publish a contract version that covers it, or ask the user to accept it (/orchestrator-status accept PROBLEM_ID, with the id from the list above).']
      : []),
  ].join('\n')
}
